defmodule Sms.Core.Cluster do
  @moduledoc """
  Joins this node to the other servers (BACKEND_PLAN §3, decided hosting: two servers). The peers are listed in
  `SWITCH_PEERS` (node names, e.g. `sms@10.0.0.2`); every `:interval_ms` (5 s) the node connects to any peer it is not
  connected to, so a server that restarts or comes back after a network cut rejoins by itself. The node must be
  started distributed with the same cookie on every server (`--name`, `--cookie` or `RELEASE_COOKIE`).

  Joins and losses are logged. The switch's own process groups (`:pg`) follow the connection: sessions, vendor
  connections and Delayed Submit waits on the other server become visible or are forgotten.

  A lost link is noticed within `:net_ticktime` seconds (10, against Erlang's default 60): until then calls to the
  other server's sessions wait and time out. The load test's network cut (backend step 7) showed a minute of that
  delaying receipts and making the sender send a few messages again after a timeout (D4).
  """
  use GenServer
  require Logger

  @interval_ms 5_000

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "The peers configured, and which of them are connected now."
  @spec status() :: %{peers: [node()], connected: [node()]}
  def status, do: GenServer.call(__MODULE__, :status)

  @impl true
  def init(opts) do
    peers =
      opts |> Keyword.get(:peers, []) |> Enum.map(&to_node/1) |> Enum.reject(&(&1 == node()))

    :ok = :net_kernel.monitor_nodes(true)
    send(self(), :connect)
    {:ok, %{peers: peers, interval: Keyword.get(opts, :interval_ms, @interval_ms)}}
  end

  defp to_node(name) when is_atom(name), do: name
  defp to_node(name) when is_binary(name), do: String.to_atom(name)

  @impl true
  def handle_call(:status, _from, state),
    do:
      {:reply, %{peers: state.peers, connected: Enum.filter(state.peers, &(&1 in Node.list()))},
       state}

  @impl true
  def handle_info(:connect, state) do
    for peer <- state.peers, peer not in Node.list(), do: Node.connect(peer)
    Process.send_after(self(), :connect, state.interval)
    {:noreply, state}
  end

  def handle_info({:nodeup, peer}, state) do
    Logger.info("cluster: #{peer} joined")
    {:noreply, state}
  end

  def handle_info({:nodedown, peer}, state) do
    Logger.warning("cluster: #{peer} lost; reconnecting every #{state.interval} ms")
    {:noreply, state}
  end
end
