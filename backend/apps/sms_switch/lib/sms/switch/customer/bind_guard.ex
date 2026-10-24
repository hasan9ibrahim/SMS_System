defmodule Sms.Switch.Customer.BindGuard do
  @moduledoc """
  Bind brute-force protection (S-1.1, S-8.1): after `:max_failures` failed binds (unknown system_id, wrong
  password, IP not allowed) from one IP within `:window_ms`, binds from that IP are refused for `:block_ms`, even
  with the right password. A successful bind clears the IP's count. Counts are per server.
  """
  use GenServer

  @table __MODULE__
  @defaults [max_failures: 10, window_ms: 300_000, block_ms: 900_000, sweep_ms: 60_000]

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Whether binds from `ip` are refused right now."
  @spec blocked?(:inet.ip_address()) :: boolean()
  def blocked?(ip) do
    case :ets.lookup(@table, ip) do
      [{^ip, _count, _since, until}] when is_integer(until) -> now() < until
      _ -> false
    end
  end

  @doc "Records a failed bind; returns `:blocked` when this failure blocks the IP."
  @spec failure(:inet.ip_address()) :: :ok | :blocked
  def failure(ip), do: GenServer.call(__MODULE__, {:failure, ip})

  @doc "Records a successful bind: the IP's failures are forgotten."
  @spec success(:inet.ip_address()) :: :ok
  def success(ip) do
    :ets.delete(@table, ip)
    :ok
  end

  @impl true
  def init(opts) do
    opts = Keyword.merge(@defaults, opts)
    _ = :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
    Process.send_after(self(), :sweep, opts[:sweep_ms])
    {:ok, Map.new(opts)}
  end

  # One writer, so counting is never lost between two sessions failing at once.
  @impl true
  def handle_call({:failure, ip}, _from, s) do
    now = now()

    {count, since} =
      case :ets.lookup(@table, ip) do
        [{^ip, count, since, _}] when now - since <= s.window_ms -> {count + 1, since}
        _ -> {1, now}
      end

    if count >= s.max_failures do
      :ets.insert(@table, {ip, count, since, now + s.block_ms})
      {:reply, :blocked, s}
    else
      :ets.insert(@table, {ip, count, since, nil})
      {:reply, :ok, s}
    end
  end

  @impl true
  def handle_info(:sweep, s) do
    now = now()

    for {ip, _count, since, until} <- :ets.tab2list(@table),
        (until == nil and now - since > s.window_ms) or (is_integer(until) and now >= until) do
      :ets.delete(@table, ip)
    end

    Process.send_after(self(), :sweep, s.sweep_ms)
    {:noreply, s}
  end

  defp now, do: System.monotonic_time(:millisecond)
end
