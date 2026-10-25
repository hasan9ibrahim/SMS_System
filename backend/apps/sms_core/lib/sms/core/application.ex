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

    # The other servers (SWITCH_PEERS), when this node is distributed.
    peers = :sms_core |> Application.get_env(Sms.Core.Cluster, []) |> Keyword.get(:peers, [])

    children =
      if peers != [] and Node.alive?(),
        do: [{Sms.Core.Cluster, peers: peers} | children],
        else: children

    # The health and metrics endpoint (backend step 8), last: it reports on the others.
    http = Application.get_env(:sms_core, Sms.Core.Http, [])

    children =
      if Keyword.get(http, :port, 0) > 0,
        do: children ++ [{Sms.Core.Http, http}],
        else: children

    Supervisor.start_link(children, strategy: :one_for_one, name: Sms.Core.Supervisor)
  end
end
