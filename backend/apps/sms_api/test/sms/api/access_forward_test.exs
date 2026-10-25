defmodule Sms.Api.AccessTest do
  # The access check and the password gate before a call is forwarded (backend step 9, §1, §11, §13.28), against
  # PostgreSQL and a fake mock; test users and groups are removed afterwards.
  use ExUnit.Case, async: false
  import Phoenix.ConnTest
  import Plug.Conn
  alias Sms.Api.{Access, Forward, PasswordGate}
  alias Sms.Api.Test.FakeMock
  alias Sms.Core.Repo

  @endpoint Sms.Api.Endpoint
  @moduletag :integration

  setup_all do
    start_supervised!(Repo)
    :ok
  end

  setup do
    {mock, url} = FakeMock.start(self())
    previous = Application.get_env(:sms_api, Forward)
    Application.put_env(:sms_api, Forward, url: url, secret: "s", timeout_ms: 5_000)
    Access.forget()
    PasswordGate.forget()

    on_exit(fn ->
      Application.put_env(:sms_api, Forward, previous)
      Process.exit(mock, :normal)
    end)

    :ok
  end

  defp user(permissions, overrides \\ %{}) do
    n = "#{System.unique_integer([:positive])}.#{:rand.uniform(1_000_000_000)}"

    %{rows: [[group]]} =
      Repo.query!(
        "INSERT INTO access_groups (name, permissions) VALUES ($1, $2) RETURNING id",
        [
          "test group #{n}",
          permissions
        ]
      )

    %{rows: [[id]]} =
      Repo.query!(
        """
        INSERT INTO users (username, first_name, last_name, email, password_hash, password_changed_at,
                           access_group_id, permission_overrides)
        VALUES ($1, 'Test', 'Access', $2, 'x', now(), $3, $4) RETURNING id
        """,
        ["test.access.#{n}", "test.access.#{n}@example.test", group, overrides]
      )

    on_exit(fn ->
      Repo.query!("DELETE FROM users WHERE id = $1", [id])
      Repo.query!("DELETE FROM access_groups WHERE id = $1", [group])
    end)

    id
  end

  defp as(user_id, method, path, body \\ "") do
    Phoenix.ConnTest.build_conn(method, path, body)
    |> put_req_header("content-type", "application/json")
    |> assign(:session, %{user_id: user_id, session_id: 1})
    |> Forward.call([])
  end

  test "a change the group does not give is refused before it reaches the mock; reads go through" do
    id = user(%{"enterprises" => ["view", "edit"]})

    refused = as(id, :post, "/api/v1/enterprises", "{}")
    assert refused.status == 403
    assert %{"code" => "not_allowed"} = Jason.decode!(refused.resp_body)
    refute_received {:mock_request, "POST", "/api/v1/enterprises", _, _, _}

    assert as(id, :put, "/api/v1/enterprises/5", "{}").status == 200
    assert as(id, :post, "/api/v1/route-rules/query", "{}").status == 200
  end

  test "Admin pages need View even to read; the ones used as pickers stay readable" do
    id = user(%{"enterprises" => ["view"]})
    assert as(id, :post, "/api/v1/audit-log/query", "{}").status == 403
    assert as(id, :post, "/api/v1/users/query", "{}").status == 200

    auditor = user(%{"audit" => ["view"]})
    assert as(auditor, :post, "/api/v1/audit-log/query", "{}").status == 200
  end

  test "the user's own override taking a page away beats the group's every-page grant" do
    id = user(%{"*" => ["view", "add", "edit", "delete"]}, %{"transactions" => []})
    assert as(id, :post, "/api/v1/enterprises", "{}").status == 200
    assert as(id, :post, "/api/v1/transactions", "{}").status == 403
  end

  test "a must-change password leaves only the session and password calls" do
    id = user(%{"*" => ["view", "edit"]})
    Repo.query!("UPDATE users SET must_change_password = true WHERE id = $1", [id])

    blocked = as(id, :post, "/api/v1/route-rules/query", "{}")
    assert blocked.status == 403
    assert %{"code" => "password_change_required"} = Jason.decode!(blocked.resp_body)
    assert as(id, :get, "/api/v1/me").status == 200
  end

  test "portal calls pass with the portal's own cookie, without a staff session" do
    conn =
      build_conn()
      |> put_req_cookie("sms_portal", "portal-token")
      |> get("/api/v1/portal/session")

    assert conn.status == 200
    assert_received {:mock_request, "GET", "/api/v1/portal/session", _, headers, _}
    assert {"cookie", "sms_portal=portal-token"} in headers
  end

  test "an administrator may do everything; a change to users drops the cached access" do
    id = user(%{"enterprises" => ["view"]})
    assert as(id, :post, "/api/v1/enterprises", "{}").status == 403
    Repo.query!("UPDATE users SET is_admin = true WHERE id = $1", [id])
    # Still cached for a few seconds, until a change to users goes through the API.
    assert as(id, :post, "/api/v1/enterprises", "{}").status == 403
    admin = user(%{"users" => ["view", "edit"]})
    assert as(admin, :put, "/api/v1/users/#{id}", "{}").status == 200
    assert as(id, :post, "/api/v1/enterprises", "{}").status == 200
  end
end
