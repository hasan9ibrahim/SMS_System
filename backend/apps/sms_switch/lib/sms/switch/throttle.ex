defmodule Sms.Switch.Throttle do
  @moduledoc """
  TPS limits shared by both servers (S-2.4, decisions Q12 and Q13): a customer trunk's limit and its business
  company's limit on top, a vendor trunk's limit. A trunk's limit is `tps × max_connections` (migration 034).

  A submit names the counters it must fit in (`acquire/1`). Counting is per second in Redis, one atomic script per
  submit: all its counters are raised together and, if one is over its limit, none of them keeps the submit. A
  fixed one-second window lets at most one extra second of traffic through at a window edge, the tolerance Q13
  allows.

  The same module shares overflow buffer places (`buffer_take/2`, S-2.4) and leased places (`lease_take/4`: a voice
  gateway's calls at once, §8 SMS to voice; each place ends by itself if a server stops holding it).

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

  # Takes a place in an overflow buffer (S-2.4): KEYS[1] the buffer, ARGV[1] its size. 1 taken, 0 full. The count
  # expires an hour after the last change; on a trunk that keeps buffering, its drain sets it back to zero once it
  # sees the buffer empty (`buffer_reset/1`). Either way a place never given back (a server lost mid-message) goes.
  @buffer_script """
  local n = redis.call('INCR', KEYS[1])
  redis.call('PEXPIRE', KEYS[1], 3600000)
  if n > tonumber(ARGV[1]) then
    redis.call('DECR', KEYS[1])
    return 0
  end
  return 1
  """
  @buffer_sha :crypto.hash(:sha, @buffer_script) |> Base.encode16(case: :lower)

  # Gives back a submit counted but not sent: every counter in KEYS down by one, never below zero.
  @release_script """
  for i, key in ipairs(KEYS) do
    if tonumber(redis.call('GET', key) or '0') > 0 then redis.call('DECR', key) end
  end
  return 0
  """
  @release_sha :crypto.hash(:sha, @release_script) |> Base.encode16(case: :lower)

  # Takes one of `limit` places, each held by a lease until it is given back or runs out (§8 SMS to voice: a voice
  # gateway's calls at once). KEYS[1] the leases (a sorted set by expiry); ARGV: the lease id, the limit, now and the
  # lease's end (ms). Leases past their end are dropped first, so a place held by a server that stopped comes back on
  # its own. 1 taken (or renewed), 0 full.
  @lease_script """
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
  if not redis.call('ZSCORE', KEYS[1], ARGV[1]) and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
    return 0
  end
  redis.call('ZADD', KEYS[1], ARGV[4], ARGV[1])
  redis.call('PEXPIREAT', KEYS[1], redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2])
  return 1
  """
  @lease_sha :crypto.hash(:sha, @lease_script) |> Base.encode16(case: :lower)

  @typedoc "A counter: the name returned when it is the one over its limit, its key (e.g. `\"vt:7\"`) and its limit."
  @type counter :: {name :: atom(), key :: String.t(), limit :: pos_integer()}

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc """
  Counts one submit against every counter in `second` (this one by default): `:ok`, or `{:error, name}` of the first
  one over its limit.
  """
  @spec acquire([counter()], integer()) :: :ok | {:error, atom()}
  def acquire(counters, second \\ System.os_time(:second))
  def acquire([], _second), do: :ok

  def acquire(counters, second) do
    if config(:backend) == :redis and not redis_paused?() do
      case redis_acquire(counters, second) do
        {:ok, result} -> result
        {:error, reason} -> fallback(counters, second, reason)
      end
    else
      local_acquire(counters, second, divisor())
    end
  end

  @doc """
  Gives back a submit `acquire/2` counted in `second` that was not sent after all (e.g. every connection's window was
  full), so it does not use up a place of the second's limit (S-5.1).
  """
  @spec release([counter()], integer()) :: :ok
  def release([], _second), do: :ok

  def release(counters, second) do
    _ =
      if config(:backend) == :redis and not redis_paused?() do
        keys = for {_name, key, _limit} <- counters, do: "tps:#{key}:#{second}"
        run_script(@release_sha, @release_script, keys, [], config(:redis_timeout_ms))
      end

    # The local count (used while Redis was unavailable) too, never below zero.
    Enum.each(counters, fn {_name, key, _limit} ->
      :ets.update_counter(@table, {key, second}, {2, -1, 0, 0}, {{key, second}, 0})
    end)
  end

  @doc """
  Counts `n` submits against every counter in `second`, all or none (S-2.12: a scheduled message takes one place per
  submit the customer sent for it): `:ok`, or the error of the first that does not fit, with the places already taken
  given back. `n` is capped at the smallest limit (`places/2`), so a message larger than the TPS still fits in a second.
  """
  @spec acquire_many([counter()], pos_integer(), integer()) :: :ok | {:error, atom()}
  def acquire_many(counters, n, second \\ System.os_time(:second))
  def acquire_many([], _n, _second), do: :ok

  def acquire_many(counters, n, second) do
    n = places(counters, n)

    Enum.reduce_while(1..n, 0, fn _, taken ->
      case acquire(counters, second) do
        :ok -> {:cont, taken + 1}
        error -> {:halt, {error, taken}}
      end
    end)
    |> case do
      {error, taken} ->
        Enum.each(List.duplicate(:place, taken), fn _ -> release(counters, second) end)
        error

      ^n ->
        :ok
    end
  end

  @doc "Gives back the `n` submits `acquire_many/3` counted in `second` (capped as it was)."
  @spec release_many([counter()], pos_integer(), integer()) :: :ok
  def release_many(counters, n, second) do
    Enum.each(List.duplicate(:place, places(counters, n)), fn _ -> release(counters, second) end)
  end

  @doc "The places `n` submits take: at least one, at most the smallest limit of the counters."
  @spec places([counter()], integer()) :: pos_integer()
  def places([], n), do: max(n, 1)

  def places(counters, n) do
    limit = counters |> Enum.map(fn {_name, _key, limit} -> limit end) |> Enum.min()
    n |> max(1) |> min(limit)
  end

  @doc """
  Takes a place in a trunk's overflow buffer (S-2.4: over its TPS, a customer trunk with a buffer has its messages
  accepted and queued up to the buffer size): true when there was room. The count is shared like the TPS counters;
  while Redis is unavailable each server keeps its share of the buffer.
  """
  @spec buffer_take(String.t(), non_neg_integer()) :: boolean()
  def buffer_take(_key, size) when size <= 0, do: false

  def buffer_take(key, size) do
    if config(:backend) == :redis and not redis_paused?() do
      case run_script(
             @buffer_sha,
             @buffer_script,
             ["buf:#{key}"],
             [size],
             config(:redis_timeout_ms)
           ) do
        {:ok, 1} -> true
        {:ok, 0} -> false
        _error -> local_buffer_take(key, share(size, config(:cluster_size)))
      end
    else
      local_buffer_take(key, share(size, divisor()))
    end
  end

  @doc "Gives `n` places back (their messages left the buffer: sent on, refused, or never queued)."
  @spec buffer_release(String.t(), non_neg_integer()) :: :ok
  def buffer_release(key, n \\ 1)
  def buffer_release(_key, n) when n < 1, do: :ok

  def buffer_release(key, n) do
    _ =
      if config(:backend) == :redis and not redis_paused?() do
        case Redis.command(["DECRBY", "buf:#{key}", n], config(:redis_timeout_ms)) do
          {:ok, left} when left < 0 -> Redis.command(["SET", "buf:#{key}", "0", "KEEPTTL"])
          _ -> :ok
        end
      end

    # The local count (used while Redis was unavailable) is given back too, never below zero.
    _ = :ets.update_counter(@table, {:buffer, key}, {2, -n, 0, 0}, {{:buffer, key}, 0})
    :ok
  end

  @doc """
  Sets a buffer's count back to zero: its drain found the buffer empty for a while, so no place is in use but by a
  message being queued at this moment (S-2.4). Clears places lost with a server that stopped mid-message.
  """
  @spec buffer_reset(String.t()) :: :ok
  def buffer_reset(key) do
    _ =
      if config(:backend) == :redis and not redis_paused?(),
        do: Redis.command(["SET", "buf:#{key}", "0", "XX", "KEEPTTL"], config(:redis_timeout_ms))

    :ets.insert(@table, {{:buffer, key}, 0})
    :ok
  end

  @doc """
  Takes one of `limit` places of `key` for `lease_ms`, as lease `id` (§8 SMS to voice: at most `max_calls` calls at
  once per voice gateway on both servers): true when there was room. The places are shared like the TPS counters; a
  lease not given back (`lease_release/2`) ends by itself after `lease_ms`. While Redis is unavailable each server
  keeps its share of the places.
  """
  @spec lease_take(String.t(), String.t(), pos_integer(), pos_integer()) :: boolean()
  def lease_take(key, id, limit, lease_ms) do
    now = System.os_time(:millisecond)

    if config(:backend) == :redis and not redis_paused?() do
      args = [id, limit, now, now + lease_ms]

      case run_script(
             @lease_sha,
             @lease_script,
             ["lease:#{key}"],
             args,
             config(:redis_timeout_ms)
           ) do
        {:ok, 1} -> true
        {:ok, 0} -> false
        _error -> local_lease_take(key, id, share(limit, config(:cluster_size)), now, lease_ms)
      end
    else
      local_lease_take(key, id, share(limit, divisor()), now, lease_ms)
    end
  end

  @doc "Gives a place `lease_take/4` took back."
  @spec lease_release(String.t(), String.t()) :: :ok
  def lease_release(key, id) do
    _ =
      if config(:backend) == :redis and not redis_paused?(),
        do: Redis.command(["ZREM", "lease:#{key}", id], config(:redis_timeout_ms))

    :ets.delete(@table, {:lease, key, id})
    :ok
  end

  @doc "How many places of `key` are held now (this server's count while Redis is unavailable)."
  @spec leases(String.t()) :: non_neg_integer()
  def leases(key) do
    now = System.os_time(:millisecond)

    with true <- config(:backend) == :redis and not redis_paused?(),
         {:ok, n} when is_integer(n) <-
           Redis.command(["ZCOUNT", "lease:#{key}", "(#{now}", "+inf"], config(:redis_timeout_ms)) do
      n
    else
      _ -> local_leases(key, now)
    end
  end

  defp local_lease_take(key, id, limit, now, lease_ms) do
    held = :ets.member(@table, {:lease, key, id})

    if held or local_leases(key, now) < limit do
      :ets.insert(@table, {{:lease, key, id}, now + lease_ms})
      true
    else
      false
    end
  end

  defp local_leases(key, now) do
    :ets.select_count(@table, [
      {{{:lease, key, :_}, :"$1"}, [{:>, :"$1", now}], [true]}
    ])
  end

  defp local_buffer_take(key, size) do
    if :ets.update_counter(@table, {:buffer, key}, 1, {{:buffer, key}, 0}) > size do
      _ = :ets.update_counter(@table, {:buffer, key}, -1)
      false
    else
      true
    end
  end

  defp redis_acquire(counters, second) do
    keys = for {_name, key, _limit} <- counters, do: "tps:#{key}:#{second}"
    limits = for {_name, _key, limit} <- counters, do: limit

    case run_script(@sha, @script, keys, limits, config(:redis_timeout_ms)) do
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
  defp run_script(sha, script, keys, args, timeout) do
    case Redis.command(["EVALSHA", sha, length(keys)] ++ keys ++ args, timeout) do
      {:error, %{message: "NOSCRIPT" <> _}} ->
        Redis.command(["EVAL", script, length(keys)] ++ keys ++ args, timeout)

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

    # Leases that ran out (`lease_take/4`).
    now = System.os_time(:millisecond)
    :ets.select_delete(@table, [{{{:lease, :_, :_}, :"$1"}, [{:<, :"$1", now}], [true]}])

    {:noreply, state}
  end

  @defaults [backend: :local, cluster_size: 2, redis_timeout_ms: 50, retry_redis_after_ms: 1_000]

  defp config(key) do
    :sms_switch
    |> Application.get_env(__MODULE__, [])
    |> Keyword.get(key, Keyword.fetch!(@defaults, key))
  end
end
