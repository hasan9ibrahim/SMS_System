defmodule Sms.Switch.Pipeline.LateResponses do
  @moduledoc """
  A vendor's answer that came after the submit timed out (D4, S-5.2): the message was already re-routed. When the late
  answer accepted it, the vendor may deliver it too, so the timed-out attempt gets a *possible duplicate* mark: an
  `edr_receipt` row with status ACCEPTD, `is_duplicate` 1 and the vendor's message id, for vendor invoice checks. The
  customer gets nothing more.
  """
  use Sms.Core.Bus.Consumer,
    name: "pipeline-late-responses",
    filter: "sms.session.vendor.late_response",
    max_deliver: 5

  require Logger
  alias Sms.Switch.Pipeline.{Edr, Store}

  @impl true
  def handle_event(%{data: %{"ref" => ref, "status" => 0} = data}) when is_binary(ref) do
    case Store.take_possibly_sent(ref) do
      {:ok, attempt} -> flag(attempt, data)
      :none -> :ok
      {:error, _} = error -> error
    end
  end

  def handle_event(_event), do: :ok

  defp flag(attempt, data) do
    Logger.warning(
      "message #{attempt.data.id}: vendor trunk #{attempt.vendor_trunk_id} accepted it late, possible duplicate (D4)"
    )

    Edr.receipt_row(%{
      edr_id: attempt.edr_id,
      kind: "vendor",
      at: System.os_time(:millisecond),
      msg: attempt.data,
      part: attempt.part,
      vendor_trunk_id: attempt.vendor_trunk_id,
      vendor_message_id: data["raw_message_id"],
      status: "ACCEPTD",
      error: "000",
      duplicate: true,
      source: "vendor"
    })
    |> Edr.publish_receipt()
  end
end
