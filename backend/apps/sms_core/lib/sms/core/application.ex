defmodule Sms.Core.Application do
  @moduledoc false
  use Application

  # Each service the node runs, in start order: the database first, the event bus last.
  @children %{
    repo: Sms.Core.Repo,
    redis: Sms.Core.Redis,
    clickhouse: Sms.Core.ClickHouse,
    bus: Sms.Core.Bus
  }

  @impl true
  def start(_type, _args) do
    services = Application.get_env(:sms_core, :services, [])

    children =
      for name <- [:repo, :redis, :clickhouse, :bus], name in services do
        Map.fetch!(@children, name)
      end

    Supervisor.start_link(children, strategy: :one_for_one, name: Sms.Core.Supervisor)
  end
end
