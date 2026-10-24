defmodule Sms.Switch.Application do
  @moduledoc false
  use Application
  alias Sms.Switch.Pipeline.MessageId

  # The TPS counters are shared by both sides; each side starts when enabled (step 2 customer, step 3 vendor), after
  # the pipeline (step 4) that takes their submits and receipts.
  @impl true
  def start(_type, _args) do
    :ok = MessageId.setup()

    sides =
      for {side, sup} <- [
            {Sms.Switch.Pipeline, Sms.Switch.Pipeline.Supervisor},
            {Sms.Switch.Customer, Sms.Switch.Customer.Supervisor},
            {Sms.Switch.Vendor, Sms.Switch.Vendor.Supervisor}
          ],
          :sms_switch |> Application.get_env(side, []) |> Keyword.get(:enabled, false),
          do: sup

    children = if sides == [], do: [], else: [Sms.Switch.Throttle | sides]
    Supervisor.start_link(children, strategy: :one_for_one, name: Sms.Switch.Supervisor)
  end
end
