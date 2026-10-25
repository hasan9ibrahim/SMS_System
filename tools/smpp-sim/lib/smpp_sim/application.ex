defmodule SmppSim.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    :ok = SmppSim.Stats.setup()

    children = [
      {Registry, keys: :duplicate, name: SmppSim.SmscRegistry},
      SmppSim.Smsc.Dlr,
      {DynamicSupervisor, name: SmppSim.EsmeSup, strategy: :one_for_one, max_restarts: 1_000}
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: SmppSim.Supervisor)
  end
end
