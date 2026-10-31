defmodule Sms.Switch.Pipeline.EdrWriter do
  @moduledoc """
  Writes EDR rows from the bus (`sms.edr.attempt`, `sms.edr.receipt`) to ClickHouse in batches (spec §9.1,
  docs/BACKEND_PLAN.md §3.2). A batch is acknowledged only once stored, so rows wait on the bus while ClickHouse is
  down and are written when it is back (S-7.3, `max_deliver: :infinity`).

  A row is written once even when the bus hands its batch out again (S-7.3, ClickHouse migration 010):

    * each row keeps its bus key as `row_key` (`<edr_id>:<row key on the bus>`), and before inserting, one query per
      batch finds the keys the same days already hold; those rows (and a key seen twice in the batch) are left out;
    * each insert carries an `insert_deduplication_token` made from the bus sequence numbers of its rows, with
      `deduplicate_blocks_in_dependent_materialized_views`, so a batch handed out again while its first insert is
      still running is dropped by ClickHouse, in the table and in the totals its views feed;
    * the ack wait outlasts a batch: its lookup and inserts each have a timeout, and together they end before the
      bus would hand the batch out again.

  A batch ClickHouse refuses because of a value it cannot read is written row by row, and only the rows it still
  refuses for their values are dropped, with an error logged, so one bad row never holds up the rest. Any other
  refusal (a table or column missing, the server out of memory) is retried: nothing is dropped for it.
  """
  @ack_wait_ms 90_000
  @batch_wait_ms 500

  use Sms.Core.Bus.Consumer,
    name: "pipeline-edr-writer",
    filter: "sms.edr.>",
    max_deliver: :infinity,
    ack_wait_ms: @ack_wait_ms,
    batch_size: 1_000,
    batch_wait_ms: @batch_wait_ms

  require Logger
  alias Sms.Core.Bus.Event
  alias Sms.Core.ClickHouse

  @tables %{"edr.attempt" => "edr", "edr.receipt" => "edr_receipt"}

  # The longest the key lookup and one insert may take. A batch is one lookup and an insert per table (two), all done
  # well inside the ack wait, so a slow insert is never handed out again while it is still running (S-7.3).
  @lookup_timeout_ms 10_000
  @insert_timeout_ms 20_000
  @budget_ms @ack_wait_ms - @batch_wait_ms - 5_000

  if @lookup_timeout_ms + 2 * @insert_timeout_ms > @budget_ms,
    do:
      raise(CompileError,
        description: "EdrWriter: a batch's timeouts must end within the ack wait"
      )

  # ClickHouse error codes for a value it cannot read (as `errorCodeToName/1` names them): the row is at fault, not
  # the server or the schema. 6 CANNOT_PARSE_TEXT, 25 CANNOT_PARSE_ESCAPE_SEQUENCE, 26 CANNOT_PARSE_QUOTED_STRING,
  # 27 CANNOT_PARSE_INPUT_ASSERTION_FAILED, 38 CANNOT_PARSE_DATE, 41 CANNOT_PARSE_DATETIME, 53 TYPE_MISMATCH,
  # 69 ARGUMENT_OUT_OF_BOUND, 70 CANNOT_CONVERT_TYPE, 72 CANNOT_PARSE_NUMBER, 130 CANNOT_READ_ARRAY_FROM_TEXT,
  # 131 TOO_LARGE_STRING_SIZE, 321 VALUE_IS_OUT_OF_RANGE_OF_DATA_TYPE, 349 CANNOT_INSERT_NULL_IN_ORDINARY_COLUMN,
  # 376 CANNOT_PARSE_UUID, 467 CANNOT_PARSE_BOOL, 632 UNEXPECTED_DATA_AFTER_PARSED_VALUE, 675 CANNOT_PARSE_IPV4,
  # 676 CANNOT_PARSE_IPV6, 691 UNKNOWN_ELEMENT_OF_ENUM. (117 INCORRECT_DATA is left out: an unknown key is a schema
  # mismatch, retried until the migration is applied.)
  @row_errors [
    6,
    25,
    26,
    27,
    38,
    41,
    53,
    69,
    70,
    72,
    130,
    131,
    321,
    349,
    376,
    467,
    632,
    675,
    676,
    691
  ]

  # A row to write: the columns, and its bus sequence number ("s<n>", or "e<event id>" on the local bus; nil when
  # written directly, without a token).
  @typep entry :: {map(), String.t() | nil}

  @impl true
  def handle_batch(events) do
    deadline = deadline()
    groups = groups(events)

    with {:ok, stored} <- stored_keys(groups, deadline) do
      Enum.reduce_while(groups, :ok, fn {table, entries}, :ok ->
        entries
        |> fresh(table, Map.get(stored, table, MapSet.new()))
        |> write_entries(table, deadline)
        |> continue()
      end)
    end
  end

  defp continue(:ok), do: {:cont, :ok}
  defp continue({:error, _} = error), do: {:halt, error}

  # The batch's rows per table, with their keys as a column; events of an unknown type are dropped.
  defp groups(events) do
    events
    |> Enum.group_by(& &1.type)
    |> Enum.flat_map(fn {type, group} ->
      case Map.fetch(@tables, type) do
        {:ok, table} ->
          [{table, Enum.map(group, &entry/1)}]

        :error ->
          Logger.error("EDR event of unknown type #{inspect(type)} dropped")
          []
      end
    end)
  end

  defp entry(%Event{data: data} = event) do
    seq = if event.seq, do: "s#{event.seq}", else: "e" <> event.id
    {Map.put(data, "row_key", row_key(data)), seq}
  end

  @doc """
  The `row_key` column of a row from the bus: its EDR id and its key on the bus (`Sms.Switch.Pipeline.Edr`: the
  attempt number, or the receipt's kind, part, time and status), empty when it has none.
  """
  @spec row_key(map()) :: String.t()
  def row_key(%{"edr_id" => id, "row_key" => key})
      when is_binary(id) and id != "" and is_binary(key) and key != "",
      do: id <> ":" <> key

  def row_key(_data), do: ""

  @doc """
  The de-duplication token of an insert: the table and a hash of its rows' bus sequence numbers, in any order; nil
  when a row has none (rows written directly).
  """
  @spec token(String.t(), [String.t() | nil]) :: String.t() | nil
  def token(_table, []), do: nil

  def token(table, seqs) do
    if Enum.any?(seqs, &is_nil/1) do
      nil
    else
      hash = :crypto.hash(:sha256, seqs |> Enum.sort() |> Enum.join(","))
      table <> ":" <> Base.encode16(hash, case: :lower)
    end
  end

  # The rows to insert: not stored already, and each key once (rows without a key are all kept).
  defp fresh(entries, table, stored) do
    {kept, _seen} =
      Enum.reduce(entries, {[], MapSet.new()}, fn {row, _seq} = entry, {kept, seen} ->
        key = row["row_key"]

        cond do
          key == "" -> {[entry | kept], seen}
          MapSet.member?(stored, key) or MapSet.member?(seen, key) -> {kept, seen}
          true -> {[entry | kept], MapSet.put(seen, key)}
        end
      end)

    left_out = length(entries) - length(kept)

    if left_out > 0,
      do:
        Logger.info(
          "#{left_out} #{table} rows of the batch are stored already (delivered again), left out"
        )

    Enum.reverse(kept)
  end

  # The keys of the batch the tables already hold, in one query: per table, the rows' days, customer trunks and start
  # times bound the search to the granules those rows would be in (the key alone would read every row of the day).
  defp stored_keys(groups, deadline) do
    parts =
      for {{table, entries}, i} <- Enum.with_index(groups),
          rows = for({row, _} <- entries, lookup?(row), do: row),
          rows != [] do
        times = Enum.map(rows, & &1["start_time"])

        sql = """
        SELECT '#{table}', row_key FROM #{table}
         WHERE toDate(start_time) IN {d#{i}:Array(Date)} AND c_trunk_id IN {c#{i}:Array(UInt32)}
           AND start_time BETWEEN {f#{i}:DateTime64(3, 'UTC')} AND {u#{i}:DateTime64(3, 'UTC')}
           AND row_key IN {k#{i}:Array(String)}
        """

        params = %{
          "d#{i}" => times |> Enum.map(&binary_part(&1, 0, 10)) |> Enum.uniq(),
          "c#{i}" => rows |> Enum.map(& &1["c_trunk_id"]) |> Enum.uniq(),
          "f#{i}" => Enum.min(times),
          "u#{i}" => Enum.max(times),
          "k#{i}" => Enum.map(rows, & &1["row_key"])
        }

        {sql, params}
      end

    lookup(parts, deadline)
  end

  # A row the lookup can find: a key, and the columns that bound the search as the writer's rows carry them.
  defp lookup?(%{
         "row_key" => key,
         "start_time" => <<_day::binary-10, _::binary>>,
         "c_trunk_id" => trunk
       })
       when key != "" and is_integer(trunk) and trunk >= 0,
       do: true

  defp lookup?(_row), do: false

  defp lookup([], _deadline), do: {:ok, %{}}

  defp lookup(parts, deadline) do
    sql = parts |> Enum.map(&elem(&1, 0)) |> Enum.intersperse("UNION ALL\n")
    params = parts |> Enum.map(&elem(&1, 1)) |> Enum.reduce(&Map.merge/2)

    with {:ok, timeout} <- time_left(deadline, @lookup_timeout_ms),
         {:ok, %{rows: rows}} <-
           ClickHouse.query(sql, params, timeout: timeout, multipart: true) do
      {:ok,
       Enum.reduce(rows, %{}, fn [table, key], acc ->
         Map.update(acc, table, MapSet.new([key]), &MapSet.put(&1, key))
       end)}
    else
      {:error, reason} = error ->
        Logger.warning("EDR rows not written yet, retried: key lookup failed: #{inspect(reason)}")
        error
    end
  end

  @doc """
  Writes rows to `table` as the bus's batches are written, without the key lookup (rows written directly carry no
  bus sequence numbers, so no de-duplication token either).
  """
  @spec write(String.t(), [map()]) :: :ok | {:error, term()}
  def write(table, rows), do: write_entries(Enum.map(rows, &{&1, nil}), table, deadline())

  @spec write_entries([entry()], String.t(), integer()) :: :ok | {:error, term()}
  defp write_entries([], _table, _deadline), do: :ok

  defp write_entries(entries, table, deadline) do
    case insert(table, entries, deadline) do
      :ok ->
        :ok

      {:error, %Ch.Error{code: code}} when code in @row_errors and length(entries) > 1 ->
        Logger.warning(
          "ClickHouse refused a batch of #{length(entries)} #{table} rows (code #{code}); writing them one by one"
        )

        one_by_one(table, entries, deadline)

      {:error, %Ch.Error{code: code} = refused} when code in @row_errors ->
        # Only the ids: the row holds the message text.
        [{row, _seq}] = entries
        reason = refused.message |> String.split("\n", trim: true) |> List.last()

        Logger.error(
          "#{table} row of EDR #{row["edr_id"]} dropped, ClickHouse refused it (code #{code}): #{reason}"
        )

        :ok

      {:error, reason} ->
        Logger.warning("EDR rows not written yet, retried: #{inspect(reason)}")
        {:error, reason}
    end
  end

  # Each row with its own token: written again after a failure further on, a row already stored is dropped.
  defp one_by_one(table, entries, deadline) do
    Enum.reduce_while(entries, :ok, fn entry, :ok ->
      case write_entries([entry], table, deadline) do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  defp insert(table, entries, deadline) do
    body = Enum.map(entries, fn {row, _seq} -> [Jason.encode_to_iodata!(row), ?\n] end)
    token = token(table, Enum.map(entries, &elem(&1, 1)))

    # The views drop a block ClickHouse drops (ClickHouse 010): with the token, a batch delivered again; without, an
    # identical block.
    settings =
      [insert_deduplicate: 1, deduplicate_blocks_in_dependent_materialized_views: 1] ++
        if(token, do: [insert_deduplication_token: token], else: [])

    with {:ok, timeout} <- time_left(deadline, @insert_timeout_ms),
         {:ok, _} <-
           ClickHouse.query(["INSERT INTO ", table, " FORMAT JSONEachRow"], body,
             encode: false,
             timeout: timeout,
             settings: settings
           ) do
      :ok
    end
  end

  defp deadline, do: System.monotonic_time(:millisecond) + @budget_ms

  # The time a call may take: its own timeout, or less near the end of the batch's time; none left, the batch is
  # retried (rows stored by then are found by the key lookup).
  defp time_left(deadline, cap) do
    case deadline - System.monotonic_time(:millisecond) do
      left when left >= 1_000 -> {:ok, min(cap, left)}
      _ -> {:error, :out_of_time}
    end
  end
end
