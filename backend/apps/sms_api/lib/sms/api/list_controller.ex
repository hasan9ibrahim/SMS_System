defmodule Sms.Api.ListController do
  @moduledoc """
  The list queries the Elixir API answers itself (`Sms.Api.Lists.Defs`, backend step 9): a `ListQuery` body in, one
  page out (`rows`, `total`, `totalIsEstimate`, `nextCursor`), or 400 with field errors for a query that does not fit
  the list's catalogue.
  """
  use Phoenix.Controller, formats: [:json]
  alias Sms.Api.Lists.{Defs, Engine}
  alias Sms.Api.Problem

  def audit_log(conn, params), do: run(conn, Defs.audit_log(), params)

  def user_sessions(conn, params),
    do: run(conn, Defs.user_sessions(conn.assigns.session.session_id), params)

  defp run(conn, def, params) do
    case Engine.run(def, params) do
      {:ok, page} ->
        json(conn, page)

      {:error, errors} ->
        Problem.send(
          conn,
          Problem.new(400, "The list query does not fit this list", errors: errors)
        )
    end
  end
end
