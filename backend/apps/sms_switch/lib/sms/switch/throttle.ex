defmodule Sms.Switch.Throttle do
  @moduledoc """
  TPS limits shared by both servers (S-2.4, decisions Q12 and Q13): a customer trunk's limit and its business
  company's limit on top, a vendor trunk's limit. A trunk's limit is `tps × max_connections` (migration 034).

  A submit names the counters it must fit in (`acquire/1`). Counting is per second in Redis, one atomic script per
  submit: all its counters are raised together and, if one is over its limit, none of them keeps the submit. A
  fixed one-second window lets at most one extra second of traffic through at a window edge, the tolerance Q13
  allows.

  If Redis fails or is slow (over `:redis_timeout_ms`), each server counts on its own with every limit divided by
  `:cluster_size` (stricter, never looser: S-7.4), logs it, and tries Redis again after `:retry_redis_after_ms`.
  With `backend: :local` (one server, development, tests) the full limits are counted in memory.
  """
  use GenServer
  require Logger
  alias Sms.Core.Redis

  @table __MODULE__

  # KEYS are the counters, ARGV their limits, in the same order. Returns 0 (counted everywhere) or the 1-based index
  # of the first counter over its limit (nothing stays counted then).
  @script """
  for i, key in ipairs(KEYS) do
    local n = redis.call('INCR', key)
    if n == 1 then redis.call('PEXPIRE', key, 2000) end
    if n > tonumber(ARGV[i]) then
      for j = 1, i do redis.call('DECR', KEYS[j]) end
      return i
    end
  end
  return 0
  """
  @sha :crypto.hash(:sha, @script) |> Base.encode16(case: :lower)

  @typedoc "A counter: the name returned when it is the one over its limit, its key (e.g. `\"vt:7\"`) and its limit."
  @type counter :: {name :: atom(), key :: String.t(), limit :: pos_integer()}

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Counts one submit against every counter: `:ok`, or `{:error, name}` of the first one over its limit."
  @spec acquire([counter()]) :: :ok | {:error, atom()}
  def acquire([]), do: :ok

  def acquire(counters) do
    second = System.os_time(:second)

    if config(:backend) == :redis and not redis_paused?() do
      case redis_acquire(counters, second) do
        {:ok, result} -> result
        {:error, reason} -> fallback(counters, second, reason)
      end
    else
      local_acquire(counters, second, divisor())
    end
  end

  defp redis_acquire(counters, second) do
    keys = for {_name, key, _limit} <- counters, do: "tps:#{key}:#{second}"
    limits = for {_name, _key, limit} <- counters, do: limit

    case run_script(keys, limits, config(:redis_timeout_ms)) do
      {:ok, 0} ->
        {:ok, :ok}

      {:ok, i} when is_integer(i) and i >= 1 and i <= length(counters) ->
        {:ok, {:error, counters |> Enum.at(i - 1) |> elem(0)}}

      {:ok, other} ->
        {:error, {:unexpected_reply, other}}

      {:error, _} = error ->
        error
    end
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

  defp fallback(counters, second, reason) do
    :ets.insert(
      @table,
      {:redis_paused_until, System.monotonic_time(:millisecond) + config(:retry_redis_after_ms)}
    )

    Logger.warning(
      "TPS limits counted per server (Redis unavailable: #{inspect(reason)}); limits divided by #{config(:cluster_size)}"
    )

    :telemetry.execute([:sms, :switch, :throttle, :fallback], %{count: 1}, %{reason: reason})
    local_acquire(counters, second, config(:cluster_size))
  end

  defp redis_paused? do
    case :ets.lookup(@table, :redis_paused_until) do
      [{_, until}] -> System.monotonic_time(:millisecond) < until
      [] -> false
    end
  end

  # The divisor while Redis is paused after a failure, or 1 when the local backend is the configured one.
  defp divisor, do: if(config(:backend) == :redis, do: config(:cluster_size), else: 1)

  # Same rule as the script: raise each counter in turn; the first one over its limit takes back all raised so far.
  defp local_acquire(counters, second, divisor) do
    Enum.reduce_while(counters, [], fn {name, key, limit}, raised ->
      ets_key = {key, second}

      if :ets.update_counter(@table, ets_key, 1, {ets_key, 0}) > share(limit, divisor) do
        Enum.each([ets_key | raised], &:ets.update_counter(@table, &1, -1))
        {:halt, {:error, name}}
      else
        {:cont, [ets_key | raised]}
      end
    end)
    |> case do
      {:error, _} = error -> error
      _raised -> :ok
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

    :ets.select_delete(@table, [
      {{{:_, :"$1"}, :_}, [{:is_integer, :"$1"}, {:<, :"$1", old}], [true]}
    ])

    {:noreply, state}
  end

  @defaults [backend: :local, cluster_size: 2, redis_timeout_ms: 50, retry_redis_after_ms: 1_000]

  defp config(key) do
    :sms_switch
    |> Application.get_env(__MODULE__, [])
    |> Keyword.get(key, Keyword.fetch!(@defaults, key))
  end
end
