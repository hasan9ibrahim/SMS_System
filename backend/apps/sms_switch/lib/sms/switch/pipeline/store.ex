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
    * `ur:<destination>`: the count the concatenation references of messages split for that handset come from
      (S-3.10);
    * `h:<customer trunk>`: customer receipts held while no session of the trunk can take them (§13.1), a sorted set
      of their keys (message id and status) by arrival, `hd:<customer trunk>` each one's entry; `hs` the trunks that
      have any, `hl:<customer trunk>` the lock of the node sending them;
    * `chh:<account>`: the credit held for each customer message in flight (message id → micro-units, §7, S-6.3),
      `chht:<account>` their total, `hx` when each hold expires (`<account>|<message id>` by Unix ms); read with the
      ledger's `cht:<account>` (`Sms.Switch.Pipeline.Ledger`);
    * SMS to voice (§8, `Sms.Switch.Voice.Calls`): `vp:<message id>:<try>` a call try claimed before it is placed;
      `vr:<message id>` a call's retry waiting for its time, `vr` those retries by time and `vrl` the ones being put
      back on their gateway's queue (leased).

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
    blob = :erlang.term_to_binary(data, compressed: 1)

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

    with {:ok, 1} <- run(["HSETNX", group, "p#{n}", :erlang.term_to_binary(part, compressed: 1)]),
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
  The duplicate filter (D6): claims the message's fingerprint for message `id` while it is decided (for at most
  `ttl_s`, a minute at most), or returns the message that has it: `{:duplicate, id}` once that one was taken
  (`confirm_fingerprint/4`), `{:pending, id}` while it is still being decided.
  """
  @spec claim_fingerprint(integer(), String.t(), String.t(), pos_integer()) ::
          :new | {:duplicate, String.t()} | {:pending, String.t()} | {:error, term()}
  def claim_fingerprint(trunk_id, fingerprint, id, ttl_s) do
    case run([
           "SET",
           "dup:#{trunk_id}:#{fingerprint}",
           "p:" <> id,
           "NX",
           "GET",
           "EX",
           min(ttl_s, 60)
         ]) do
      {:ok, nil} -> :new
      {:ok, "p:" <> first} -> {:pending, first}
      {:ok, first} -> {:duplicate, first}
      error -> error
    end
  end

  @doc "The message that claimed the fingerprint was taken: its copies get its id for the window, `ttl_s` (D6)."
  @spec confirm_fingerprint(integer(), String.t(), String.t(), pos_integer()) ::
          :ok | {:error, term()}
  def confirm_fingerprint(trunk_id, fingerprint, id, ttl_s),
    do: ok(run(["SET", "dup:#{trunk_id}:#{fingerprint}", id, "XX", "GET", "EX", ttl_s]))

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

  @doc """
  The next concatenation reference count for a message the switch splits for `destination` (S-3.10, D2): one count per
  handset, whatever the vendor, kept an hour after its last use, far longer than a message stays open.
  """
  @spec next_reference(String.t()) :: {:ok, pos_integer()} | {:error, term()}
  def next_reference(destination) do
    key = "ur:#{destination}"

    case transaction([["INCRBY", key, 1], ["EXPIRE", key, 3_600]]) do
      {:ok, [n, _]} when is_integer(n) -> {:ok, n}
      {:ok, other} -> {:error, {:unexpected_reply, other}}
      {:error, _} = error -> error
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
    do: ok(run(["SET", "pd:#{ref}", :erlang.term_to_binary(attempt, compressed: 1), "EX", ttl_s]))

  @doc "Takes the attempt of a timed-out part (`ref` is `<message id>:<part>`)."
  @spec take_possibly_sent(String.t()) :: {:ok, term()} | :none | {:error, term()}
  def take_possibly_sent(ref) do
    case run(["GETDEL", "pd:#{ref}"]) do
      {:ok, nil} -> :none
      {:ok, blob} -> {:ok, :erlang.binary_to_term(blob, [:safe])}
      error -> error
    end
  end

  @doc """
  Holds a customer receipt until a session of the trunk can take it (§13.1). `key` names the receipt (its message id
  and status): one already held under it stays as it is, so a copy delivered again by the bus is never held twice
  (S-5.14). Without a key the entry itself is its key.
  """
  @spec hold(integer(), term(), pos_integer(), String.t() | nil) :: :ok | {:error, term()}
  def hold(trunk_id, entry, at_ms, key \\ nil) do
    member = key || entry |> :erlang.term_to_binary([:deterministic]) |> held_key()

    commands = [
      ["HSETNX", "hd:#{trunk_id}", member, :erlang.term_to_binary(entry)],
      ["ZADD", "h:#{trunk_id}", "NX", at_ms, member],
      ["SADD", "hs", "#{trunk_id}"]
    ]

    case backend() do
      :redis -> ok(Redis.transaction(commands, @timeout))
      :local -> ok(local(commands))
    end
  end

  defp held_key(bytes),
    do: :crypto.hash(:sha256, bytes) |> binary_part(0, 16) |> Base.url_encode64(padding: false)

  @doc "Replaces a held receipt's entry (tried again later, S-5.14); it keeps its place."
  @spec update_held(integer(), binary(), term()) :: :ok | {:error, term()}
  def update_held(trunk_id, member, entry),
    do: ok(run(["HSET", "hd:#{trunk_id}", member, :erlang.term_to_binary(entry)]))

  @doc "The trunks with held receipts."
  @spec held_trunks() :: {:ok, [integer()]} | {:error, term()}
  def held_trunks do
    case run(["SMEMBERS", "hs"]) do
      {:ok, ids} -> {:ok, Enum.map(ids, &String.to_integer/1)}
      error -> error
    end
  end

  @doc """
  Up to `limit` held receipts of a trunk from the `offset`-th, oldest first, each with the stored member to release it
  by (nil for an entry that can no longer be read).
  """
  @spec held(integer(), pos_integer(), non_neg_integer()) ::
          {:ok, [{binary(), term() | nil}]} | {:error, term()}
  def held(trunk_id, limit, offset \\ 0) do
    with {:ok, members} <- run(["ZRANGE", "h:#{trunk_id}", offset, offset + limit - 1]),
         {:ok, blobs} <- held_entries(trunk_id, members) do
      {:ok, Enum.zip_with(members, blobs, &{&1, held_entry(&1, &2)})}
    end
  end

  defp held_entries(_trunk_id, []), do: {:ok, []}

  defp held_entries(trunk_id, members),
    do: transaction(for m <- members, do: ["HGET", "hd:#{trunk_id}", m])

  defp held_entry(_member, blob) when is_binary(blob), do: :erlang.binary_to_term(blob, [:safe])

  # A receipt held before entries had their own hash was its own member.
  defp held_entry(member, nil) do
    :erlang.binary_to_term(member, [:safe])
  rescue
    ArgumentError -> nil
  end

  @doc "Removes a held receipt (sent or given up); a trunk left with none leaves `hs`."
  @spec release(integer(), binary()) :: :ok | {:error, term()}
  def release(trunk_id, member) do
    key = "h:#{trunk_id}"

    # A receipt held between the count and the SREM is seen by the second count, and the trunk goes back in `hs`.
    with {:ok, _} <- run(["ZREM", key, member]),
         {:ok, _} <- run(["HDEL", "hd:#{trunk_id}", member]),
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

  @sum_from """
  local sum = 0
  local flat = redis.call('HGETALL', KEYS[1])
  for i = 1, #flat, 2 do
    if tonumber(flat[i]) >= tonumber(ARGV[1]) then sum = sum + tonumber(flat[i + 1]) end
  end
  return sum
  """

  @doc false
  # The sum of a bucket hash's fields from bucket `from` on (`Sms.Switch.Pipeline.Revenue`).
  @spec sum_from(String.t(), integer()) :: {:ok, integer()} | {:error, term()}
  def sum_from(hash, from) do
    case backend() do
      :redis -> Redis.command(["EVAL", @sum_from, 1, hash, from], @timeout)
      :local -> local_one(["SUMFROM", hash, from])
    end
  end

  # ---------------------------------------------------------------- credit holds (§7, Q24, S-6.3)

  # The credit check and the hold of a message's cost in one step, so two messages near the limit never both pass
  # (`Sms.Switch.Pipeline.Ledger.reserve/1`). KEYS: the account's uninvoiced total (`cht:`), its holds by message id
  # (`chh:`), their total (`chht:`) and the expiry list (`hx`); ARGV: message id, cost, base + credit limit, expiry
  # (Unix ms) and the expiry list's member. Answers {1 held | 2 held already | 0 refused, used, held}.
  @reserve_credit """
  local used = tonumber(redis.call('GET', KEYS[1]) or '0')
  local held = tonumber(redis.call('GET', KEYS[3]) or '0')
  if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then return {2, used, held} end
  local cost = tonumber(ARGV[2])
  if cost > tonumber(ARGV[3]) - used - held then return {0, used, held} end
  redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
  redis.call('INCRBY', KEYS[3], ARGV[2])
  redis.call('ZADD', KEYS[4], ARGV[4], ARGV[5])
  return {1, used, held + cost}
  """

  # Releases a message's hold, once (a second release finds none). KEYS: `chh:`, `chht:`, `hx`; ARGV: message id, the
  # expiry list's member and, for the expiry sweep, the time the hold must have expired by ('' otherwise: a hold
  # extended since it was listed stays). Answers the amount released.
  @release_credit """
  if ARGV[3] ~= '' then
    local at = redis.call('ZSCORE', KEYS[3], ARGV[2])
    if at and tonumber(at) > tonumber(ARGV[3]) then return 0 end
  end
  redis.call('ZREM', KEYS[3], ARGV[2])
  local amount = redis.call('HGET', KEYS[1], ARGV[1])
  if not amount then return 0 end
  redis.call('HDEL', KEYS[1], ARGV[1])
  if redis.call('DECRBY', KEYS[2], amount) < 0 then redis.call('SET', KEYS[2], 0) end
  return tonumber(amount)
  """

  @doc false
  # Checks a message's cost against `available` (base + credit limit) less what is charged and held, and holds it in the
  # same step (`Sms.Switch.Pipeline.Ledger`). Holding the same message again changes nothing.
  @spec reserve_credit(String.t(), String.t(), integer(), integer(), integer()) ::
          {:ok, :held | :already | :refused, integer(), integer()} | {:error, term()}
  def reserve_credit(account, id, cost, available, expires_ms) do
    keys = ["cht:#{account}", "chh:#{account}", "chht:#{account}", "hx"]
    args = [id, cost, available, expires_ms, hold_member(account, id)]

    result =
      case backend() do
        :redis -> Redis.command(["EVAL", @reserve_credit, 4 | keys ++ args], @timeout)
        :local -> local_one(["RESERVE" | keys ++ args])
      end

    case result do
      {:ok, [code, used, held]} -> {:ok, Enum.at([:refused, :held, :already], code), used, held}
      {:error, _} = error -> error
    end
  end

  @doc false
  # The command releasing a message's hold, for a transaction (the charge that replaces it, `Ledger.apply_charge/1`).
  @spec release_credit_command(String.t(), String.t(), integer() | nil) :: list()
  def release_credit_command(account, id, due_ms \\ nil) do
    keys = ["chh:#{account}", "chht:#{account}", "hx"]
    args = [id, hold_member(account, id), if(due_ms, do: due_ms, else: "")]

    case backend() do
      :redis -> ["EVAL", @release_credit, 3 | keys ++ args]
      :local -> ["UNHOLD" | keys ++ args]
    end
  end

  @doc false
  # Releases a message's hold: the amount released (0 when there was none). With `due_ms`, only a hold whose expiry
  # passed by then (the expiry sweep).
  @spec release_credit(String.t(), String.t(), integer() | nil) ::
          {:ok, integer()} | {:error, term()}
  def release_credit(account, id, due_ms \\ nil),
    do: run(release_credit_command(account, id, due_ms))

  @doc false
  # Moves a hold's expiry (the message was sent: its receipt timeout counts from now); a hold released already stays
  # released.
  @spec extend_credit_hold(String.t(), String.t(), integer()) :: :ok | {:error, term()}
  def extend_credit_hold(account, id, expires_ms),
    do: ok(run(["ZADD", "hx", "XX", expires_ms, hold_member(account, id)]))

  @doc false
  # Up to `limit` holds whose expiry passed by `now_ms`, as {account, message id}.
  @spec due_credit_holds(integer(), pos_integer()) ::
          {:ok, [{String.t(), String.t()}]} | {:error, term()}
  def due_credit_holds(now_ms, limit) do
    case run(["ZRANGEBYSCORE", "hx", "-inf", now_ms, "LIMIT", 0, limit]) do
      {:ok, members} ->
        {:ok,
         for(m <- members, [account, id] = String.split(m, "|", parts: 2), do: {account, id})}

      error ->
        error
    end
  end

  @doc false
  # What is held on each account (micro-units), in one round trip.
  @spec credit_held([String.t()]) :: {:ok, %{String.t() => integer()}} | {:error, term()}
  def credit_held([]), do: {:ok, %{}}

  def credit_held(accounts) do
    case run(["MGET" | Enum.map(accounts, &"chht:#{&1}")]) do
      {:ok, values} -> {:ok, accounts |> Enum.zip(Enum.map(values, &int_or_zero/1)) |> Map.new()}
      error -> error
    end
  end

  defp hold_member(account, id), do: "#{account}|#{id}"

  # ---------------------------------------------------------------- scheduled messages (S-2.12)

  # Moves a member from one sorted set to another (or the same) when its score is due: one server takes each.
  # KEYS: from, to; ARGV: member, now (Unix ms), the new score.
  @move_due """
  local at = redis.call('ZSCORE', KEYS[1], ARGV[1])
  if at and tonumber(at) <= tonumber(ARGV[2]) then
    redis.call('ZREM', KEYS[1], ARGV[1])
    redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
    return 1
  end
  return 0
  """

  @doc false
  # Holds a scheduled message until `at_ms` (`Sms.Switch.Pipeline.Scheduled`): `sch:<id>` its data, enterprise and
  # customer message ids, `sp:<enterprise>:<customer id>` the way query_sm and cancel_sm find it, `sch` the sorted set
  # by its time. Kept `ttl_s` at most.
  @spec schedule(String.t(), integer(), [String.t()], binary(), integer(), pos_integer()) ::
          :ok | {:error, term()}
  def schedule(id, enterprise_id, ids, blob, at_ms, ttl_s) do
    key = "sch:#{id}"

    commands =
      [
        ["HSET", key, "m", blob, "e", Integer.to_string(enterprise_id), "i", Enum.join(ids, ",")],
        ["EXPIRE", key, ttl_s]
      ] ++
        Enum.map(ids, &["SET", "sp:#{enterprise_id}:#{&1}", id, "EX", ttl_s]) ++
        [["ZADD", "sch", at_ms, id]]

    ok(transaction(commands))
  end

  @doc false
  # Up to `limit` scheduled messages due by `now_ms` (`:waiting`), or being released with a lease that ran out by then
  # (`:leased`: the server releasing them stopped).
  @spec due_scheduled(:waiting | :leased, integer(), pos_integer()) ::
          {:ok, [String.t()]} | {:error, term()}
  def due_scheduled(set, now_ms, limit),
    do: run(["ZRANGEBYSCORE", scheduled_set(set), "-inf", now_ms, "LIMIT", 0, limit])

  @doc false
  # Takes a due scheduled message to release it: true for the one server that gets it. It stays leased until
  # `lease_until_ms` (`finish_scheduled/3` ends the lease), so a server stopping mid-release never loses it.
  @spec claim_scheduled(:waiting | :leased, String.t(), integer(), integer()) :: boolean()
  def claim_scheduled(set, id, now_ms, lease_until_ms) do
    keys = [scheduled_set(set), "schl"]

    command =
      case backend() do
        :redis -> ["EVAL", @move_due, 2 | keys ++ [id, now_ms, lease_until_ms]]
        :local -> ["ZMOVE" | keys ++ [id, now_ms, lease_until_ms]]
      end

    match?({:ok, 1}, run(command))
  end

  defp scheduled_set(:waiting), do: "sch"
  defp scheduled_set(:leased), do: "schl"

  # A message waiting for its trunk's TPS is due already: taken whatever the time.
  @any_time 9_000_000_000_000_000

  # Moves a leased message to its trunk's waiting set (S-2.12, S-2.4) while the lease is still this server's. KEYS: the
  # leases, the trunk's waiting set, the set of trunks with any, the message's hash, then its query keys; ARGV: member,
  # lease, its time (the score), trunk, how long its keys are kept (s).
  @defer_scheduled """
  local lease = redis.call('ZSCORE', KEYS[1], ARGV[1])
  if lease and tonumber(lease) == tonumber(ARGV[2]) then
    redis.call('ZREM', KEYS[1], ARGV[1])
    redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
    redis.call('SADD', KEYS[3], ARGV[4])
    if redis.call('EXISTS', KEYS[4]) == 1 then redis.call('HSET', KEYS[4], 't', ARGV[4]) end
    for i = 4, #KEYS do redis.call('EXPIRE', KEYS[i], ARGV[5]) end
    return 1
  end
  return 0
  """

  # Drops a trunk from the trunks with waiting messages once it has none. KEYS: its waiting set, the trunks; ARGV:
  # the trunk.
  @forget_waiting """
  if redis.call('ZCARD', KEYS[1]) == 0 then
    redis.call('SREM', KEYS[2], ARGV[1])
    return 1
  end
  return 0
  """

  @doc false
  # S-2.12, S-2.4: a due message its customer trunk cannot take now (its TPS used, its overflow buffer full or none)
  # waits in the trunk's own set (`schq:<trunk>`, by its time; `schq` the trunks with any) instead of the shared one,
  # so a sweep never reads again what the trunk cannot take. Only while this server's lease (`lease_until_ms`) is still
  # on it (`false` otherwise: another server took it over); its keys are then kept `keep_s`.
  @spec defer_scheduled(
          String.t(),
          integer(),
          integer(),
          integer(),
          integer(),
          [String.t()],
          pos_integer()
        ) :: boolean() | {:error, term()}
  def defer_scheduled(id, trunk_id, at_ms, lease_until_ms, enterprise_id, ids, keep_s) do
    keys =
      ["schl", "schq:#{trunk_id}", "schq", "sch:#{id}"] ++
        Enum.map(ids, &"sp:#{enterprise_id}:#{&1}")

    args = [id, lease_until_ms, at_ms, Integer.to_string(trunk_id), keep_s]

    command =
      case backend() do
        :redis -> ["EVAL", @defer_scheduled, length(keys) | keys ++ args]
        :local -> ["SCHDEFER", keys, args]
      end

    case run(command) do
      {:ok, n} -> n == 1
      error -> error
    end
  end

  @doc false
  # The customer trunks with messages waiting for their TPS.
  @spec waiting_trunks() :: {:ok, [integer()]} | {:error, term()}
  def waiting_trunks do
    with {:ok, members} <- run(["SMEMBERS", "schq"]), do: {:ok, Enum.map(members, &int/1)}
  end

  @doc false
  # Up to `limit` of a trunk's waiting messages, the earliest first.
  @spec waiting_scheduled(integer(), pos_integer()) :: {:ok, [String.t()]} | {:error, term()}
  def waiting_scheduled(trunk_id, limit), do: run(["ZRANGE", "schq:#{trunk_id}", 0, limit - 1])

  @doc false
  # Takes a trunk's waiting message to release it, leased as `claim_scheduled/4` does: true for the one server that
  # gets it.
  @spec claim_waiting(integer(), String.t(), integer()) :: boolean()
  def claim_waiting(trunk_id, id, lease_until_ms) do
    keys = ["schq:#{trunk_id}", "schl"]

    command =
      case backend() do
        :redis -> ["EVAL", @move_due, 2 | keys ++ [id, @any_time, lease_until_ms]]
        :local -> ["ZMOVE" | keys ++ [id, @any_time, lease_until_ms]]
      end

    match?({:ok, 1}, run(command))
  end

  @doc false
  # Forgets a trunk without waiting messages (a message deferred meanwhile keeps it).
  @spec forget_waiting(integer()) :: :ok | {:error, term()}
  def forget_waiting(trunk_id) do
    keys = ["schq:#{trunk_id}", "schq"]

    command =
      case backend() do
        :redis -> ["EVAL", @forget_waiting, 2 | keys ++ [Integer.to_string(trunk_id)]]
        :local -> ["SCHQFORGET" | keys ++ [Integer.to_string(trunk_id)]]
      end

    ok(run(command))
  end

  @doc false
  # A scheduled message's data, enterprise and customer message ids.
  @spec scheduled(String.t()) ::
          {:ok, %{blob: binary(), enterprise_id: integer(), ids: [String.t()]}}
          | :none
          | {:error, term()}
  def scheduled(id) do
    case run(["HGETALL", "sch:#{id}"]) do
      {:ok, []} ->
        :none

      {:ok, flat} ->
        f = flat |> Enum.chunk_every(2) |> Map.new(fn [k, v] -> {k, v} end)
        {:ok, %{blob: f["m"], enterprise_id: int(f["e"]), ids: String.split(f["i"] || id, ",")}}

      error ->
        error
    end
  end

  @doc false
  # Forgets a scheduled message that was released (or is gone): its data, its query keys and its lease.
  @spec finish_scheduled(String.t(), integer() | nil, [String.t()]) :: :ok | {:error, term()}
  def finish_scheduled(id, enterprise_id, ids) do
    commands =
      [["DEL", "sch:#{id}"], ["ZREM", "schl", id]] ++
        Enum.map(ids, &["DEL", "sp:#{enterprise_id}:#{&1}"])

    ok(transaction(commands))
  end

  @doc false
  # The scheduled message a customer message id of the enterprise belongs to, while it is held.
  @spec scheduled_id(integer(), String.t()) :: {:ok, String.t() | nil} | {:error, term()}
  def scheduled_id(enterprise_id, customer_id),
    do: run(["GET", "sp:#{enterprise_id}:#{customer_id}"])

  @doc false
  # Takes a scheduled message out before its release (cancel_sm), also while it waits for its trunk's TPS: its data, or
  # `:none` when a server is releasing it already or it is gone.
  @spec take_scheduled(String.t()) ::
          {:ok, %{blob: binary(), enterprise_id: integer(), ids: [String.t()]}}
          | :none
          | {:error, term()}
  def take_scheduled(id) do
    case run(["ZREM", "sch", id]) do
      {:ok, 1} -> taken_scheduled(id)
      {:ok, 0} -> take_waiting(id)
      error -> error
    end
  end

  # Its trunk is on its hash once it waits (`defer_scheduled/7`).
  defp take_waiting(id) do
    case run(["HGET", "sch:#{id}", "t"]) do
      {:ok, nil} ->
        :none

      {:ok, trunk} ->
        case run(["ZREM", "schq:#{trunk}", id]) do
          {:ok, 1} -> taken_scheduled(id)
          {:ok, 0} -> :none
          error -> error
        end

      error ->
        error
    end
  end

  defp taken_scheduled(id) do
    with {:ok, held} <- scheduled(id) do
      _ = finish_scheduled(id, held.enterprise_id, held.ids)
      {:ok, held}
    end
  end

  @doc false
  # Marks a message's ids cancelled for query_sm (DELETED), for `keep_s`.
  @spec mark_cancelled(integer(), [String.t()], pos_integer()) :: :ok | {:error, term()}
  def mark_cancelled(enterprise_id, ids, keep_s),
    do: ok(transaction(Enum.map(ids, &["SET", "q:#{enterprise_id}:#{&1}", "x", "EX", keep_s])))

  defp int_or_zero(nil), do: 0
  defp int_or_zero(v), do: int(v)

  @doc false
  # A plain counter (`Sms.Switch.Pipeline.Warmup`): its value, 0 when missing.
  @spec counter(String.t()) :: {:ok, integer()} | {:error, term()}
  def counter(key) do
    case run(["GET", key]) do
      {:ok, nil} -> {:ok, 0}
      {:ok, n} when is_integer(n) -> {:ok, n}
      {:ok, n} -> {:ok, String.to_integer(n)}
      error -> error
    end
  end

  @doc false
  # Adds `by` to a counter kept `ttl_s` seconds.
  @spec add(String.t(), integer(), pos_integer()) :: :ok | {:error, term()}
  def add(key, by, ttl_s) do
    with {:ok, _} <- run(["INCRBY", key, by]), do: ok(run(["EXPIRE", key, ttl_s]))
  end

  # ---------------------------------------------------------------- SMS to voice (§8)

  @doc false
  # Claims a call try (`<message id>:<try>`) before it is placed, so a queue entry handed out again (a server that
  # stopped, or a call longer than the queue's ack wait) never calls the person twice: true for the first claim. Kept
  # `ttl_s`. Without Redis the call is placed (a second call is better than none).
  @spec claim_voice_call(String.t(), pos_integer()) :: boolean()
  def claim_voice_call(key, ttl_s) do
    case run(["SET", "vp:#{key}", Atom.to_string(node()), "NX", "EX", ttl_s]) do
      {:ok, nil} -> false
      _ -> true
    end
  end

  @doc false
  # Gives a claim back: the try was not placed after all (Asterisk was not connected), so its entry can run again.
  @spec unclaim_voice_call(String.t()) :: :ok | {:error, term()}
  def unclaim_voice_call(key), do: ok(run(["DEL", "vp:#{key}"]))

  @doc false
  # Holds a call's retry until `at_ms` (`vr:<id>` its data, `vr` the sorted set by time), kept `ttl_s` at most.
  @spec hold_voice_retry(String.t(), binary(), integer(), pos_integer()) :: :ok | {:error, term()}
  def hold_voice_retry(id, blob, at_ms, ttl_s),
    do: ok(transaction([["SET", "vr:#{id}", blob, "EX", ttl_s], ["ZADD", "vr", at_ms, id]]))

  @doc false
  # Up to `limit` retries due by `now_ms` (`:waiting`), or taken with a lease that ran out by then (`:leased`).
  @spec due_voice_retries(:waiting | :leased, integer(), pos_integer()) ::
          {:ok, [String.t()]} | {:error, term()}
  def due_voice_retries(set, now_ms, limit),
    do: run(["ZRANGEBYSCORE", voice_set(set), "-inf", now_ms, "LIMIT", 0, limit])

  @doc false
  # Takes a due retry, leased until `lease_until_ms` (as `claim_scheduled/4`): true for the one server that gets it.
  @spec claim_voice_retry(:waiting | :leased, String.t(), integer(), integer()) :: boolean()
  def claim_voice_retry(set, id, now_ms, lease_until_ms) do
    keys = [voice_set(set), "vrl"]

    command =
      case backend() do
        :redis -> ["EVAL", @move_due, 2 | keys ++ [id, now_ms, lease_until_ms]]
        :local -> ["ZMOVE" | keys ++ [id, now_ms, lease_until_ms]]
      end

    match?({:ok, 1}, run(command))
  end

  @doc false
  # A held retry's data.
  @spec voice_retry(String.t()) :: {:ok, binary() | nil} | {:error, term()}
  def voice_retry(id), do: run(["GET", "vr:#{id}"])

  @doc false
  # Forgets a retry that went back on its gateway's queue (or is gone).
  @spec finish_voice_retry(String.t()) :: :ok | {:error, term()}
  def finish_voice_retry(id), do: ok(transaction([["DEL", "vr:#{id}"], ["ZREM", "vrl", id]]))

  defp voice_set(:waiting), do: "vr"
  defp voice_set(:leased), do: "vrl"

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

  defp exec(["SET", key, value]), do: put_then(key, value, @far, "OK")

  defp exec(["SET", key, value, "GET"]) do
    old = lookup(key)
    put_then(key, value, @far, old)
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
  defp exec(["MGET" | keys]), do: Enum.map(keys, &lookup/1)

  defp exec(["INCRBY", key, by]) do
    n = String.to_integer(lookup(key) || "0") + by
    put(key, Integer.to_string(n), expiry(key))
    n
  end

  defp exec(["SUMFROM", hash, from]) do
    for {bucket, v} <- get_hash(hash), int(bucket) >= from, reduce: 0 do
      acc -> acc + int(v)
    end
  end

  defp exec(["REBASE", hash, total, cutoff]) do
    sum =
      for {bucket, v} <- get_hash(hash), int(bucket) >= cutoff, reduce: 0 do
        acc -> acc + int(v)
      end

    put(total, Integer.to_string(sum), System.monotonic_time(:second) + @far)
    sum
  end

  # The credit hold scripts (`@reserve_credit`, `@release_credit`), run as one step under the table's process.
  defp exec([
         "RESERVE",
         total,
         holds,
         held_total,
         expiries,
         id,
         cost,
         available,
         expires_ms,
         member
       ]) do
    used = int_or_zero(lookup(total))
    held = int_or_zero(lookup(held_total))

    cond do
      Map.has_key?(get_hash(holds), id) ->
        [2, used, held]

      cost > available - used - held ->
        [0, used, held]

      true ->
        exec(["HSET", holds, id, Integer.to_string(cost)])
        exec(["INCRBY", held_total, cost])
        exec(["ZADD", expiries, expires_ms, member])
        [1, used, held + cost]
    end
  end

  defp exec(["UNHOLD", holds, held_total, expiries, id, member, due]) do
    at = Map.get(lookup(expiries) || %{}, member)

    if due != "" and at != nil and at > due do
      0
    else
      exec(["ZREM", expiries, member])
      unhold(holds, held_total, Map.get(get_hash(holds), id), id)
    end
  end

  # `@move_due`.
  defp exec(["ZMOVE", from, to, member, now, score]) do
    case Map.get(lookup(from) || %{}, member) do
      at when is_integer(at) and at <= now ->
        exec(["ZREM", from, member])
        exec(["ZADD", to, score, member])
        1

      _ ->
        0
    end
  end

  # `@defer_scheduled`.
  defp exec([
         "SCHDEFER",
         [leases, queue, trunks, hash | _] = keys,
         [id, lease, at, trunk, keep_s]
       ]) do
    if Map.get(lookup(leases) || %{}, id) == lease do
      exec(["ZREM", leases, id])
      exec(["ZADD", queue, at, id])
      exec(["SADD", trunks, trunk])
      if lookup(hash), do: exec(["HSET", hash, "t", trunk])
      keys |> Enum.drop(3) |> Enum.each(&exec(["EXPIRE", &1, keep_s]))
      1
    else
      0
    end
  end

  # `@forget_waiting`.
  defp exec(["SCHQFORGET", queue, trunks, trunk]) do
    if map_size(lookup(queue) || %{}) == 0 do
      exec(["SREM", trunks, trunk])
      1
    else
      0
    end
  end

  defp exec(["ZADD", key, "XX", score, member]) do
    zset = lookup(key) || %{}

    if Map.has_key?(zset, member) do
      put(key, Map.put(zset, member, score), System.monotonic_time(:second) + @far)
    end

    0
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

  # The local `UNHOLD`: a message's hold out of the hash and the total.
  defp unhold(_holds, _held_total, nil, _id), do: 0

  defp unhold(holds, held_total, amount, id) do
    exec(["HDEL", holds, id])
    if exec(["INCRBY", held_total, -int(amount)]) < 0, do: exec(["SET", held_total, "0"])
    int(amount)
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
