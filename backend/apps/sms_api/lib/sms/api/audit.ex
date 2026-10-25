defmodule Sms.Api.Audit do
  @moduledoc """
  The Audit Trail (§11) for the operations the API answers itself: every call that changes something is recorded
  after its answer, with the user, address, module (the operation's tag), controller (path template), method, action
  (the operation), table, master id, status and duration, as the mock records the calls it answers
  (mock/src/api/audit.ts). Reads are not recorded. Best effort: a failed insert never fails the call.
  """
  require Logger
  alias Sms.Api.{Auth, Operations}
  alias Sms.Core.Repo

  @renames %{
    "me" => "users",
    "session" => "user_sessions",
    "audit-log" => "audit_log",
    "views" => "saved_views"
  }

  @doc "Records the call after it was answered, when it changes something."
  @spec record(Plug.Conn.t(), Operations.t() | nil, pos_integer() | nil, integer()) :: :ok
  def record(_conn, nil, _user_id, _started), do: :ok

  def record(conn, op, user_id, started) do
    _ =
      if conn.method != "GET" and not String.ends_with?(op.path, "/query"),
        do: insert(conn, op, user_id, started)

    :ok
  end

  defp insert(conn, op, user_id, started) do
    first = op.path |> String.split("/", trim: true) |> List.first("")
    table = Map.get(@renames, first, String.replace(first, "-", "_"))
    elapsed = System.convert_time_unit(System.monotonic_time() - started, :native, :millisecond)

    Repo.query!(
      """
      INSERT INTO audit_log (user_id, ip, module, controller, method, action, table_name, master_id, status,
                             duration_ms)
      VALUES ($1, $2::text::inet, $3, $4, $5, $6, $7, $8, $9, $10)
      """,
      [
        user_id,
        Auth.client_ip(conn),
        op.tag || "",
        op.path,
        conn.method,
        op.operation_id,
        table,
        conn.path_params["id"],
        conn.status,
        elapsed
      ]
    )
  rescue
    e -> Logger.warning("audit row not written: #{Exception.message(e)}")
  end
end
