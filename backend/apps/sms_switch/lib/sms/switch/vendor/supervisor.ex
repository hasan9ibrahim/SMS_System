defmodule Sms.Switch.Vendor.Supervisor do
  @moduledoc """
  The vendor side's processes. In start order: the task supervisor (receipt handlers, events), the session registry
  and its cluster scope, the session supervisor, the manager, and the trunk store last, so the first trunk load
  finds the manager ready to open the connections. The TPS counters (`Sms.Switch.Throttle`) are shared with the
  customer side and started by the application.
  """
  use Supervisor
  alias Sms.Switch.Vendor.{Manager, TrunkStore}

  @doc """
  Options: `:session`, `:receipts`, `:trunk_loader`, `:trunk_refresh_ms` (defaults from
  `config :sms_switch, Sms.Switch.Vendor`).
  """
  def start_link(opts \\ []), do: Supervisor.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    config = Keyword.merge(Application.get_env(:sms_switch, Sms.Switch.Vendor, []), opts)

    store_opts =
      [refresh_ms: Keyword.get(config, :trunk_refresh_ms, 5_000)] ++
        if(loader = config[:trunk_loader], do: [loader: loader], else: [])

    children = [
      {Task.Supervisor, name: Sms.Switch.Vendor.Tasks},
      {Registry, keys: :unique, name: Sms.Switch.Vendor.Registry},
      %{id: :sms_vendor_sessions, start: {:pg, :start_link, [:sms_vendor_sessions]}},
      {DynamicSupervisor, name: Sms.Switch.Vendor.Sessions, strategy: :one_for_one},
      {Manager, Keyword.take(config, [:session, :receipts])},
      {TrunkStore, store_opts}
    ]

    Supervisor.init(children, strategy: :rest_for_one)
  end
end
