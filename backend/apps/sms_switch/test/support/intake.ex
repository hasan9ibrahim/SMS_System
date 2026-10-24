defmodule Sms.Switch.Test.Intake do
  @moduledoc """
  An intake for tests. Every request is reported to the test process registered as the owner, and answered by the
  owner's `reply` function (default: accept with message id `"m<sequence>"`).
  """
  @behaviour Sms.Switch.Customer.Intake

  @key {__MODULE__, :owner}

  @doc "Makes the calling test the owner; `reply` takes `(context, pdu)` and returns the intake reply."
  def own(reply \\ &accept/2), do: :persistent_term.put(@key, {self(), reply})

  def accept(_context, pdu), do: {:ok, %{message_id: "m#{pdu.sequence}"}, []}

  @impl true
  def handle(context, pdu) do
    {owner, reply} = :persistent_term.get(@key)
    send(owner, {:intake, self(), context, pdu})
    reply.(context, pdu)
  end
end
