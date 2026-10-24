defmodule Sms.Switch.Customer.Supervisor do
  @moduledoc """
  The customer side's processes. In start order: the task supervisor (intake calls, events), the session registry
  and its cluster scope, the services (Firewall, trunks); the TPS counters (`Sms.Switch.Throttle`) are shared
  with the vendor side and started by the application, and the listeners last, so a
  client is never accepted before everything it needs is up. A crash of the registry restarts the listeners (and
  so the sessions) with it; the services restart on their own without touching bound sessions.
  """
  use Supervisor
  alias Sms.Switch.Customer.{Firewall, Listener, Sessions, TrunkStore}

  @doc """
  Options: `:listeners`, `:tls`, `:session`, `:intake`, `:trunk_loader`, `:trunk_refresh_ms`, `:firewall`
  (defaults from `config :sms_switch, Sms.Switch.Customer`).
  """
  def start_link(opts \\ []), do: Supervisor.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    config = Keyword.merge(Application.get_env(:sms_switch, Sms.Switch.Customer, []), opts)

    store_opts =
      [refresh_ms: Keyword.get(config, :trunk_refresh_ms, 5_000)] ++
        if(loader = config[:trunk_loader], do: [loader: loader], else: [])

    services = [
      {Firewall, Keyword.get(config, :firewall, [])},
      {TrunkStore, store_opts}
    ]

    protocol_opts =
      [session: Keyword.get(config, :session, [])] ++
        if(intake = config[:intake], do: [intake: intake], else: [])

    listeners =
      Listener.child_specs(
        Keyword.get(config, :listeners, []),
        Keyword.get(config, :tls, []),
        protocol_opts
      )

    children =
      [{Task.Supervisor, name: Sms.Switch.Customer.Tasks}] ++
        Sessions.child_specs() ++
        [
          %{
            id: :services,
            type: :supervisor,
            start: {Supervisor, :start_link, [services, [strategy: :one_for_one]]}
          },
          %{
            id: :listeners,
            type: :supervisor,
            start: {Supervisor, :start_link, [listeners, [strategy: :one_for_one]]}
          }
        ]

    Supervisor.init(children, strategy: :rest_for_one)
  end
end
