defmodule Sms.Switch.Application do
  @moduledoc false
  use Application

  # The customer side (step 2) starts when enabled; vendor connections and the message pipeline join from step 3.
  @impl true
  def start(_type, _args) do
    customer = Application.get_env(:sms_switch, Sms.Switch.Customer, [])

    children =
      if Keyword.get(customer, :enabled, false), do: [Sms.Switch.Customer.Supervisor], else: []

    Supervisor.start_link(children, strategy: :one_for_one, name: Sms.Switch.Supervisor)
  end
end
