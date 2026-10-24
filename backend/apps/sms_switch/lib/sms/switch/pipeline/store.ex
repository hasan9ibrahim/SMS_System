defmodule Sms.Switch.Pipeline.Store do
  @moduledoc """
  What the pipeline remembers about a message after it was sent, shared by both servers in Redis: a receipt can come
  back on any server's vendor connection, and the customer's receipt can leave from either (spec §13.1, S-5.5–S-5.9).

    * `m:<message id>`: a hash with the message's data (`d`), each part's vendor message id (`s<n>`), each part's first
      final receipt (`f<n>`, first one wins, S-5.8) and whether the customer's receipt was claimed (`c`);
    * `v:<vendor trunk>:<vendor message id>`: the message and part a vendor id belongs to (normalised, S-5.6);
    * `o:<vendor trunk>:<vendor message id>`: a receipt that arrived before its submit_sm_resp was handled (S-5.5),
      kept a minute for the sender to pick up;
    * `rg:<group key>`: the parts of a customer's multipart message held until all have come (S-3.2, S-3.3): each
      part (`p<n>`), the message id it got (`i<n>`), how many are held (`count`) and whether it was taken (`done`);
      `rgt` their reassembly deadlines (D1);
    * `t`: the DLR timeouts of messages waiting for receipts, a sorted set by deadline (S-5.10); every server sweeps
      it and the one that removes an entry handles it;
    * `dup:<customer trunk>:<fingerprint>`: the message id of a message, for the duplicate filter's window (D6);
      `lp:<fingerprint>`: the customer trunk of a message in flight to a vendor, for Loop Detection (S-5.16);
    * `pd:<message id>:<part>`: the attempt of a part whose submit timed out, for a late answer (D4);
    * `h:<customer trunk>`: customer receipts held while no session of the trunk can take them (§13.1), a sorted set
      by arrival; `hs` the trunks that have any, `hl:<customer trunk>` the lock of the node sending them.

  A finished message (every part's final receipt in, the customer's receipt queued) is forgotten at once; one still
  waiting expires after its vendor trunk's DLR timeout plus an hour, so Redis holds only messages waiting for a
  receipt. With `backend: :local` (one server,
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
  @spec record_sent(
          String.t(),
          term(),
          [{part(), integer(), String.t()}],
          pos_integer(),
          non_neg_integer() | nil
        ) :: :ok | {:error, term()}
  def record_sent(message_id, data, parts, ttl_s, timeout_at_ms \\ nil) do
    hash = "m:#{message_id}"
    blob = :erlang.term_to_binary(data, [:compressed])

    commands =
      [
        ["HSET", hash, "d", blob | Enum.flat_map(parts, fn {n, _vt, vid} -> ["s#{n}", vid] end)],
        ["EXPIRE", hash, ttl_s]
      ] ++
        Enum.map(parts, fn {n, vt, vid} ->
          ["SET", "v:#{vt}:#{vid}", "#{message_id}:#{n}", "EX", ttl_s]
        end) ++
        if(timeout_at_ms, do: [["ZADD", "t", timeout_at_ms, message_id]], else: [])

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

    vendor_ids = for {"s" <> n, v} <- fields, into: %{}, do: {String.to_integer(n), v}

    {:ok,
     %{
       data: :erlang.binary_to_term(blob, [:safe]),
       finals: finals,
       vendor_ids: vendor_ids,
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

  @doc "Gives the claim back when the customer's receipt could not be queued, so a retried receipt sends it."
  @spec unclaim_forward(String.t()) :: :ok | {:error, term()}
  def unclaim_forward(message_id), do: ok(run(["HDEL", "m:#{message_id}", "c"]))

  @doc """
  Forgets a finished message (every part has its final receipt and the customer's receipt is queued): its hash and
  its vendor ids. A receipt that comes after is answered OK and not forwarded (S-5.12).
  """
  @spec forget(String.t(), integer(), [String.t()]) :: :ok | {:error, term()}
  def forget(message_id, vendor_trunk_id, vendor_ids) do
    commands =
      [["DEL", "m:#{message_id}"], ["ZREM", "t", message_id]] ++
        Enum.map(vendor_ids, &["DEL", "v:#{vendor_trunk_id}:#{&1}"])

    case backend() do
      :redis -> ok(Redis.transaction(commands, @timeout))
      :local -> ok(local(commands))
    end
  end

  @doc "Up to `limit` messages whose DLR timeout has passed by `now_ms`, earliest first (S-5.10)."
  @spec due_timeouts(non_neg_integer(), pos_integer()) :: {:ok, [String.t()]} | {:error, term()}
  def due_timeouts(now_ms, limit),
    do: run(["ZRANGEBYSCORE", "t", "-inf", now_ms, "LIMIT", 0, limit])

  @doc "Puts a message's DLR timeout (back) on the list, due at `at_ms`."
  @spec schedule_timeout(String.t(), non_neg_integer()) :: :ok | {:error, term()}
  def schedule_timeout(message_id, at_ms), do: ok(run(["ZADD", "t", at_ms, message_id]))

  @doc "Takes a due DLR timeout: true for the one server that gets to handle it."
  @spec claim_timeout(String.t()) :: boolean()
  def claim_timeout(message_id), do: match?({:ok, 1}, run(["ZREM", "t", message_id]))

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

  @doc """
  Holds part `n` of a customer's multipart message in its group until the others come (S-3.2): `{:ok, count}` with the
  parts held now, or `{:duplicate, id}` with the message id the same part got before (S-3.5). The group expires after
  `ttl_s`; its reassembly deadline is `deadline_ms` (set by the first part).
  """
  @spec add_part(String.t(), pos_integer(), String.t(), term(), pos_integer(), non_neg_integer()) ::
          {:ok, pos_integer()} | {:duplicate, String.t()} | {:error, term()}
  def add_part(key, n, id, part, ttl_s, deadline_ms) do
    group = "rg:#{key}"

    with {:ok, 1} <- run(["HSETNX", group, "p#{n}", :erlang.term_to_binary(part, [:compressed])]),
         {:ok, _} <- run(["HSET", group, "i#{n}", id]),
         {:ok, count} <- run(["HINCRBY", group, "count", 1]),
         {:ok, _} <- run(["EXPIRE", group, ttl_s]),
         {:ok, _} <- run(["ZADD", "rgt", "NX", deadline_ms, key]) do
      {:ok, count}
    else
      {:ok, 0} -> duplicate_part(group, n)
      {:error, _} = error -> error
    end
  end

  defp duplicate_part(group, n) do
    case run(["HGET", group, "i#{n}"]) do
      {:ok, id} when is_binary(id) -> {:duplicate, id}
      # The first copy is still being held this instant: the client tries again.
      {:ok, nil} -> {:error, :part_being_held}
      error -> error
    end
  end

  @doc "Gives back part `n` (its message could not be stored): a resend of it is held again."
  @spec drop_part(String.t(), pos_integer()) :: :ok | {:error, term()}
  def drop_part(key, n) do
    group = "rg:#{key}"

    with {:ok, _} <- run(["HDEL", group, "p#{n}"]),
         {:ok, _} <- run(["HDEL", group, "i#{n}"]),
         {:ok, _} <- run(["HINCRBY", group, "count", -1]) do
      :ok
    end
  end

  @doc "Claims a group to assemble or fail it: true for the one caller that gets it."
  @spec claim_group(String.t()) :: boolean()
  def claim_group(key), do: match?({:ok, 1}, run(["HSETNX", "rg:#{key}", "done", "1"]))

  @doc "Gives a group's claim back (its message could not be stored)."
  @spec unclaim_group(String.t()) :: :ok | {:error, term()}
  def unclaim_group(key), do: ok(run(["HDEL", "rg:#{key}", "done"]))

  @doc "The parts held in a group, by part number."
  @spec group_parts(String.t()) :: {:ok, %{pos_integer() => term()}} | {:error, term()}
  def group_parts(key) do
    case run(["HGETALL", "rg:#{key}"]) do
      {:ok, flat} ->
        parts =
          for [k, v] <- Enum.chunk_every(flat, 2),
              String.starts_with?(k, "p"),
              into: %{},
              do:
                {String.to_integer(binary_part(k, 1, byte_size(k) - 1)),
                 :erlang.binary_to_term(v, [:safe])}

        {:ok, parts}

      error ->
        error
    end
  end

  @doc "Removes a group that was assembled or failed; a part that comes later starts a new group (S-3.7)."
  @spec drop_group(String.t()) :: :ok | {:error, term()}
  def drop_group(key) do
    commands = [["DEL", "rg:#{key}"], ["ZREM", "rgt", key]]

    case backend() do
      :redis -> ok(Redis.transaction(commands, @timeout))
      :local -> ok(local(commands))
    end
  end

  @doc "Up to `limit` groups whose reassembly deadline passed by `now_ms` (D1)."
  @spec due_groups(non_neg_integer(), pos_integer()) :: {:ok, [String.t()]} | {:error, term()}
  def due_groups(now_ms, limit),
    do: run(["ZRANGEBYSCORE", "rgt", "-inf", now_ms, "LIMIT", 0, limit])

  @doc "Takes a due group: true for the one server that gets to fail it."
  @spec claim_group_timeout(String.t()) :: boolean()
  def claim_group_timeout(key), do: match?({:ok, 1}, run(["ZREM", "rgt", key]))

  @doc """
  The duplicate filter (D6): records `id` under the message's fingerprint for `ttl_s`, or returns the id of the same
  message seen within the window.
  """
  @spec claim_fingerprint(integer(), String.t(), String.t(), pos_integer()) ::
          :new | {:duplicate, String.t()} | {:error, term()}
  def claim_fingerprint(trunk_id, fingerprint, id, ttl_s) do
    case run(["SET", "dup:#{trunk_id}:#{fingerprint}", id, "NX", "GET", "EX", ttl_s]) do
      {:ok, nil} -> :new
      {:ok, first} -> {:duplicate, first}
      error -> error
    end
  end

  @doc "Forgets a fingerprint (its message was refused, so a resend is a new message)."
  @spec release_fingerprint(integer(), String.t()) :: :ok | {:error, term()}
  def release_fingerprint(trunk_id, fingerprint),
    do: ok(run(["DEL", "dup:#{trunk_id}:#{fingerprint}"]))

  @doc "Marks a message sent to a vendor from customer trunk `trunk_id`, for `ttl_s` (S-5.16)."
  @spec mark_in_flight(String.t(), integer(), pos_integer()) :: :ok | {:error, term()}
  def mark_in_flight(fingerprint, trunk_id, ttl_s),
    do: ok(run(["SET", "lp:#{fingerprint}", Integer.to_string(trunk_id), "EX", ttl_s]))

  @doc "The customer trunk a message with this fingerprint is in flight from, if any."
  @spec in_flight(String.t()) :: {:ok, integer() | nil} | {:error, term()}
  def in_flight(fingerprint) do
    case run(["GET", "lp:#{fingerprint}"]) do
      {:ok, nil} -> {:ok, nil}
      {:ok, trunk} -> {:ok, String.to_integer(trunk)}
      error -> error
    end
  end

  @doc "Claims sending message `id` again for attempt `no` (S-5.11): true for the one handler of the resend."
  @spec claim_resend(String.t(), pos_integer()) :: boolean()
  def claim_resend(id, no),
    do: match?({:ok, "OK"}, run(["SET", "rs:#{id}:#{no}", "1", "NX", "EX", 86_400]))

  @doc """
  Marks a message queued for its vendor (S-2.15, D8): one key per customer message id, under the enterprise, so
  `cancel_sm` and `query_sm` only see the asking customer's own messages. Set before the message goes on the bus.
  """
  @spec mark_queued(integer(), [String.t()], pos_integer()) :: :ok | {:error, term()}
  def mark_queued(enterprise_id, ids, ttl_s) do
    commands = Enum.map(ids, &["SET", "q:#{enterprise_id}:#{&1}", "q", "EX", ttl_s])

    case backend() do
      :redis -> ok(Redis.transaction(commands, @timeout))
      :local -> ok(local(commands))
    end
  end

  @doc """
  Takes the queued marks of a message as the sender picks it up: `:cancelled` when the customer cancelled it (the
  mark stays, for `query_sm`), else `:send`. A mark already gone (a redelivery, or Redis lost it) sends.
  """
  @spec take_queued(integer(), [String.t()], pos_integer()) :: :send | :cancelled
  def take_queued(enterprise_id, ids, keep_s) do
    taken = Enum.map(ids, &run(["GETDEL", "q:#{enterprise_id}:#{&1}"]))

    if Enum.any?(taken, &(&1 == {:ok, "x"})) do
      _ = Enum.map(ids, &run(["SET", "q:#{enterprise_id}:#{&1}", "x", "EX", keep_s]))
      :cancelled
    else
      :send
    end
  end

  @doc "Cancels a queued message (`cancel_sm`): `:ok`, or `:not_queued` when the sender already took it (0x11)."
  @spec cancel_queued(integer(), String.t(), pos_integer()) ::
          :ok | :not_queued | {:error, term()}
  def cancel_queued(enterprise_id, id, keep_s) do
    case run(["SET", "q:#{enterprise_id}:#{id}", "x", "XX", "GET", "EX", keep_s]) do
      {:ok, old} when old in ["q", "x"] -> :ok
      {:ok, _none} -> :not_queued
      error -> error
    end
  end

  @doc "A message's queued mark: `:queued`, `:cancelled` or `:none`."
  @spec queued(integer(), String.t()) :: {:ok, :queued | :cancelled | :none} | {:error, term()}
  def queued(enterprise_id, id) do
    case run(["GET", "q:#{enterprise_id}:#{id}"]) do
      {:ok, "q"} -> {:ok, :queued}
      {:ok, "x"} -> {:ok, :cancelled}
      {:ok, nil} -> {:ok, :none}
      error -> error
    end
  end

  @doc "Forgets the queued marks of a message that did not reach the bus."
  @spec drop_queued(integer(), [String.t()]) :: :ok
  def drop_queued(enterprise_id, ids) do
    Enum.each(ids, &run(["DEL", "q:#{enterprise_id}:#{&1}"]))
  end

  @doc "Remembers the attempt of a part whose submit timed out, for `ttl_s` (D4)."
  @spec put_possibly_sent(String.t(), term(), pos_integer()) :: :ok | {:error, term()}
  def put_possibly_sent(ref, attempt, ttl_s),
    do: ok(run(["SET", "pd:#{ref}", :erlang.term_to_binary(attempt, [:compressed]), "EX", ttl_s]))

  @doc "Takes the attempt of a timed-out part (`ref` is `<message id>:<part>`)."
  @spec take_possibly_sent(String.t()) :: {:ok, term()} | :none | {:error, term()}
  def take_possibly_sent(ref) do
    case run(["GETDEL", "pd:#{ref}"]) do
      {:ok, nil} -> :none
      {:ok, blob} -> {:ok, :erlang.binary_to_term(blob, [:safe])}
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

  @doc false
  # One command on the configured backend, for the ledger (`Sms.Switch.Pipeline.Ledger`).
  @spec command(list()) :: {:ok, term()} | {:error, term()}
  def command(command), do: run(command)

  @doc false
  # Commands as one transaction on the configured backend.
  @spec transaction([list()]) :: {:ok, list()} | {:error, term()}
  def transaction(commands) do
    case backend() do
      :redis -> Redis.transaction(commands, @timeout)
      :local -> local(commands)
    end
  end

  # Sets `total` to the sum of the hash's fields from bucket `cutoff` on, atomically with the charges that add to both.
  @rebase """
  local sum = 0
  local flat = redis.call('HGETALL', KEYS[1])
  for i = 1, #flat, 2 do
    if tonumber(flat[i]) >= tonumber(ARGV[1]) then sum = sum + tonumber(flat[i + 1]) end
  end
  redis.call('SET', KEYS[2], sum)
  return sum
  """

  @doc false
  # The ledger's uninvoiced total from its buckets, after an invoice moved the cut-off (`Sms.Switch.Pipeline.Ledger`).
  @spec rebase(String.t(), String.t(), integer()) :: {:ok, integer()} | {:error, term()}
  def rebase(hash, total, cutoff) do
    case backend() do
      :redis -> Redis.command(["EVAL", @rebase, 2, hash, total, cutoff], @timeout)
      :local -> local_one(["REBASE", hash, total, cutoff])
    end
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

  defp exec(["HDEL", key, field]) do
    hash = get_hash(key)

    if Map.has_key?(hash, field) do
      put(key, Map.delete(hash, field), expiry(key))
      1
    else
      0
    end
  end

  defp exec(["HGET", key, field]), do: Map.get(get_hash(key), field)

  defp exec(["HINCRBY", key, field, by]) do
    hash = get_hash(key)
    value = String.to_integer(Map.get(hash, field, "0")) + by
    put(key, Map.put(hash, field, Integer.to_string(value)), expiry(key))
    value
  end

  defp exec(["ZADD", key, "NX", score, member]) do
    zset = lookup(key) || %{}

    if Map.has_key?(zset, member) do
      0
    else
      put(key, Map.put(zset, member, score), System.monotonic_time(:second) + @far)
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

  defp exec(["SET", key, value, "NX"]) do
    case lookup(key) do
      nil -> put_then(key, value, @far, "OK")
      _ -> nil
    end
  end

  defp exec(["SET", key, value, "NX", "EX", ttl]) do
    case lookup(key) do
      nil -> put_then(key, value, ttl, "OK")
      _ -> nil
    end
  end

  defp exec(["SET", key, value, "XX", "GET", "EX", ttl]) do
    case lookup(key) do
      nil -> nil
      existing -> put_then(key, value, ttl, existing)
    end
  end

  defp exec(["GET", key]), do: lookup(key)

  defp exec(["INCRBY", key, by]) do
    n = String.to_integer(lookup(key) || "0") + by
    put(key, Integer.to_string(n), expiry(key))
    n
  end

  defp exec(["REBASE", hash, total, cutoff]) do
    sum =
      for {bucket, v} <- get_hash(hash), int(bucket) >= cutoff, reduce: 0 do
        acc -> acc + int(v)
      end

    put(total, Integer.to_string(sum), System.monotonic_time(:second) + @far)
    sum
  end

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

  defp exec(["ZRANGEBYSCORE", key, "-inf", max, "LIMIT", offset, count]) do
    (lookup(key) || %{})
    |> Enum.filter(fn {_m, score} -> score <= max end)
    |> Enum.sort_by(fn {m, score} -> {score, m} end)
    |> Enum.map(&elem(&1, 0))
    |> Enum.drop(offset)
    |> Enum.take(count)
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

  defp int(v) when is_integer(v), do: v
  defp int(v), do: String.to_integer(v)

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
