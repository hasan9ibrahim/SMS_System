defmodule Sms.Switch.Pipeline.Store do
  @moduledoc """
  What the pipeline remembers about a message after it was sent, shared by both servers in Redis: a receipt can come
  back on any server's vendor connection, and the customer's receipt can leave from either (spec §13.1, S-5.5–S-5.9).

    * `m:<message id>`: a hash with the message's data (`d`), each part's vendor message id (`s<n>`), each part's first
      final receipt (`f<n>`, first one wins, S-5.8) and whether the customer's receipt was claimed (`c`);
    * `v:<vendor trunk>:<vendor message id>`: the message and part a vendor id belongs to (normalised, S-5.6);
    * `o:<vendor trunk>:<vendor message id>`: a receipt that arrived before its submit_sm_resp was handled (S-5.5),
      kept a minute for the sender to pick up;
    * `g:<group key>`: the decision shared by the parts of one multipart message (S-3.3, S-3.8);
    * `h:<customer trunk>`: customer receipts held while no session of the trunk can take them (§13.1), a sorted set
      by arrival; `hs` the trunks that have any, `hl:<customer trunk>` the lock of the node sending them.

  Everything expires: a message after its vendor trunk's DLR timeout plus an hour. With `backend: :local` (one server,
  development, tests) the same keys live in an ETS table owned by this process.
  """
  use GenServer
  alias Sms.Core.Redis

  @table __MODULE__
  @orphan_ttl_s 60
  @timeout 2_000

  @type part :: pos_integer()

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc """
  Records a message as sent: its data and each part's vendor message id, with the index from vendor ids back to it.
  `parts` are `{part, vendor_trunk_id, normalised_vendor_id}`.
  """
  @spec record_sent(String.t(), term(), [{part(), integer(), String.t()}], pos_integer()) ::
          :ok | {:error, term()}
  def record_sent(message_id, data, parts, ttl_s) do
    hash = "m:#{message_id}"
    blob = :erlang.term_to_binary(data, [:compressed])

    commands =
      [
        ["HSET", hash, "d", blob | Enum.flat_map(parts, fn {n, _vt, vid} -> ["s#{n}", vid] end)],
        ["EXPIRE", hash, ttl_s]
      ] ++
        Enum.map(parts, fn {n, vt, vid} ->
          ["SET", "v:#{vt}:#{vid}", "#{message_id}:#{n}", "EX", ttl_s]
        end)

    case backend() do
      :redis -> ok(Redis.transaction(commands, @timeout))
      :local -> ok(local(commands))
    end
  end

  @doc "Whether the message was already recorded as sent (a redelivered event is not sent twice)."
  @spec sent?(String.t()) :: boolean() | {:error, term()}
  def sent?(message_id) do
    case run(["HEXISTS", "m:#{message_id}", "d"]) do
      {:ok, 1} -> true
      {:ok, 0} -> false
      {:error, _} = error -> error
    end
  end

  @doc "The message and part of a vendor message id, trying each normalised key in turn (S-5.6)."
  @spec find_vendor_id(integer(), [String.t()]) ::
          {:ok, {String.t(), part()}} | :none | {:error, term()}
  def find_vendor_id(vendor_trunk_id, keys) do
    Enum.reduce_while(keys, :none, fn key, :none ->
      case run(["GET", "v:#{vendor_trunk_id}:#{key}"]) do
        {:ok, nil} ->
          {:cont, :none}

        {:ok, value} ->
          [id, n] = String.split(value, ":")
          {:halt, {:ok, {id, String.to_integer(n)}}}

        {:error, _} = error ->
          {:halt, error}
      end
    end)
  end

  @doc "The message's data, each part's first final receipt and whether its customer receipt was claimed."
  @spec message(String.t()) :: {:ok, map()} | :none | {:error, term()}
  def message(message_id) do
    case run(["HGETALL", "m:#{message_id}"]) do
      {:ok, []} ->
        :none

      {:ok, flat} ->
        flat |> Enum.chunk_every(2) |> Map.new(fn [k, v] -> {k, v} end) |> decode_message()

      {:error, _} = error ->
        error
    end
  end

  defp decode_message(%{"d" => blob} = fields) do
    finals =
      for {"f" <> n, v} <- fields,
          into: %{},
          do: {String.to_integer(n), :erlang.binary_to_term(v, [:safe])}

    {:ok,
     %{
       data: :erlang.binary_to_term(blob, [:safe]),
       finals: finals,
       forwarded: Map.has_key?(fields, "c")
     }}
  end

  defp decode_message(_fields), do: :none

  @doc "Keeps a part's final receipt unless it already has one (the first final status wins, S-5.8)."
  @spec put_final(String.t(), part(), term()) :: {:ok, boolean()} | {:error, term()}
  def put_final(message_id, part, receipt) do
    case run(["HSETNX", "m:#{message_id}", "f#{part}", :erlang.term_to_binary(receipt)]) do
      {:ok, n} -> {:ok, n == 1}
      error -> error
    end
  end

  @doc "Claims the customer's receipt for a message: true for the one caller that gets it."
  @spec claim_forward(String.t()) :: {:ok, boolean()} | {:error, term()}
  def claim_forward(message_id) do
    case run(["HSETNX", "m:#{message_id}", "c", "1"]) do
      {:ok, n} -> {:ok, n == 1}
      error -> error
    end
  end

  @doc "Keeps a receipt whose vendor id is not known yet (S-5.5)."
  @spec put_orphan(integer(), String.t(), term()) :: :ok | {:error, term()}
  def put_orphan(vendor_trunk_id, key, receipt) do
    ok(
      run([
        "SET",
        "o:#{vendor_trunk_id}:#{key}",
        :erlang.term_to_binary(receipt),
        "EX",
        @orphan_ttl_s
      ])
    )
  end

  @doc "Takes (and removes) a receipt that arrived before its submit_sm_resp."
  @spec take_orphan(integer(), String.t()) :: {:ok, term()} | :none | {:error, term()}
  def take_orphan(vendor_trunk_id, key) do
    case run(["GETDEL", "o:#{vendor_trunk_id}:#{key}"]) do
      {:ok, nil} -> :none
      {:ok, blob} -> {:ok, :erlang.binary_to_term(blob, [:safe])}
      error -> error
    end
  end

  @doc "The decision a multipart message's first part stored, if any."
  @spec get_group(String.t()) :: {:ok, term()} | :none | {:error, term()}
  def get_group(key) do
    case run(["GET", "g:#{key}"]) do
      {:ok, nil} -> :none
      {:ok, blob} -> {:ok, :erlang.binary_to_term(blob, [:safe])}
      error -> error
    end
  end

  @doc """
  The decision shared by the parts of a multipart message: stores `value` when the group has none yet and returns
  it, else returns the one stored by the part that came first.
  """
  @spec group(String.t(), term(), pos_integer()) :: {:ok, term()} | {:error, term()}
  def group(key, value, ttl_s) do
    blob = :erlang.term_to_binary(value)

    case run(["SET", "g:#{key}", blob, "NX", "GET", "EX", ttl_s]) do
      {:ok, nil} -> {:ok, value}
      {:ok, existing} -> {:ok, :erlang.binary_to_term(existing, [:safe])}
      error -> error
    end
  end

  @doc "Holds a customer receipt until a session of the trunk can take it (§13.1)."
  @spec hold(integer(), term(), pos_integer()) :: :ok | {:error, term()}
  def hold(trunk_id, entry, at_ms) do
    commands = [
      ["ZADD", "h:#{trunk_id}", at_ms, :erlang.term_to_binary(entry)],
      ["SADD", "hs", "#{trunk_id}"]
    ]

    case backend() do
      :redis -> ok(Redis.transaction(commands, @timeout))
      :local -> ok(local(commands))
    end
  end

  @doc "The trunks with held receipts."
  @spec held_trunks() :: {:ok, [integer()]} | {:error, term()}
  def held_trunks do
    case run(["SMEMBERS", "hs"]) do
      {:ok, ids} -> {:ok, Enum.map(ids, &String.to_integer/1)}
      error -> error
    end
  end

  @doc "Up to `limit` held receipts of a trunk, oldest first, each with the stored member to release it by."
  @spec held(integer(), pos_integer()) :: {:ok, [{binary(), term()}]} | {:error, term()}
  def held(trunk_id, limit) do
    case run(["ZRANGE", "h:#{trunk_id}", 0, limit - 1]) do
      {:ok, members} -> {:ok, Enum.map(members, &{&1, :erlang.binary_to_term(&1, [:safe])})}
      error -> error
    end
  end

  @doc "Removes a held receipt (sent or given up); a trunk left with none leaves `hs`."
  @spec release(integer(), binary()) :: :ok | {:error, term()}
  def release(trunk_id, member) do
    key = "h:#{trunk_id}"

    # A receipt held between the count and the SREM is seen by the second count, and the trunk goes back in `hs`.
    with {:ok, _} <- run(["ZREM", key, member]),
         {:ok, 0} <- run(["ZCARD", key]),
         {:ok, _} <- run(["SREM", "hs", "#{trunk_id}"]),
         {:ok, n} when n > 0 <- run(["ZCARD", key]) do
      ok(run(["SADD", "hs", "#{trunk_id}"]))
    else
      {:ok, _} -> :ok
      error -> error
    end
  end

  @doc "Takes the lock for sending a trunk's held receipts (one node at a time): true when this caller got it."
  @spec lock_held(integer(), pos_integer()) :: boolean()
  def lock_held(trunk_id, ttl_s),
    do: match?({:ok, "OK"}, run(["SET", "hl:#{trunk_id}", "#{node()}", "NX", "EX", ttl_s]))

  @doc "Gives the lock back."
  @spec unlock_held(integer()) :: :ok
  def unlock_held(trunk_id) do
    _ = run(["DEL", "hl:#{trunk_id}"])
    :ok
  end

  defp ok({:ok, _}), do: :ok
  defp ok(:ok), do: :ok
  defp ok({:error, _} = error), do: error

  defp run(command) do
    case backend() do
      :redis -> Redis.command(command, @timeout)
      :local -> local_one(command)
    end
  end

  defp backend,
    do: :sms_switch |> Application.get_env(__MODULE__, []) |> Keyword.get(:backend, :redis)

  # ---------------------------------------------------------------- local backend (one node, tests)

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

    {:ok, _} = :timer.send_interval(60_000, :sweep)
    {:ok, nil}
  end

  @impl true
  def handle_info(:sweep, state) do
    now = System.monotonic_time(:second)
    :ets.select_delete(@table, [{{:_, :_, :"$1"}, [{:<, :"$1", now}], [true]}])
    {:noreply, state}
  end

  # The local commands run under the table's own process so a hash update is one step.
  defp local(commands), do: GenServer.call(__MODULE__, {:local, commands})

  defp local_one(command) do
    case GenServer.call(__MODULE__, {:local, [command]}) do
      {:ok, [result]} -> {:ok, result}
    end
  end

  @impl true
  def handle_call({:local, commands}, _from, state) do
    {:reply, {:ok, Enum.map(commands, &exec/1)}, state}
  end

  @far 4_000_000_000

  defp exec(["HSET", key, f1, v1 | rest]) do
    hash =
      Map.merge(
        get_hash(key),
        Map.new(Enum.chunk_every([f1, v1 | rest], 2), fn [k, v] -> {k, v} end)
      )

    put(key, hash, expiry(key))
    1
  end

  defp exec(["HSETNX", key, field, value]) do
    hash = get_hash(key)

    if Map.has_key?(hash, field) do
      0
    else
      put(key, Map.put(hash, field, value), expiry(key))
      1
    end
  end

  defp exec(["HEXISTS", key, field]), do: if(Map.has_key?(get_hash(key), field), do: 1, else: 0)
  defp exec(["HGETALL", key]), do: key |> get_hash() |> Enum.flat_map(fn {k, v} -> [k, v] end)

  defp exec(["EXPIRE", key, ttl]) do
    case lookup(key) do
      nil -> 0
      value -> put_then(key, value, ttl, 1)
    end
  end

  defp exec(["SET", key, value, "EX", ttl]), do: put_then(key, value, ttl, "OK")

  defp exec(["SET", key, value, "NX", "GET", "EX", ttl]) do
    case lookup(key) do
      nil -> put_then(key, value, ttl, nil)
      existing -> existing
    end
  end

  defp exec(["SET", key, value, "NX", "EX", ttl]) do
    case lookup(key) do
      nil -> put_then(key, value, ttl, "OK")
      _ -> nil
    end
  end

  defp exec(["GET", key]), do: lookup(key)

  defp exec(["DEL", key]) do
    found = if lookup(key), do: 1, else: 0
    :ets.delete(@table, key)
    found
  end

  # Sorted sets as a map member → score, sets as a MapSet; neither expires.
  defp exec(["ZADD", key, score, member]) do
    zset = lookup(key) || %{}
    put(key, Map.put(zset, member, score), System.monotonic_time(:second) + @far)
    if Map.has_key?(zset, member), do: 0, else: 1
  end

  defp exec(["ZRANGE", key, from, to]) do
    (lookup(key) || %{})
    |> Enum.sort_by(fn {m, s} -> {s, m} end)
    |> Enum.map(&elem(&1, 0))
    |> Enum.slice(from..to//1)
  end

  defp exec(["ZREM", key, member]) do
    zset = lookup(key) || %{}
    put(key, Map.delete(zset, member), System.monotonic_time(:second) + @far)
    if Map.has_key?(zset, member), do: 1, else: 0
  end

  defp exec(["ZCARD", key]), do: map_size(lookup(key) || %{})

  defp exec(["SADD", key, member]) do
    set = lookup(key) || MapSet.new()
    put(key, MapSet.put(set, member), System.monotonic_time(:second) + @far)
    if MapSet.member?(set, member), do: 0, else: 1
  end

  defp exec(["SREM", key, member]) do
    set = lookup(key) || MapSet.new()
    put(key, MapSet.delete(set, member), System.monotonic_time(:second) + @far)
    if MapSet.member?(set, member), do: 1, else: 0
  end

  defp exec(["SMEMBERS", key]), do: MapSet.to_list(lookup(key) || MapSet.new())

  defp exec(["GETDEL", key]) do
    value = lookup(key)
    :ets.delete(@table, key)
    value
  end

  defp lookup(key) do
    now = System.monotonic_time(:second)

    case :ets.lookup(@table, key) do
      [{_, value, until}] when until >= now -> value
      _ -> nil
    end
  end

  defp get_hash(key), do: lookup(key) || %{}

  defp expiry(key) do
    case :ets.lookup(@table, key) do
      [{_, _, until}] -> until
      [] -> System.monotonic_time(:second) + @far
    end
  end

  defp put(key, value, until), do: :ets.insert(@table, {key, value, until})

  defp put_then(key, value, ttl, reply) do
    put(key, value, System.monotonic_time(:second) + ttl)
    reply
  end
end
