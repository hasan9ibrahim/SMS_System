defmodule Sms.Switch.Pipeline.Ledger.Charges do
  @moduledoc """
  Applies the charges the pipeline queues (`sms.billing.charge`, `Sms.Switch.Pipeline.Ledger.charge/5`) to the
  ledger in Redis, each once; one that cannot be applied stays on the bus and is tried again, so no billable message
  is lost from a balance. Charges are additions applied once each (`Sms.Switch.Pipeline.Ledger.apply_charge/1`), so
  several are applied at a time: one at a time fell behind under load (backend step 7).
  """
  use Sms.Core.Bus.Consumer,
    name: "pipeline-ledger-charges",
    filter: "sms.billing.charge",
    max_deliver: :infinity,
    concurrency: 4

  alias Sms.Switch.Pipeline.Ledger

  @impl true
  def handle_event(event), do: Ledger.apply_charge(event.data)
end
