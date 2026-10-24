defmodule Sms.Switch.Test.FakeSmsc do
  @moduledoc """
  A vendor SMSC for tests: listens on a free port or `port:` (TCP, or TLS with `tls:` options), accepts the switch's
  connections and answers them as told. Every PDU it receives is reported to the owner as
  `{:smsc, connection_pid, pdu}`, and every new connection as `{:smsc_connected, connection_pid}`.

  Behaviour, changed at any time with `set/3`:

    * `:bind_status`: the bind response's status (default 0);
    * `:submit`: `:ok` (answer with the next message id), `:silent` (never answer), `{:status, code}` or
      `{:delay, ms}` (answer OK after `ms`);
    * `:message_id`: a function from the submit's number (1, 2, …) to its message id (default decimal);
    * `:enquire_link`: `:answer` or `:silent`.

  `send_pdu/2` sends a PDU to the switch on one connection (a receipt, an unbind, an enquire_link) and `close/1`
  drops a connection.
  """
  use GenServer
  alias Sms.Switch.Smpp.Pdu

  @defaults %{
    bind_status: 0,
    submit: :ok,
    message_id: &Integer.to_string/1,
    enquire_link: :answer
  }

  def start(opts \\ []) do
    {:ok, pid} = GenServer.start(__MODULE__, Keyword.put(opts, :owner, self()))
    pid
  end

  def stop(smsc), do: GenServer.stop(smsc)
  def port(smsc), do: GenServer.call(smsc, :port)
  def set(smsc, key, value), do: GenServer.call(smsc, {:set, key, value})
  def connections(smsc), do: GenServer.call(smsc, :connections)

  @doc "Sends a PDU to the switch on `connection`."
  def send_pdu(connection, %Pdu{} = pdu), do: send(connection, {:send, pdu})

  @doc "Drops `connection` without an unbind."
  def close(connection), do: send(connection, :close)

  # ---------------------------------------------------------------- server

  @impl true
  def init(opts) do
    tls = Keyword.get(opts, :tls)
    base = [:binary, active: false, packet: :raw, reuseaddr: true, ip: {127, 0, 0, 1}]
    port = Keyword.get(opts, :port, 0)

    {:ok, listen} =
      if tls, do: :ssl.listen(port, base ++ tls), else: :gen_tcp.listen(port, base)

    {:ok, {_, port}} = if tls, do: :ssl.sockname(listen), else: :inet.sockname(listen)
    server = self()
    owner = Keyword.fetch!(opts, :owner)
    acceptor = spawn_link(fn -> accept_loop(server, owner, listen, tls != nil) end)

    {:ok,
     %{
       owner: owner,
       listen: listen,
       tls: tls != nil,
       port: port,
       acceptor: acceptor,
       behaviour: @defaults,
       connections: [],
       submits: 0
     }}
  end

  @impl true
  def handle_call(:port, _from, state), do: {:reply, state.port, state}

  def handle_call({:set, key, value}, _from, state),
    do: {:reply, :ok, put_in(state.behaviour[key], value)}

  def handle_call(:connections, _from, state),
    do: {:reply, Enum.filter(state.connections, &Process.alive?/1), state}

  def handle_call(:behaviour, _from, state), do: {:reply, state.behaviour, state}

  def handle_call(:next_message_id, _from, state) do
    n = state.submits + 1
    {:reply, state.behaviour.message_id.(n), %{state | submits: n}}
  end

  @impl true
  def handle_info({:accepted, conn}, state) do
    send(state.owner, {:smsc_connected, conn})
    {:noreply, %{state | connections: [conn | state.connections]}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    for conn <- state.connections, do: send(conn, :close)
    if state.tls, do: :ssl.close(state.listen), else: :gen_tcp.close(state.listen)
  end

  defp accept_loop(server, owner, listen, tls?) do
    case accept(listen, tls?) do
      {:ok, socket} ->
        mod = if tls?, do: :ssl, else: :gen_tcp
        conn = spawn(fn -> connection(server, owner, mod, socket) end)
        :ok = mod.controlling_process(socket, conn)
        send(conn, :go)
        send(server, {:accepted, conn})
        accept_loop(server, owner, listen, tls?)

      # A TLS handshake the client gave up on (a test of a refused certificate or version).
      {:error, :handshake} ->
        accept_loop(server, owner, listen, tls?)

      {:error, _closed} ->
        :ok
    end
  end

  defp accept(listen, false), do: :gen_tcp.accept(listen)

  defp accept(listen, true) do
    with {:ok, socket} <- :ssl.transport_accept(listen) do
      case :ssl.handshake(socket, 5_000) do
        {:ok, tls} -> {:ok, tls}
        {:error, _} -> {:error, :handshake}
      end
    end
  end

  # ---------------------------------------------------------------- one connection

  defp connection(server, owner, mod, socket) do
    receive do
      :go -> :ok
    end

    loop(%{server: server, owner: owner, mod: mod, socket: socket, buffer: <<>>})
  end

  defp loop(conn) do
    :ok = setopts(conn, active: :once)

    receive do
      {tag, _socket, data} when tag in [:tcp, :ssl] ->
        conn |> Map.update!(:buffer, &(&1 <> data)) |> drain() |> loop()

      {tag, _socket} when tag in [:tcp_closed, :ssl_closed] ->
        send(conn.owner, {:smsc_closed, self()})

      {:send, pdu} ->
        :ok = conn.mod.send(conn.socket, Pdu.encode!(pdu))
        loop(conn)

      {:send_later, bytes} ->
        _ = conn.mod.send(conn.socket, bytes)
        loop(conn)

      :close ->
        conn.mod.close(conn.socket)
        send(conn.owner, {:smsc_closed, self()})
    end
  end

  defp setopts(%{mod: :ssl, socket: s}, opts), do: :ssl.setopts(s, opts)
  defp setopts(%{socket: s}, opts), do: :inet.setopts(s, opts)

  defp drain(conn) do
    case Pdu.decode(conn.buffer) do
      {:ok, pdu, rest} ->
        send(conn.owner, {:smsc, self(), pdu})
        _ = answer(conn, pdu)
        drain(%{conn | buffer: rest})

      {:incomplete, _} ->
        conn
    end
  end

  defp answer(conn, %Pdu{command: c} = pdu)
       when c in [:bind_transmitter, :bind_receiver, :bind_transceiver] do
    status = GenServer.call(conn.server, :behaviour).bind_status
    fields = if status == 0, do: %{system_id: "FAKESMSC"}, else: %{}
    write(conn, Pdu.response(pdu, status, fields))
  end

  defp answer(conn, %Pdu{command: :enquire_link} = pdu) do
    if GenServer.call(conn.server, :behaviour).enquire_link == :answer,
      do: write(conn, Pdu.response(pdu))
  end

  defp answer(conn, %Pdu{command: c} = pdu) when c in [:submit_sm, :data_sm] do
    case GenServer.call(conn.server, :behaviour).submit do
      :ok ->
        write(
          conn,
          Pdu.response(pdu, :esme_rok, %{
            message_id: GenServer.call(conn.server, :next_message_id)
          })
        )

      :silent ->
        :ok

      {:status, code} ->
        write(conn, Pdu.response(pdu, code))

      {:delay, ms} ->
        id = GenServer.call(conn.server, :next_message_id)
        bytes = Pdu.encode!(Pdu.response(pdu, :esme_rok, %{message_id: id}))
        Process.send_after(self(), {:send_later, bytes}, ms)
    end
  end

  defp answer(conn, %Pdu{command: :unbind} = pdu), do: write(conn, Pdu.response(pdu))
  defp answer(_conn, _pdu), do: :ok

  defp write(conn, pdu), do: :ok = conn.mod.send(conn.socket, Pdu.encode!(pdu))
end
