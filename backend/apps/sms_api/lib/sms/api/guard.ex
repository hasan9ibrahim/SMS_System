defmodule Sms.Api.Guard do
  @moduledoc """
  Before an operation the API answers itself (backend step 9): a signed-in user, the password gate
  (`Sms.Api.PasswordGate`) and the user's access group (`Sms.Api.Access`), as for the calls forwarded to the mock.
  Assigns the operation as `:operation`.
  """
  @behaviour Plug
  import Plug.Conn
  alias Sms.Api.{Access, Operations, PasswordGate, Problem}

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    op = Operations.find(conn.method, String.replace_prefix(conn.request_path, "/api/v1", ""))
    session = conn.assigns[:session]

    with {:session, %{user_id: user_id}} <- {:session, session},
         :ok <- PasswordGate.check(user_id, op.operation_id),
         :ok <- Access.check(user_id, op) do
      assign(conn, :operation, op)
    else
      {:session, nil} -> Problem.send(conn, Problem.sign_in_required())
      {:error, problem} -> Problem.send(conn, problem)
    end
  end
end
