defmodule Sms.Switch.Test.Receipts do
  @moduledoc """
  A receipt handler for tests. Every receipt is reported to the test process registered as the owner, and answered by
  the owner's `reply` function (default: `:ok`).
  """
  @behaviour Sms.Switch.Vendor.Receipts

  @key {__MODULE__, :owner}

  @doc "Makes the calling test the owner; `reply` takes `(context, pdu)` and returns the handler's answer."
  def own(reply \\ fn _context, _pdu -> :ok end), do: :persistent_term.put(@key, {self(), reply})

  @impl true
  def handle(context, pdu) do
    {owner, reply} = :persistent_term.get(@key)
    send(owner, {:receipt, context, pdu})
    reply.(context, pdu)
  end
end
