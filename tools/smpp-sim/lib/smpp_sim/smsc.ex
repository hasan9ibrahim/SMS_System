defmodule SmppSim.Smsc do
  @moduledoc """
  Fake vendor SMSCs: the switch's vendor trunks connect to these (spec §2, §5.5). Each listener accepts any number of
  connections (`SmppSim.Smsc.Conn`), and all of them behave as `config/0` says, which a scenario can change while
  traffic runs (`configure/1`):

    * `:mode`: `:normal`, `:silent` (binds, never answers a submit: the switch's submit timeout and re-route, D4) or
      `:refuse` (refuses binds with 0x0D);
    * `:resp_ms`: `{min, max}` milliseconds before each `submit_sm_resp` (uniform);
    * `:error_pct` and `:error_status`: the share of submits refused, and with which status (default 0x58);
    * `:dlr_ms`: `{min, max}` milliseconds before the delivery receipt;
    * `:dlr_mix`: the receipts' final states by weight (`[{"DELIVRD", 90}, {"UNDELIV", 8}, {"EXPIRED", 2}]`).

  Receipts are sent by `SmppSim.Smsc.Dlr` on any bound connection of the same `system_id`, as a real SMSC does, so a
  receipt still arrives when the connection the message came on has dropped (a switch server stopped). Fake data
  only: any `system_id` and password bind.
  """
  use GenServer
  require Logger
  alias SmppSim.Smsc.Conn

  @defaults %{
    mode: :normal,
    resp_ms: {0, 0},
    error_pct: 0.0,
    error_status: 0x58,
    dlr_ms: {200, 1_000},
    dlr_mix: [{"DELIVRD", 90}, {"UNDELIV", 8}, {"EXPIRED", 2}]
  }

  @doc "The current behaviour of every fake SMSC."
  @spec config() :: map()
  def config, do: :persistent_term.get({__MODULE__, :config}, @defaults)

  @doc "Changes the behaviour of every fake SMSC at once (merged into the current one)."
  @spec configure(map() | keyword()) :: :ok
  def configure(changes), do: :persistent_term.put({__MODULE__, :config}, Map.merge(config(), Map.new(changes)))

  @doc "Back to the defaults."
  @spec reset_config() :: :ok
  def reset_config, do: :persistent_term.put({__MODULE__, :config}, @defaults)

  @doc "Starts a listener on `port` (0 = any free port) on `ip` (default all addresses)."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts)

  @spec port(pid()) :: :inet.port_number()
  def port(pid), do: GenServer.call(pid, :port)

  @doc "Drops every connection of this listener (a vendor outage); the switch reconnects."
  @spec drop_all(pid()) :: :ok
  def drop_all(pid), do: GenServer.call(pid, :drop_all)

  @impl true
  def init(opts) do
    ip = Keyword.get(opts, :ip, {0, 0, 0, 0})

    {:ok, listen} =
      :gen_tcp.listen(Keyword.get(opts, :port, 0), [
        :binary,
        ip: ip,
        active: false,
        packet: :raw,
        reuseaddr: true,
        backlog: 1024,
        nodelay: true
      ])

    {:ok, port} = :inet.port(listen)
    me = self()
    acceptor = spawn_link(fn -> accept(me, listen) end)
    Process.flag(:trap_exit, true)
    {:ok, %{listen: listen, port: port, acceptor: acceptor, conns: MapSet.new()}}
  end

  @impl true
  def handle_call(:port, _from, state), do: {:reply, state.port, state}

  def handle_call(:drop_all, _from, state) do
    for conn <- state.conns, do: Conn.drop(conn)
    {:reply, :ok, state}
  end

  @impl true
  def handle_info({:conn, pid}, state) do
    Process.monitor(pid)
    {:noreply, %{state | conns: MapSet.put(state.conns, pid)}}
  end

  def handle_info({:DOWN, _ref, :process, pid, _}, state),
    do: {:noreply, %{state | conns: MapSet.delete(state.conns, pid)}}

  def handle_info({:EXIT, _pid, _reason}, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    :gen_tcp.close(state.listen)
    for conn <- state.conns, do: Conn.drop(conn)
    :ok
  end

  defp accept(server, listen) do
    case :gen_tcp.accept(listen) do
      {:ok, socket} ->
        {:ok, pid} = Conn.start(socket)
        :ok = :gen_tcp.controlling_process(socket, pid)
        send(pid, :go)
        send(server, {:conn, pid})
        accept(server, listen)

      {:error, :closed} ->
        :ok

      {:error, reason} ->
        Logger.warning("fake SMSC accept failed: #{inspect(reason)}")
        accept(server, listen)
    end
  end
end
