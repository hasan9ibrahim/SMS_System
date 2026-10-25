defmodule Sms.Api.Lists.Defs do
  @moduledoc """
  The lists the Elixir API answers itself (backend step 9; each moves here once it passes the mock's own tests run
  against the API), with the same SQL as the mock's list definitions (mock/src/lists/adminDefs.ts):

    * `audit_log`: the Audit Trail (§11), every call that changed something;
    * `user_sessions`: Logged In Users (§11), the open staff and portal sessions; `current` marks the caller's own.
  """

  @doc "The Audit Trail list."
  @spec audit_log() :: Sms.Api.Lists.Engine.definition()
  def audit_log do
    %{
      list: "audit_log",
      from: "audit_log a LEFT JOIN users u ON u.id = a.user_id",
      columns: %{
        "id" => "a.id",
        "ip" => "host(a.ip)",
        "module" => "a.module",
        "controller" => "a.controller",
        "method" => "a.method",
        "action" => "a.action",
        "tableName" => "a.table_name",
        "masterId" => "a.master_id",
        "at" => "a.at",
        "user" => "u.username",
        "userId" => "a.user_id",
        "status" => "a.status",
        "durationMs" => "a.duration_ms"
      },
      search: ["user", "action", "controller", "masterId"],
      id_sql: "a.id",
      select:
        "a.id, a.at, a.user_id, u.username, host(a.ip) AS ip_text, a.module, a.controller, a.method, a.action, " <>
          "a.table_name, a.master_id, a.status, a.duration_ms",
      map_row: fn r ->
        %{
          id: r["id"],
          at: iso(r["at"]),
          userId: r["user_id"],
          user: r["username"],
          ip: r["ip_text"],
          module: r["module"],
          controller: r["controller"],
          method: r["method"],
          action: r["action"],
          tableName: r["table_name"],
          masterId: r["master_id"],
          status: r["status"],
          durationMs: r["duration_ms"]
        }
      end
    }
  end

  @session_user "coalesce(u.username, p.username)"
  @session_name "coalesce((u.first_name || ' ' || u.last_name), (p.first_name || ' ' || p.last_name))"

  @doc "The Logged In Users list; `session_id` is the caller's own session."
  @spec user_sessions(pos_integer()) :: Sms.Api.Lists.Engine.definition()
  def user_sessions(session_id) do
    %{
      list: "user_sessions",
      from: """
      user_sessions s LEFT JOIN users u ON u.id = s.user_id
        LEFT JOIN customer_portal_users p ON p.id = s.portal_user_id
        LEFT JOIN enterprises e ON e.id = p.enterprise_id
      """,
      base_where: "s.ended_at IS NULL",
      columns: %{
        "loggedInAt" => "s.logged_in_at",
        "displayName" => @session_name,
        "username" => @session_user,
        "userKind" => "s.user_kind",
        "enterprise" => "e.name",
        "ip" => "host(s.ip)",
        "location" => "s.location",
        "device" => "s.device",
        "os" => "s.os",
        "browser" => "s.browser",
        "lastSeenAt" => "s.last_seen_at"
      },
      search: ["displayName", "username", "ip"],
      id_sql: "s.id",
      select:
        "s.id, s.user_kind, coalesce(s.user_id, s.portal_user_id) AS user_id, #{@session_user} AS username, " <>
          "#{@session_name} AS display_name, e.name AS enterprise, host(s.ip) AS ip_text, s.location, s.device, " <>
          "s.os, s.browser, s.logged_in_at, s.last_seen_at, (s.id = #{Integer.to_string(session_id)}) AS is_current",
      map_row: fn r ->
        %{
          id: r["id"],
          userKind: r["user_kind"],
          userId: r["user_id"],
          username: r["username"],
          displayName: r["display_name"],
          enterprise: r["enterprise"],
          ip: r["ip_text"],
          location: r["location"],
          device: r["device"],
          os: r["os"],
          browser: r["browser"],
          loggedInAt: iso(r["logged_in_at"]),
          lastSeenAt: iso(r["last_seen_at"]),
          current: r["is_current"] == true
        }
      end
    }
  end

  # Times as the mock answers them: UTC with milliseconds.
  defp iso(nil), do: nil
  defp iso(%DateTime{} = at), do: at |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
end
