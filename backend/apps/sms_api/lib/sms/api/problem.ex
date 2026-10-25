defmodule Sms.Api.Problem do
  @moduledoc """
  Error answers as RFC 9457 problem documents (`application/problem+json`), the same shape the mock sends: `title`,
  `status`, and optionally `detail`, `code` (machine-readable, e.g. `sign_in_required`) and field `errors`.
  """
  import Plug.Conn

  @type t :: %{
          required(:title) => String.t(),
          required(:status) => pos_integer(),
          optional(atom()) => term()
        }

  @doc "A problem document."
  @spec new(pos_integer(), String.t(), map() | keyword()) :: t()
  def new(status, title, extra \\ %{}),
    do: Map.merge(%{type: "about:blank", title: title, status: status}, Map.new(extra))

  @doc "Sends a problem document and halts."
  @spec send(Plug.Conn.t(), t()) :: Plug.Conn.t()
  def send(conn, %{status: status} = problem) do
    conn
    |> put_resp_content_type("application/problem+json")
    |> send_resp(status, Jason.encode_to_iodata!(problem))
    |> halt()
  end

  @doc "The 401 for a call made without a session (the GUI then shows the sign-in screen)."
  @spec sign_in_required() :: t()
  def sign_in_required, do: new(401, "Sign in to continue", code: "sign_in_required")
end
