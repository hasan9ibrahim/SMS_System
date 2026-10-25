defmodule SmppSim.Esme do
  @moduledoc """
  One fake customer connection (an ESME): binds to the switch as a transceiver and submits at a set rate, the way a
  customer's platform does (spec §2, §5.4).

    * **Pacing:** every 5 ms the session adds `rate × elapsed` to its credit (starting at a random phase) and sends
      that many `submit_sm`, as far as its window allows (at most `window` answers waiting, like a real client). Credit the window could not send
      within one second is dropped and counted as `behind`: the switch did not keep up with the offered load.
    * **Measures** (`SmppSim.Stats`): submit_sm → submit_sm_resp latency, the statuses, and each delivery receipt
      matched to the message the switch accepted (submit → receipt latency, missing, duplicate or unknown receipts).
    * **Multipart:** `multipart_pct` of the messages go as 2-part UDH concatenations (two `submit_sm`).
    * **Failures:** an answer missing after 30 s counts as a timeout; a dropped connection counts its waiting submits
      as lost, and with `reconnect: true` the session binds again after a second, to the next host in `hosts`
      (a customer with both servers' addresses, Q10).

  Destinations are a dial prefix from `prefixes` plus random digits; only prefixes the load-test trunks have rates
  for are used. Fake data only.
  """
  use GenServer, restart: :transient
  require Logger
  import Bitwise
  alias SmppSim.Stats
  alias Sms.Switch.Smpp.Pdu

  @tick_ms 5
  @timeout_us 30_000_000
  @gsm_text "Load test message, fake data only. Reference "

  @type opts :: [
          hosts: [{String.t(), :inet.port_number()}],
          system_id: String.t(),
          password: String.t(),
          prefixes: tuple(),
          window: pos_integer(),
          multipart_pct: number(),
          receipts: boolean(),
          reconnect: boolean()
        ]

  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts)

  @doc "Sets the session's rate (messages per second; a multipart message counts once)."
  @spec set_rate(pid(), number()) :: :ok
  def set_rate(pid, rate), do: GenServer.cast(pid, {:rate, rate})

  @doc "`:bound`, `:connecting`, and the answers waiting."
  @spec info(pid()) :: %{state: :bound | :connecting, inflight: non_neg_integer()}
  def info(pid), do: GenServer.call(pid, :info)

  @doc "Unbinds and stops."
  @spec stop(pid()) :: :ok
  def stop(pid), do: GenServer.stop(pid, :normal, 10_000)

  # ---------------------------------------------------------------- state

  @impl true
  def init(opts) do
    state = %{
      hosts: Keyword.fetch!(opts, :hosts),
      host_index: Keyword.get(opts, :host_index, 0),
      system_id: Keyword.fetch!(opts, :system_id),
      password: Keyword.fetch!(opts, :password),
      prefixes: Keyword.fetch!(opts, :prefixes),
      window: Keyword.get(opts, :window, 100),
      multipart_pct: Keyword.get(opts, :multipart_pct, 0),
      registered_delivery: if(Keyword.get(opts, :receipts, true), do: 1, else: 0),
      reconnect: Keyword.get(opts, :reconnect, true),
      socket: nil,
      buffer: <<>>,
      seq: 1,
      ref: :rand.uniform(255),
      inflight: %{},
      rate: 0.0,
      # A random phase, so sessions at the same rate do not all send on the same tick: started together they would
      # turn a steady rate into bursts of one message per session.
      credit: :rand.uniform(),
      last_tick: nil
    }

    send(self(), :connect)
    :timer.send_interval(1_000, :expire)
    {:ok, state}
  end

  @impl true
  def handle_cast({:rate, rate}, state), do: {:noreply, %{state | rate: rate * 1.0, credit: min(state.credit, 1.0)}}

  @impl true
  def handle_call(:info, _from, state),
    do: {:reply, %{state: if(state.socket, do: :bound, else: :connecting), inflight: map_size(state.inflight)}, state}

  @impl true
  def terminate(_reason, %{socket: nil}), do: :ok

  def terminate(_reason, state) do
    _ = :gen_tcp.send(state.socket, Pdu.encode!(Pdu.new(:unbind, %{}, sequence: state.seq)))
    :gen_tcp.close(state.socket)
  end

  # ---------------------------------------------------------------- connection

  @impl true
  def handle_info(:connect, state) do
    {host, port} = Enum.at(state.hosts, rem(state.host_index, length(state.hosts)))

    case bind(host, port, state) do
      {:ok, socket, rest} ->
        Stats.incr(:binds)
        :ok = :inet.setopts(socket, active: 100)
        send(self(), :tick)
        {:noreply, drain(%{state | socket: socket, buffer: rest, last_tick: now()})}

      {:error, reason} ->
        Stats.incr(:bind_fail)
        Logger.debug("#{state.system_id} bind to #{host}:#{port} failed: #{inspect(reason)}")
        Process.send_after(self(), :connect, 1_000)
        {:noreply, %{state | host_index: state.host_index + 1}}
    end
  end

  def handle_info({:tcp, _socket, data}, state), do: {:noreply, drain(%{state | buffer: state.buffer <> data})}

  def handle_info({:tcp_passive, socket}, state) do
    :ok = :inet.setopts(socket, active: 100)
    {:noreply, state}
  end

  def handle_info({:tcp_closed, _socket}, state), do: {:noreply, disconnected(state)}
  def handle_info({:tcp_error, _socket, _reason}, state), do: {:noreply, disconnected(state)}

  def handle_info(:tick, %{socket: nil} = state), do: {:noreply, state}

  def handle_info(:tick, state) do
    Process.send_after(self(), :tick, @tick_ms)
    {:noreply, pace(state)}
  end

  def handle_info(:expire, state) do
    limit = now() - @timeout_us
    {expired, waiting} = Map.split_with(state.inflight, fn {_seq, {sent, _parts}} -> sent < limit end)
    if map_size(expired) > 0, do: Stats.incr(:resp_timeout, map_size(expired))
    {:noreply, %{state | inflight: waiting}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  defp bind(host, port, state) do
    opts = [:binary, active: false, packet: :raw, nodelay: true, sndbuf: 1 <<< 20, recbuf: 1 <<< 20]

    with {:ok, socket} <- :gen_tcp.connect(String.to_charlist(host), port, opts, 5_000) do
      fields = %{system_id: state.system_id, password: state.password, interface_version: 0x34}
      :ok = :gen_tcp.send(socket, Pdu.encode!(Pdu.new(:bind_transceiver, fields, sequence: 0)))

      case read_pdu(socket, <<>>) do
        {:ok, %Pdu{command: :bind_transceiver_resp, status: 0}, rest} ->
          {:ok, socket, rest}

        {:ok, %Pdu{status: status}, _} ->
          :gen_tcp.close(socket)
          {:error, {:bind_refused, status}}

        {:error, _} = error ->
          :gen_tcp.close(socket)
          error
      end
    end
  end

  defp read_pdu(socket, buffer) do
    case Pdu.decode(buffer) do
      {:ok, pdu, rest} ->
        {:ok, pdu, rest}

      {:incomplete, _} ->
        with {:ok, data} <- :gen_tcp.recv(socket, 0, 5_000), do: read_pdu(socket, buffer <> data)

      {:error, error, _} ->
        {:error, error}
    end
  end

  defp disconnected(state) do
    Stats.incr(:disconnects)
    if map_size(state.inflight) > 0, do: Stats.incr(:lost_inflight, map_size(state.inflight))
    _ = if state.socket, do: :gen_tcp.close(state.socket)
    if state.reconnect, do: Process.send_after(self(), :connect, 1_000)
    %{state | socket: nil, buffer: <<>>, inflight: %{}, host_index: state.host_index + 1}
  end

  # ---------------------------------------------------------------- sending

  defp pace(state) do
    t = now()
    credit = state.credit + state.rate * (t - state.last_tick) / 1_000_000
    room = state.window - map_size(state.inflight)
    n = credit |> trunc() |> min(max(room, 0))
    state = %{state | credit: credit - n, last_tick: t}
    state = if n > 0, do: send_many(state, n, t), else: state

    # More than a second of traffic the window could not send: the switch is not keeping up.
    if state.credit > max(state.rate, 1.0) do
      behind = trunc(state.credit - state.rate)
      Stats.incr(:behind, behind)
      %{state | credit: state.credit - behind}
    else
      state
    end
  end

  defp send_many(state, n, t) do
    {iodata, state} =
      Enum.reduce(1..n, {[], state}, fn _, {acc, st} ->
        {bytes, st} = message(st, t)
        {[acc | bytes], st}
      end)

    case :gen_tcp.send(state.socket, iodata) do
      :ok -> state
      {:error, _} -> disconnected(state)
    end
  end

  defp message(state, t) do
    dest = destination(state.prefixes)
    Stats.incr(:submitted)

    if state.multipart_pct > 0 and :rand.uniform() * 100 < state.multipart_pct do
      ref = rem(state.ref + 1, 256)
      # Unique per message (the vendors' duplicate check compares texts).
      text = ("#{state.seq} " <> String.duplicate(@gsm_text, 7)) |> binary_part(0, 300)
      parts = [binary_part(text, 0, 153), binary_part(text, 153, 147)]

      {bytes, state} =
        parts
        |> Enum.with_index(1)
        |> Enum.reduce({[], %{state | ref: ref}}, fn {part, i}, {acc, st} ->
          udh = <<5, 0, 3, ref, 2, i>>
          {b, st} = submit(st, dest, udh <> part, 0x40, t)
          {[acc | b], st}
        end)

      {bytes, state}
    else
      submit(state, dest, @gsm_text <> Integer.to_string(state.seq), 0, t)
    end
  end

  defp submit(state, dest, text, esm_class, t) do
    seq = state.seq
    Stats.incr(:parts_submitted)

    fields = %{
      source_addr_ton: 5,
      source_addr_npi: 0,
      source_addr: "LoadTest",
      dest_addr_ton: 1,
      dest_addr_npi: 1,
      destination_addr: dest,
      esm_class: esm_class,
      registered_delivery: state.registered_delivery,
      data_coding: 0,
      short_message: text
    }

    bytes = Pdu.encode!(Pdu.new(:submit_sm, fields, sequence: seq))
    next = if seq >= 0x7FFFFFFF, do: 1, else: seq + 1
    {bytes, %{state | seq: next, inflight: Map.put(state.inflight, seq, {t, 1})}}
  end

  defp destination(prefixes) do
    prefix = elem(prefixes, :rand.uniform(tuple_size(prefixes)) - 1)
    digits = max(11 - byte_size(prefix), 4)
    prefix <> ((:rand.uniform(Integer.pow(10, digits)) - 1) |> Integer.to_string() |> String.pad_leading(digits, "0"))
  end

  # ---------------------------------------------------------------- receiving

  defp drain(state) do
    {replies, state} = drain(state, [])

    if replies != [] and state.socket do
      case :gen_tcp.send(state.socket, replies) do
        :ok -> state
        {:error, _} -> disconnected(state)
      end
    else
      state
    end
  end

  defp drain(state, replies) do
    case Pdu.decode(state.buffer) do
      {:ok, pdu, rest} ->
        {reply, state} = handle_pdu(pdu, %{state | buffer: rest})
        drain(state, if(reply, do: [replies | Pdu.encode!(reply)], else: replies))

      {:incomplete, _} ->
        {replies, state}

      {:error, error, rest} ->
        Logger.warning("#{state.system_id}: bad PDU from the switch: #{Exception.message(error)}")
        reply = Pdu.error_reply(error)
        drain(%{state | buffer: rest}, if(reply, do: [replies | Pdu.encode!(reply)], else: replies))
    end
  end

  defp handle_pdu(%Pdu{command: :submit_sm_resp, sequence: seq, status: status} = pdu, state) do
    case Map.pop(state.inflight, seq) do
      {nil, _} ->
        {nil, state}

      {{sent, _}, inflight} ->
        Stats.record(:resp, now() - sent)
        Stats.status(status)

        case status do
          0 ->
            Stats.incr(:resp_ok)
            Stats.accepted(pdu.fields[:message_id], sent)

          0x58 ->
            Stats.incr(:resp_throttled)

          _ ->
            Stats.incr(:resp_rejected)
        end

        {nil, %{state | inflight: inflight}}
    end
  end

  defp handle_pdu(%Pdu{command: :deliver_sm} = pdu, state) do
    if band(pdu.fields[:esm_class] || 0, 0x3C) == 0x04, do: receipt(pdu)
    {Pdu.response(pdu, :esme_rok, %{message_id: ""}), state}
  end

  defp handle_pdu(%Pdu{command: :enquire_link} = pdu, state), do: {Pdu.response(pdu), state}

  defp handle_pdu(%Pdu{command: :unbind} = pdu, state) do
    send(self(), {:tcp_closed, state.socket})
    {Pdu.response(pdu), state}
  end

  defp handle_pdu(%Pdu{command: :generic_nack, sequence: seq}, state) do
    case Map.pop(state.inflight, seq) do
      {nil, _} ->
        {nil, state}

      {_, inflight} ->
        Stats.incr(:resp_rejected)
        {nil, %{state | inflight: inflight}}
    end
  end

  defp handle_pdu(_pdu, state), do: {nil, state}

  defp receipt(pdu) do
    {id, stat} = receipt_fields(pdu)
    Stats.incr(:receipts)

    stat
    |> case do
      "DELIVRD" -> :dlr_delivrd
      "UNDELIV" -> :dlr_undeliv
      "EXPIRED" -> :dlr_expired
      "REJECTD" -> :dlr_rejectd
      _ -> :dlr_other
    end
    |> Stats.incr()

    case Stats.receipt(id) do
      {:ok, sent} -> Stats.record(:e2e, now() - sent)
      :dup -> Stats.incr(:receipts_dup)
      :unknown -> Stats.incr(:receipts_unknown)
    end
  end

  @states %{1 => "ENROUTE", 2 => "DELIVRD", 3 => "EXPIRED", 4 => "DELETED", 5 => "UNDELIV", 8 => "REJECTD"}

  @doc false
  def receipt_fields(%Pdu{tlvs: tlvs, fields: fields}) do
    text = fields[:short_message] || ""
    id = List.keyfind(tlvs, :receipted_message_id, 0)
    state = List.keyfind(tlvs, :message_state, 0)

    {
      if(id, do: elem(id, 1), else: text_field(text, ~r/id:(\S+)/)),
      if(state, do: Map.get(@states, elem(state, 1)), else: text_field(text, ~r/stat:(\w+)/))
    }
  end

  defp text_field(text, regex) do
    case Regex.run(regex, text) do
      [_, value] -> value
      _ -> nil
    end
  end

  defp now, do: System.monotonic_time(:microsecond)
end
