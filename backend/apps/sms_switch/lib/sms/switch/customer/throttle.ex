defmodule Sms.Switch.Customer.Throttle do
  @moduledoc """
  The customer TPS limits (S-2.4, decision Q13): one limit per trunk shared by all its sessions on every server
  (`tps × max_connections`), and the business company's limit on top.

  Counting is per second in Redis, one atomic script per submit: the trunk's counter and the company's counter are
  raised together, and a submit over either limit is not counted. A fixed one-second window lets at most one extra
  second of traffic through at a window edge, the tolerance Q13 allows.

  If Redis fails or is slow (over `:redis_timeout_ms`), each server counts on its own with the limit divided by
  `:cluster_size` (stricter, never looser: S-7.4), logs it, and tries Redis again after `:retry_redis_after_ms`.
  With `backend: :local` (one server, development, tests) the full limits are counted in memory.
  """
  use GenServer
  require Logger
  alias Sms.Core.Redis
  alias Sms.Switch.Customer.Trunk

  @table __MODULE__

  # KEYS[1] trunk counter, KEYS[2] company counter (optional); ARGV[1] trunk limit, ARGV[2] company limit.
  # Returns 0 (counted), 1 (over the trunk limit) or 2 (over the company limit).
  @script """
  local t = redis.call('INCR', KEYS[1])
  if t == 1 then redis.call('PEXPIRE', KEYS[1], 2000) end
  if t > tonumber(ARGV[1]) then
    redis.call('DECR', KEYS[1])
    return 1
  end
  if KEYS[2] then
    local c = redis.call('INCR', KEYS[2])
    if c == 1 then redis.call('PEXPIRE', KEYS[2], 2000) end
    if c > tonumber(ARGV[2]) then
      redis.call('DECR', KEYS[2])
      redis.call('DECR', KEYS[1])
      return 2
    end
  end
  return 0
  """
  @sha :crypto.hash(:sha, @script) |> Base.encode16(case: :lower)

  @type result :: :ok | {:error, :trunk_tps | :company_tps}

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Counts one submit against the trunk's and the company's limits."
  @spec check(Trunk.t()) :: result()
  def check(%Trunk{} = trunk) do
    second = System.os_time(:second)

    if config(:backend) == :redis and not redis_paused?() do
      case redis_check(trunk, second) do
        {:ok, result} -> result
        {:error, reason} -> fallback(trunk, second, reason)
      end
    else
      local_check(trunk, second, divisor())
    end
  end

  defp redis_check(trunk, second) do
    {keys, args} = redis_keys(trunk, second)

    case run_script(keys, args, config(:redis_timeout_ms)) do
      {:ok, 0} -> {:ok, :ok}
      {:ok, 1} -> {:ok, {:error, :trunk_tps}}
      {:ok, 2} -> {:ok, {:error, :company_tps}}
      {:ok, other} -> {:error, {:unexpected_reply, other}}
      {:error, _} = error -> error
    end
  end

  defp redis_keys(%Trunk{company_tps_limit: nil} = trunk, second),
    do: {["tps:ct:#{trunk.id}:#{second}"], [Trunk.trunk_tps(trunk)]}

  defp redis_keys(trunk, second) do
    {["tps:ct:#{trunk.id}:#{second}", "tps:bc:#{trunk.business_company_id}:#{second}"],
     [Trunk.trunk_tps(trunk), trunk.company_tps_limit]}
  end

  # EVALSHA runs the cached script; after a Redis restart or SCRIPT FLUSH it is sent in full once.
  defp run_script(keys, args, timeout) do
    case Redis.command(["EVALSHA", @sha, length(keys)] ++ keys ++ args, timeout) do
      {:error, %{message: "NOSCRIPT" <> _}} ->
        Redis.command(["EVAL", @script, length(keys)] ++ keys ++ args, timeout)

      other ->
        other
    end
  end

  defp fallback(trunk, second, reason) do
    :ets.insert(
      @table,
      {:redis_paused_until, System.monotonic_time(:millisecond) + config(:retry_redis_after_ms)}
    )

    Logger.warning(
      "TPS limits counted per server (Redis unavailable: #{inspect(reason)}); limits divided by #{config(:cluster_size)}"
    )

    :telemetry.execute([:sms, :switch, :throttle, :fallback], %{count: 1}, %{reason: reason})
    local_check(trunk, second, config(:cluster_size))
  end

  defp redis_paused? do
    case :ets.lookup(@table, :redis_paused_until) do
      [{_, until}] -> System.monotonic_time(:millisecond) < until
      [] -> false
    end
  end

  # The divisor while Redis is paused after a failure, or 1 when the local backend is the configured one.
  defp divisor, do: if(config(:backend) == :redis, do: config(:cluster_size), else: 1)

  defp local_check(trunk, second, divisor) do
    trunk_key = {:ct, trunk.id, second}

    cond do
      not bump(trunk_key, share(Trunk.trunk_tps(trunk), divisor)) ->
        {:error, :trunk_tps}

      trunk.company_tps_limit == nil ->
        :ok

      bump({:bc, trunk.business_company_id, second}, share(trunk.company_tps_limit, divisor)) ->
        :ok

      true ->
        # Over the company limit: the trunk's count is taken back too.
        _ = :ets.update_counter(@table, trunk_key, -1)
        {:error, :company_tps}
    end
  end

  # Raises the counter; a value over the limit is taken back, so only counted submits stay in the count.
  defp bump(key, limit) do
    if :ets.update_counter(@table, key, 1, {key, 0}) > limit do
      _ = :ets.update_counter(@table, key, -1)
      false
    else
      true
    end
  end

  defp share(limit, divisor), do: max(1, div(limit + divisor - 1, divisor))

  @impl true
  def init(_opts) do
    _ =
      :ets.new(@table, [
        :named_table,
        :public,
        :set,
        write_concurrency: true,
        read_concurrency: true
      ])

    {:ok, _} = :timer.send_interval(1_000, :sweep)
    {:ok, nil}
  end

  # Counters of past seconds are dropped (Redis expires its own keys).
  @impl true
  def handle_info(:sweep, state) do
    old = System.os_time(:second) - 2
    :ets.select_delete(@table, [{{{:_, :_, :"$1"}, :_}, [{:<, :"$1", old}], [true]}])
    {:noreply, state}
  end

  defp config(key) do
    :sms_switch
    |> Application.get_env(__MODULE__, [])
    |> Keyword.get(
      key,
      Keyword.fetch!(
        [backend: :local, cluster_size: 2, redis_timeout_ms: 50, retry_redis_after_ms: 1_000],
        key
      )
    )
  end
end
