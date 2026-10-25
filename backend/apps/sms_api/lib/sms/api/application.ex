defmodule Sms.Api.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Finch, name: Sms.Api.Finch, pools: %{default: [size: 50]}},
      Sms.Api.RateLimit,
      Sms.Api.Caches,
      Sms.Api.ConfigPush,
      Sms.Api.Endpoint
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: Sms.Api.Supervisor)
  end
end
