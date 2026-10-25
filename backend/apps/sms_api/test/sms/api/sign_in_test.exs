defmodule Sms.Api.SignInTest do
  # Staff sign-in through the API (backend step 9, contract v0.96.0, §13.28), against PostgreSQL and a fake mock
  # server behind it (test/support/fake_mock.ex). Test users are created here and removed afterwards.
  use ExUnit.Case, async: false
  import Phoenix.ConnTest
  import Plug.Conn
  alias Sms.Api.{Password, Totp}
  alias Sms.Api.Test.FakeMock
  alias Sms.Core.Repo

  @endpoint Sms.Api.Endpoint
  @moduletag :integration
  @password "a-long-test-password-1"
  @secret "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"

  setup_all do
    # The database for the whole module, so each test's clean-up still reaches it; one hash for every test user.
    start_supervised!(Repo)
    {:ok, hash: Password.hash(@password, 1024)}
  end

  setup %{hash: hash} do
    {mock, url} = FakeMock.start(self())
    previous = Application.get_env(:sms_api, Sms.Api.Forward)

    Application.put_env(:sms_api, Sms.Api.Forward,
      url: url,
      secret: "test-secret",
      timeout_ms: 5_000
    )

    on_exit(fn ->
      Application.put_env(:sms_api, Sms.Api.Forward, previous)
      Process.exit(mock, :normal)
    end)

    {:ok, hash: hash}
  end

  defp user(hash, attrs \\ []) do
    name = "test.signin.#{System.unique_integer([:positive])}"

    %{rows: [[id]]} =
      Repo.query!(
        """
        INSERT INTO users (username, first_name, last_name, email, password_hash, password_changed_at, otp_method,
                           totp_enabled, totp_secret, allow_multiple_login, status)
        VALUES ($1, 'Test', 'User', $2, $3, now(), $4, $5, $6, $7, $8) RETURNING id
        """,
        [
          name,
          Keyword.get(attrs, :email, "#{name}@example.test"),
          hash,
          Keyword.get(attrs, :otp, "email"),
          Keyword.has_key?(attrs, :totp),
          Keyword.get(attrs, :totp),
          Keyword.get(attrs, :multiple, false),
          Keyword.get(attrs, :status, "active")
        ]
      )

    on_exit(fn ->
      for sql <- [
            "DELETE FROM email_logs WHERE user_id = $1",
            "DELETE FROM sign_in_challenges WHERE user_id = $1",
            "DELETE FROM user_sessions WHERE user_id = $1",
            "DELETE FROM users WHERE id = $1"
          ],
          do: Repo.query!(sql, [id])
    end)

    %{id: id, username: name}
  end

  defp post_json(conn, path, body) do
    conn
    |> put_req_header("content-type", "application/json")
    |> put_req_header("user-agent", "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0")
    |> post(path, Jason.encode!(body))
  end

  defp sign_in(username, password \\ @password),
    do: post_json(build_conn(), "/api/v1/session", %{username: username, password: password})

  defp cookie(conn), do: conn.resp_cookies["sms_session"].value

  defp with_cookie(token), do: build_conn() |> put_req_cookie("sms_session", token)

  defp last_code(user_id) do
    %{rows: [[body]]} =
      Repo.query!(
        "SELECT body FROM email_logs WHERE user_id = $1 AND email_type = 'otp' ORDER BY id DESC LIMIT 1",
        [
          user_id
        ]
      )

    [_, code] = Regex.run(~r/code is (\d{6})/, body)
    code
  end

  test "no session: 401 sign_in_required; code off: signed in at once, forwarded as that user; sign-out",
       %{hash: hash} do
    u = user(hash, otp: "off")

    assert %{"code" => "sign_in_required"} =
             build_conn() |> get("/api/v1/enterprises") |> json_response(401)

    conn = sign_in(String.upcase(u.username))
    assert %{"status" => "signed_in", "user" => %{"id" => id}} = json_response(conn, 200)
    assert id == u.id
    assert conn.resp_cookies["sms_session"].http_only
    token = cookie(conn)

    # The session goes along to the mock with the shared secret; the browser's own x-sms headers are dropped.
    resp =
      token
      |> with_cookie()
      |> put_req_header("x-sms-user", "999")
      |> get("/api/v1/enterprises?limit=5")

    assert json_response(resp, 200) == %{"echo" => true}
    assert get_resp_header(resp, "x-from-mock") == ["1"]
    assert_received {:mock_request, "GET", "/api/v1/me", _, _, _}
    assert_received {:mock_request, "GET", "/api/v1/enterprises", "limit=5", headers, _}
    assert {"x-sms-user", Integer.to_string(u.id)} in headers
    assert {"x-sms-proxy-secret", "test-secret"} in headers
    refute Enum.any?(headers, fn {k, _} -> k == "cookie" end)

    %{rows: [[device, os, browser]]} =
      Repo.query!("SELECT device, os, browser FROM user_sessions WHERE user_id = $1", [u.id])

    assert {device, os, browser} == {"desktop", "Windows", "Chrome"}

    assert token |> with_cookie() |> delete("/api/v1/session") |> response(204)
    assert token |> with_cookie() |> get("/api/v1/enterprises") |> json_response(401)
  end

  test "e-mailed code: wrong code uses a try, resend waits a minute, the right one signs in once",
       %{hash: hash} do
    u = user(hash)
    body = sign_in(u.username) |> json_response(200)
    assert %{"status" => "code_required", "method" => "email", "challenge" => challenge} = body
    assert body["sentTo"] =~ ~r/^t\*\*\*@example\.test$/
    code = last_code(u.id)
    wrong = if code == "000000", do: "111111", else: "000000"

    bad =
      post_json(build_conn(), "/api/v1/session/code", %{challenge: challenge, code: wrong})
      |> json_response(401)

    assert %{"code" => "wrong_code", "detail" => "4 tries left."} = bad

    assert post_json(build_conn(), "/api/v1/session/code/resend", %{challenge: challenge})
           |> json_response(409)

    Repo.query!(
      "UPDATE sign_in_challenges SET sent_at = now() - interval '2 minutes' WHERE user_id = $1",
      [u.id]
    )

    again =
      post_json(build_conn(), "/api/v1/session/code/resend", %{challenge: challenge})
      |> json_response(200)

    assert again["method"] == "email"
    code = last_code(u.id)

    conn = post_json(build_conn(), "/api/v1/session/code", %{challenge: challenge, code: code})
    assert %{"status" => "signed_in"} = json_response(conn, 200)
    assert cookie(conn) != ""

    used =
      post_json(build_conn(), "/api/v1/session/code", %{challenge: challenge, code: code})
      |> json_response(401)

    assert used["code"] == "challenge_expired"
  end

  test "five wrong codes end the challenge", %{hash: hash} do
    u = user(hash)
    %{"challenge" => challenge} = sign_in(u.username) |> json_response(200)
    code = last_code(u.id)
    wrong = if code == "000000", do: "111111", else: "000000"

    for _ <- 1..4,
        do: post_json(build_conn(), "/api/v1/session/code", %{challenge: challenge, code: wrong})

    last =
      post_json(build_conn(), "/api/v1/session/code", %{challenge: challenge, code: wrong})
      |> json_response(401)

    assert last["code"] == "challenge_expired"

    assert post_json(build_conn(), "/api/v1/session/code", %{challenge: challenge, code: code})
           |> json_response(401)
  end

  test "authenticator code for a user with 2FA on", %{hash: hash} do
    u = user(hash, otp: "authenticator", totp: @secret)

    %{"method" => "authenticator", "challenge" => challenge} =
      body = sign_in(u.username) |> json_response(200)

    refute Map.has_key?(body, "sentTo")

    assert post_json(build_conn(), "/api/v1/session/code/resend", %{challenge: challenge})
           |> json_response(409)

    conn =
      post_json(build_conn(), "/api/v1/session/code", %{
        challenge: challenge,
        code: Totp.code_at(@secret)
      })

    assert %{"status" => "signed_in", "user" => %{"id" => id}} = json_response(conn, 200)
    assert id == u.id
  end

  test "without Allow Multiple Login a new sign-in ends the other session; with it both stay", %{
    hash: hash
  } do
    single = user(hash, otp: "off")
    a = sign_in(single.username) |> cookie()
    b = sign_in(single.username) |> cookie()
    assert b |> with_cookie() |> get("/api/v1/enterprises") |> json_response(200)
    assert a |> with_cookie() |> get("/api/v1/enterprises") |> json_response(401)

    multi = user(hash, otp: "off", multiple: true)
    a = sign_in(multi.username) |> cookie()
    b = sign_in(multi.username) |> cookie()
    assert a |> with_cookie() |> get("/api/v1/enterprises") |> json_response(200)
    assert b |> with_cookie() |> get("/api/v1/enterprises") |> json_response(200)
  end

  test "idle 8 hours or signed in 24 hours ago: the session has ended", %{hash: hash} do
    u = user(hash, otp: "off")
    token = sign_in(u.username) |> cookie()

    Repo.query!(
      "UPDATE user_sessions SET last_seen_at = now() - interval '9 hours' WHERE user_id = $1",
      [u.id]
    )

    assert token |> with_cookie() |> get("/api/v1/enterprises") |> json_response(401)

    token = sign_in(u.username) |> cookie()

    Repo.query!(
      "UPDATE user_sessions SET logged_in_at = now() - interval '25 hours' WHERE user_id = $1",
      [u.id]
    )

    assert token |> with_cookie() |> get("/api/v1/enterprises") |> json_response(401)

    # Activity more than a minute ago is recorded on the next call.
    token = sign_in(u.username) |> cookie()

    Repo.query!(
      "UPDATE user_sessions SET last_seen_at = now() - interval '5 minutes' WHERE user_id = $1 AND ended_at IS NULL",
      [u.id]
    )

    assert token |> with_cookie() |> get("/api/v1/enterprises") |> json_response(200)

    %{rows: [[recent]]} =
      Repo.query!(
        "SELECT last_seen_at > now() - interval '1 minute' FROM user_sessions WHERE user_id = $1 AND ended_at IS NULL",
        [u.id]
      )

    assert recent
  end

  test "five wrong passwords lock the user; unknown users get the same answer", %{hash: hash} do
    u = user(hash, otp: "off")
    for _ <- 1..4, do: assert(sign_in(u.username, "wrong-password-1") |> json_response(401))
    assert %{"detail" => detail} = sign_in(u.username, "wrong-password-1") |> json_response(429)
    assert detail =~ "15 minutes"
    assert %{"detail" => "Try again after " <> _} = sign_in(u.username) |> json_response(429)

    assert %{"title" => "Wrong username or password"} =
             sign_in("no-such-user-xyz") |> json_response(401)
  end

  test "inactive users, expired temporary passwords and users without an e-mail address", %{
    hash: hash
  } do
    inactive = user(hash, otp: "off", status: "inactive")

    assert %{"title" => "This user is not active" <> _} =
             sign_in(inactive.username) |> json_response(401)

    temp = user(hash, otp: "off")

    Repo.query!(
      "UPDATE users SET temp_password_expires_at = now() - interval '1 hour' WHERE id = $1",
      [temp.id]
    )

    assert %{"title" => "Your temporary password expired" <> _} =
             sign_in(temp.username) |> json_response(401)

    no_mail = user(hash, email: "")

    assert %{"title" => "Your user has no e-mail address" <> _} =
             sign_in(no_mail.username) |> json_response(401)
  end

  test "bodies are checked against the contract" do
    errors =
      post_json(build_conn(), "/api/v1/session", %{username: "", extra: 1}) |> json_response(400)

    paths = errors["errors"] |> Enum.map(& &1["path"]) |> Enum.sort()
    assert paths == ["/extra", "/password", "/username"]

    errors =
      post_json(build_conn(), "/api/v1/session/code", %{challenge: "x", code: "12ab"})
      |> json_response(400)

    assert [%{"path" => "/code"}] = errors["errors"]

    errors =
      post_json(build_conn(), "/api/v1/session/code/resend", %{challenge: 5})
      |> json_response(400)

    assert [%{"path" => "/challenge", "message" => "must be string"}] = errors["errors"]
  end

  test "too many sign-ins from one address are refused for the rest of the minute" do
    previous = Application.get_env(:sms_api, Sms.Api.RateLimit)
    Application.put_env(:sms_api, Sms.Api.RateLimit, limit: 2, window_s: 60)
    on_exit(fn -> Application.put_env(:sms_api, Sms.Api.RateLimit, previous) end)

    conn = fn ->
      %{build_conn() | remote_ip: {203, 0, 113, rem(System.unique_integer([:positive]), 200)}}
    end

    c = conn.()

    hit = fn ->
      post_json(%{c | remote_ip: c.remote_ip}, "/api/v1/session", %{
        username: "nobody-x",
        password: "x"
      })
    end

    assert hit.() |> json_response(401)
    assert hit.() |> json_response(401)
    assert %{"title" => "Too many sign-ins from this address"} = hit.() |> json_response(429)
  end

  test "the user cannot be read from the mock: 503 and the new session ends", %{hash: hash} do
    u = user(hash, otp: "off")

    Application.put_env(:sms_api, Sms.Api.Forward,
      url: "http://127.0.0.1:1",
      secret: "x",
      timeout_ms: 1_000
    )

    assert sign_in(u.username) |> json_response(503)

    %{rows: [[open]]} =
      Repo.query!("SELECT count(*) FROM user_sessions WHERE user_id = $1 AND ended_at IS NULL", [
        u.id
      ])

    assert open == 0
  end
end
