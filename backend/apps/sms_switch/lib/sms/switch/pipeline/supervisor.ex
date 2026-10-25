defmodule Sms.Switch.Pipeline.Supervisor do
  @moduledoc """
  The message pipeline (build step 4, spec §2, §6, docs/SMPP_SCENARIOS.md): the shared message store, the routing
  configuration in memory, and the bus consumers that send accepted messages to vendors (`Sender`), forward receipts
  to customers (`Forwarder`, `Held`), drain the customer and vendor trunks' overflow buffers (`Buffers`), answer DLR timeouts, late receipts and late vendor answers (`Timeouts`, `LateReceipts`, `LateResponses`) and write the EDRs (`EdrWriter`); `Backlog` refuses new messages while the
  sender is too far behind. The customer side hands submits to
  `Sms.Switch.Pipeline.Intake`, the vendor side receipts to `Sms.Switch.Pipeline.Receipts`.
  """
  use Supervisor
  alias Sms.Switch.Pipeline

  def start_link(opts \\ []), do: Supervisor.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(_opts) do
    # The bus consumers and the DLR timeout sweep start once the routing configuration is loaded (`Starter`).
    consumers = [
      Pipeline.Timeouts,
      Pipeline.EdrWriter,
      Pipeline.Sender,
      Pipeline.Forwarder,
      Pipeline.Held.OnBind,
      Pipeline.LateReceipts,
      Pipeline.Ledger.Charges,
      Pipeline.LateResponses,
      Pipeline.Buffers
    ]

    children = [
      Pipeline.Delayed,
      Pipeline.LiveTps,
      Pipeline.Store,
      Pipeline.Config.Server,
      Pipeline.Held,
      Pipeline.Ledger.Sync,
      Pipeline.Backlog,
      {Pipeline.Starter, children: consumers}
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
