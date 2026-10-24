defmodule Sms.Switch.Pipeline.Supervisor do
  @moduledoc """
  The message pipeline (build step 4, spec §2, §6, docs/SMPP_SCENARIOS.md): the shared message store, the routing
  configuration in memory, and the bus consumers that send accepted messages to vendors (`Sender`), forward receipts
  to customers (`Forwarder`, `Held`), answer DLR timeouts and late receipts (`Timeouts`, `LateReceipts`) and write the EDRs (`EdrWriter`). The customer side hands submits to
  `Sms.Switch.Pipeline.Intake`, the vendor side receipts to `Sms.Switch.Pipeline.Receipts`.
  """
  use Supervisor
  alias Sms.Switch.Pipeline

  def start_link(opts \\ []), do: Supervisor.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(_opts) do
    children = [
      Pipeline.Store,
      Pipeline.Config.Server,
      Pipeline.Held,
      Pipeline.Timeouts,
      Pipeline.EdrWriter,
      Pipeline.Sender,
      Pipeline.Forwarder,
      Pipeline.Held.OnBind,
      Pipeline.LateReceipts
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
