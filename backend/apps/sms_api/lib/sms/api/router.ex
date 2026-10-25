defmodule Sms.Api.Router do
  @moduledoc """
  The contract's operations under /api/v1 (contract/openapi.yaml). The ones ported to Elixir are routed here; every
  other call goes to the mock server with the signed-in user (`Sms.Api.Forward`), so each operation moves to Elixir
  on its own and the screens never change (product owner 2026-10-25). Ported so far: sign-in (backend step 9).
  """
  use Phoenix.Router, helpers: false

  pipeline :signed do
    plug Sms.Api.Auth
  end

  pipeline :json_body do
    plug Plug.Parsers, parsers: [:json], json_decoder: Jason, length: 1_000_000
  end

  scope "/api/v1", Sms.Api do
    pipe_through [:signed, :json_body]

    post "/session", SessionController, :create
    delete "/session", SessionController, :delete
    post "/session/code", SessionController, :code
    post "/session/code/resend", SessionController, :resend
  end

  scope "/api/v1" do
    pipe_through :signed
    forward "/", Sms.Api.Forward
  end
end
