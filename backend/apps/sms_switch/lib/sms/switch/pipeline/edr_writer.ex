defmodule Sms.Switch.Pipeline.EdrWriter do
  @moduledoc """
  Writes EDR rows from the bus (`sms.edr.attempt`, `sms.edr.receipt`) to ClickHouse in batches (spec §9.1,
  docs/BACKEND_PLAN.md §3.2). A batch is acknowledged only once stored, so rows wait on the bus while ClickHouse is
  down and are written when it is back (S-7.3, `max_deliver: :infinity`); a row written twice after such a retry is
  read once (readers take one row per key, `db/clickhouse/migrations/003_edr_receipt.sql`).

  A batch ClickHouse refuses because of a value it cannot read is written row by row, and only the rows it still
  refuses for their values are dropped, with an error logged, so one bad row never holds up the rest. Any other
  refusal (a table or column missing, the server out of memory) is retried: nothing is dropped for it.
  """
  use Sms.Core.Bus.Consumer,
    name: "pipeline-edr-writer",
    filter: "sms.edr.>",
    max_deliver: :infinity,
    ack_wait_ms: 60_000,
    batch_size: 1_000,
    batch_wait_ms: 500

  require Logger
  alias Sms.Core.ClickHouse

  @tables %{"edr.attempt" => "edr", "edr.receipt" => "edr_receipt"}

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

  @impl true
  def handle_batch(events) do
    events
    |> Enum.group_by(& &1.type)
    |> Enum.reduce_while(:ok, fn {type, group}, :ok ->
      case Map.fetch(@tables, type) do
        {:ok, table} ->
          case write(table, Enum.map(group, &row(&1.data))) do
            :ok -> {:cont, :ok}
            {:error, _} = error -> {:halt, error}
          end

        :error ->
          Logger.error("EDR event of unknown type #{inspect(type)} dropped")
          {:cont, :ok}
      end
    end)
  end

  # The bus key is not a column.
  defp row(data), do: Map.drop(data, ["row_key"])

  @doc false
  @spec write(String.t(), [map()]) :: :ok | {:error, term()}
  def write(table, rows) do
    case insert(table, rows) do
      :ok ->
        :ok

      {:error, %Ch.Error{code: code}} when code in @row_errors and length(rows) > 1 ->
        Logger.warning(
          "ClickHouse refused a batch of #{length(rows)} #{table} rows (code #{code}); writing them one by one"
        )

        one_by_one(table, rows)

      {:error, %Ch.Error{code: code} = refused} when code in @row_errors ->
        # Only the ids: the row holds the message text.
        [row] = rows
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

  defp one_by_one(table, rows) do
    Enum.reduce_while(rows, :ok, fn row, :ok ->
      case write(table, [row]) do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  defp insert(table, rows) do
    body = Enum.map(rows, &[Jason.encode_to_iodata!(&1), ?\n])

    case ClickHouse.query(["INSERT INTO ", table, " FORMAT JSONEachRow"], body, encode: false) do
      {:ok, _} -> :ok
      {:error, _} = error -> error
    end
  end
end
