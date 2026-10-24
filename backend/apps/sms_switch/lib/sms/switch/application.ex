defmodule Sms.Switch.Application do
  @moduledoc false
  use Application

  # Listeners, vendor connections and the message pipeline join this tree from step 2 on.
  @impl true
  def start(_type, _args) do
    Supervisor.start_link([], strategy: :one_for_one, name: Sms.Switch.Supervisor)
  end
end
