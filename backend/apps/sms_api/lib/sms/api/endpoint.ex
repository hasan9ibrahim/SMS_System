defmodule Sms.Api.Endpoint do
  @moduledoc """
  The HTTP endpoint of the API (Bandit), listening on API_PORT when set (`server: true`); the servers' nginx sends
  /api to it. Live data stays on the mock's WebSocket until Phoenix Channels carry it (BACKEND_TODO).
  """
  use Phoenix.Endpoint, otp_app: :sms_api

  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:sms_api, :endpoint]
  plug Sms.Api.Router
end
