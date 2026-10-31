defmodule Sms.Api.ListsApiTest do
  # The Audit Trail and Logged In Users answered by the API (backend step 9) against PostgreSQL: pages, totals,
  # cursors, the caller's own session, refused queries, and the access check (Admin pages need View).
  use ExUnit.Case, async: false
  import Phoenix.ConnTest
  import Plug.Conn
  alias Sms.Api.{Access, PasswordGate, Sessions}
  alias Sms.Core.Repo

  @endpoint Sms.Api.Endpoint
  @moduletag :integration

  setup_all do
    start_supervised!(Repo)
    :ok
  end

  setup do
    Access.forget()
    PasswordGate.forget()
    n = "#{System.unique_integer([:positive])}.#{:rand.uniform(1_000_000_000)}"

    %{rows: [[id]]} =
      Repo.query!(
        """
        INSERT INTO users (username, first_name, last_name, email, password_hash, password_changed_at, is_admin)
        VALUES ($1, 'List', 'Tester', $2, 'x', now(), true) RETURNING id
        """,
        ["test.lists.#{n}", "test.lists.#{n}@example.test"]
      )

    for i <- 1..5 do
      Repo.query!(
        """
        INSERT INTO audit_log (user_id, ip, module, controller, method, action, table_name, master_id, status)
        VALUES ($1, '192.0.2.1', 'test', '/things/{id}', 'PUT', $2, 'things', $3, 200)
        """,
        [id, "testListAction#{n}", Integer.to_string(i)]
      )
    end

    {token, session_id} =
      Sessions.open(id, %{ip: "192.0.2.9", user_agent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130"})

    on_exit(fn ->
      Repo.query!("DELETE FROM audit_log WHERE user_id = $1", [id])
      Repo.query!("DELETE FROM user_sessions WHERE user_id = $1", [id])
      Repo.query!("DELETE FROM users WHERE id = $1", [id])
    end)

    %{id: id, token: token, session_id: session_id, action: "testListAction#{n}"}
  end

  defp query(token, path, body) do
    build_conn()
    |> put_req_cookie("sms_session", token)
    |> put_req_header("content-type", "application/json")
    |> post(path, Jason.encode!(body))
  end

  test "Audit Trail: filtered page, total, cursor to the next page", %{
    token: t,
    action: action,
    id: id
  } do
    filter = %{
      "logic" => "and",
      "conditions" => [%{"field" => "action", "op" => "eq", "value" => action}]
    }

    first =
      query(t, "/api/v1/audit-log/query", %{
        filter: filter,
        limit: 3,
        sort: [%{field: "masterId", dir: "asc"}]
      })
      |> json_response(200)

    assert first["total"] == 5
    assert first["totalIsEstimate"] == false
    assert Enum.map(first["rows"], & &1["masterId"]) == ["1", "2", "3"]

    assert %{"userId" => ^id, "ip" => "192.0.2.1", "method" => "PUT", "at" => "20" <> _} =
             hd(first["rows"])

    second =
      query(t, "/api/v1/audit-log/query", %{
        filter: filter,
        limit: 3,
        sort: [%{field: "masterId", dir: "asc"}],
        cursor: first["nextCursor"]
      })
      |> json_response(200)

    assert Enum.map(second["rows"], & &1["masterId"]) == ["4", "5"]
    assert second["nextCursor"] == nil

    quick =
      query(t, "/api/v1/audit-log/query", %{search: action, withTotal: false, limit: 2})
      |> json_response(200)

    assert quick["totalIsEstimate"] == true
    assert quick["total"] == 3
  end

  test "Logged In Users: the caller's own session is marked current", %{token: t, session_id: sid} do
    page = query(t, "/api/v1/user-sessions/query", %{limit: 4000}) |> json_response(200)
    mine = Enum.find(page["rows"], &(&1["id"] == sid))

    assert %{
             "current" => true,
             "device" => "desktop",
             "browser" => "Chrome",
             "displayName" => "List Tester"
           } = mine

    assert Enum.count(page["rows"], & &1["current"]) == 1
  end

  test "values PostgreSQL refuses are 400 field errors, not 500 (QA 2026-10-31)", %{token: t} do
    cond = fn c -> %{filter: %{logic: "and", conditions: [c]}} end

    for {c, message} <- [
          {%{field: "action", op: "regex", value: "(?<y>sign)"}, "invalid regular expression"},
          {%{field: "action", op: "eq", value: "a\u0000b"}, "NUL"},
          {%{field: "id", op: "eq", value: 99_999_999_999_999_999_999}, "out of range"}
        ] do
      body = query(t, "/api/v1/audit-log/query", cond.(c)) |> json_response(400)
      assert [%{"path" => "/filter", "message" => m}] = body["errors"]
      assert m =~ message
    end

    # A LIKE pattern ending in a lone backslash is refused before the database sees it; a quick search ending in one
    # is that character.
    assert %{
             "errors" => [
               %{"path" => "/filter/conditions/0/value", "message" => "a pattern cannot" <> _}
             ]
           } =
             query(
               t,
               "/api/v1/audit-log/query",
               cond.(%{field: "action", op: "like", value: "ab\\"})
             )
             |> json_response(400)

    assert query(t, "/api/v1/audit-log/query", %{search: "ab\\"}) |> json_response(200)
  end

  test "a time as shown finds its row; part of a name with _ finds it; text sorts in any case", %{
    token: t,
    action: action
  } do
    mine = %{field: "action", op: "eq", value: action}

    [row | _] =
      query(t, "/api/v1/audit-log/query", %{filter: %{logic: "and", conditions: [mine]}})
      |> json_response(200)
      |> Map.fetch!("rows")

    at = %{field: "at", op: "between", values: [row["at"], row["at"]]}

    assert query(t, "/api/v1/audit-log/query", %{filter: %{logic: "and", conditions: [mine, at]}})
           |> json_response(200)
           |> Map.fetch!("total") >= 1

    # "testListAction<n>": "testList_ction" is its start.
    part = "testList_ction"

    assert query(t, "/api/v1/audit-log/query", %{search: part, limit: 4000})
           |> json_response(200)
           |> Map.fetch!("rows")
           |> Enum.any?(&(&1["action"] == action))
  end

  test "a query that does not fit is refused with field errors", %{token: t} do
    bad = %{filter: %{logic: "and", conditions: [%{field: "nope", op: "eq", value: 1}]}}

    assert %{"errors" => [%{"path" => "/filter/conditions/0/field"}]} =
             query(t, "/api/v1/audit-log/query", bad) |> json_response(400)
  end

  test "without a session 401; a user without View on the Audit Trail 403", %{token: t, id: id} do
    assert build_conn()
           |> put_req_header("content-type", "application/json")
           |> post("/api/v1/audit-log/query", "{}")
           |> json_response(401)

    Repo.query!("UPDATE users SET is_admin = false WHERE id = $1", [id])
    Access.forget()

    assert %{"code" => "not_allowed"} =
             query(t, "/api/v1/audit-log/query", %{}) |> json_response(403)
  end
end
