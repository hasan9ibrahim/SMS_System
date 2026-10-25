defmodule SmppSim.Smsc.Conn do
  @moduledoc """
  One connection from the switch to a fake vendor SMSC (`SmppSim.Smsc`): answers binds, `enquire_link`, `unbind` and
  `submit_sm` as the current config says, gives each accepted submit a unique message id (hexadecimal) and asks
  `SmppSim.Smsc.Dlr` for its receipt. Answers produced by one read are written in one go.
  """
  use GenServer, restart: :temporary
  require Logger
  import Bitwise
  alias Sms.Switch.Smpp.Pdu
  alias SmppSim.{Smsc, Stats}
  alias SmppSim.Smsc.Dlr

  @registry SmppSim.SmscRegistry

  @spec start(port()) :: GenServer.on_start()
  def start(socket), do: GenServer.start(__MODULE__, socket)

  @doc "Closes the connection without an unbind."
  @spec drop(pid()) :: :ok
  def drop(pid), do: send(pid, :drop) && :ok

  @doc """
  Sends a receipt (`deliver_sm` fields and TLVs) to the switch on this connection; `item` goes back to
  `SmppSim.Smsc.Dlr` to be sent again if the switch answers it with an error.
  """
  @spec deliver(pid(), map(), list(), tuple()) :: :ok
  def deliver(pid, fields, tlvs, item), do: send(pid, {:deliver, fields, tlvs, item}) && :ok

  @impl true
  def init(socket), do: {:ok, %{socket: socket, buffer: <<>>, seq: 1, system_id: nil, receipts: %{}}}

  @impl true
  def handle_info(:go, state) do
    :ok = :inet.setopts(state.socket, active: 100, sndbuf: 1 <<< 20, recbuf: 1 <<< 20)
    {:noreply, state}
  end

  def handle_info({:tcp, _socket, data}, state), do: {:noreply, drain(%{state | buffer: state.buffer <> data})}

  def handle_info({:tcp_passive, socket}, state) do
    :ok = :inet.setopts(socket, active: 100)
    {:noreply, state}
  end

  def handle_info({:tcp_closed, _}, state), do: closed(state)
  def handle_info({:tcp_error, _, _}, state), do: closed(state)

  def handle_info(:drop, state) do
    :gen_tcp.close(state.socket)
    closed(state)
  end

  def handle_info({:send, bytes}, state) do
    _ = :gen_tcp.send(state.socket, bytes)
    {:noreply, state}
  end

  def handle_info({:deliver, fields, tlvs, item}, state) do
    bytes = Pdu.encode!(Pdu.new(:deliver_sm, fields, sequence: state.seq, tlvs: tlvs))
    _ = :gen_tcp.send(state.socket, bytes)
    Stats.incr(:smsc_receipts)
    {:noreply, %{state | seq: next_seq(state.seq), receipts: Map.put(state.receipts, state.seq, item)}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # Receipts not answered yet are sent again on another connection, as an SMSC does when a connection drops.
  defp closed(state) do
    Stats.incr(:smsc_disconnects)
    for {_seq, item} <- state.receipts, do: Dlr.retry(item)
    {:stop, :normal, state}
  end

  defp next_seq(seq) when seq >= 0x7FFFFFFF, do: 1
  defp next_seq(seq), do: seq + 1

  defp drain(state) do
    {out, state} = drain(state, [])
    if out != [], do: _ = :gen_tcp.send(state.socket, out)
    state
  end

  defp drain(state, out) do
    case Pdu.decode(state.buffer) do
      {:ok, pdu, rest} ->
        {reply, state} = answer(pdu, %{state | buffer: rest})
        drain(state, if(reply, do: [out | reply], else: out))

      {:incomplete, _} ->
        {out, state}

      {:error, error, rest} ->
        Logger.warning("fake SMSC: bad PDU from the switch: #{Exception.message(error)}")
        reply = Pdu.error_reply(error)
        drain(%{state | buffer: rest}, if(reply, do: [out | Pdu.encode!(reply)], else: out))
    end
  end

  defp answer(%Pdu{command: c} = pdu, state) when c in [:bind_transmitter, :bind_receiver, :bind_transceiver] do
    if Smsc.config().mode == :refuse do
      {Pdu.encode!(Pdu.response(pdu, :esme_rbindfail)), state}
    else
      system_id = pdu.fields[:system_id]
      if c != :bind_transmitter, do: {:ok, _} = Registry.register(@registry, system_id, nil)
      Stats.incr(:smsc_binds)
      {Pdu.encode!(Pdu.response(pdu, :esme_rok, %{system_id: "FAKESMSC"})), %{state | system_id: system_id}}
    end
  end

  defp answer(%Pdu{command: :enquire_link} = pdu, state), do: {Pdu.encode!(Pdu.response(pdu)), state}

  defp answer(%Pdu{command: :unbind} = pdu, state) do
    send(self(), :drop)
    {Pdu.encode!(Pdu.response(pdu)), state}
  end

  defp answer(%Pdu{command: c} = pdu, state) when c in [:submit_sm, :data_sm] do
    Stats.incr(:smsc_submits)
    duplicate?(pdu)
    config = Smsc.config()

    cond do
      config.mode == :silent ->
        Stats.incr(:smsc_silent)
        {nil, state}

      config.error_pct > 0 and :rand.uniform() * 100 < config.error_pct ->
        Stats.incr(:smsc_resp_error)
        later(Pdu.encode!(Pdu.response(pdu, config.error_status)), config.resp_ms, state)

      true ->
        id = Dlr.next_id()
        if band(pdu.fields[:registered_delivery] || 0, 3) != 0, do: Dlr.schedule(state.system_id, id, pdu, config)
        later(Pdu.encode!(Pdu.response(pdu, :esme_rok, %{message_id: id})), config.resp_ms, state)
    end
  end

  # A receipt the switch refused (e.g. 0x08 while it starts) is sent again a second later, as SMSCs do.
  defp answer(%Pdu{command: :deliver_sm_resp, sequence: seq, status: status}, state) do
    {item, receipts} = Map.pop(state.receipts, seq)

    if item && status != 0 do
      Stats.incr(:smsc_receipts_refused)
      Dlr.retry(item)
    end

    {nil, %{state | receipts: receipts}}
  end

  defp answer(_pdu, state), do: {nil, state}

  # The same text to the same number again: the handset would get the message twice. The simulator's texts carry the
  # customer session's sequence number, so two different messages never look alike.
  defp duplicate?(pdu) do
    key = {pdu.fields[:destination_addr], pdu.fields[:short_message]}

    if :ets.update_counter(:sim_smsc_seen, key, 1, {key, 0}) > 1 do
      Stats.incr(:smsc_duplicates)
      Logger.warning("fake SMSC: duplicate submit to #{elem(key, 0)} on #{inspect(self())}")
    end
  end

  defp later(bytes, {_, 0}, state), do: {bytes, state}

  defp later(bytes, {min, max}, state) do
    Process.send_after(self(), {:send, bytes}, min + :rand.uniform(max - min + 1) - 1)
    {nil, state}
  end
end
