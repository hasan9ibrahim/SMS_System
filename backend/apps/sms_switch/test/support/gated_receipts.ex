defmodule Sms.Switch.Test.GatedReceipts do
  @moduledoc "A receipt handler for tests that says it is not ready until `open/0`, like a pipeline still loading."
  @behaviour Sms.Switch.Vendor.Receipts

  @key {__MODULE__, :ready}

  def close, do: :persistent_term.put(@key, false)
  def open, do: :persistent_term.put(@key, true)

  @impl true
  def ready?, do: :persistent_term.get(@key, false)

  @impl true
  def handle(_context, _pdu), do: :ok
end
