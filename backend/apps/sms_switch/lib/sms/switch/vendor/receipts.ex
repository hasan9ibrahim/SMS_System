defmodule Sms.Switch.Vendor.Receipts do
  @moduledoc """
  Where the `deliver_sm` and `data_sm` a vendor sends us go: receipts for messages we sent, and MO messages (spec
  §2, S-5.5–S-5.15). The message pipeline (step 4) implements it: it matches the receipt to its message (see
  `Sms.Switch.Vendor.MessageId`), records it and forwards the customer's receipt.

  `handle/2` runs in its own process, one per PDU; the session answers the vendor with the status it returns. Answer
  `:ok` once the receipt is safely kept, even for an unknown or very old message id (S-5.12, never make the vendor
  retry forever). An error status asks the vendor to send it again later.

  Until step 4, `Sms.Switch.Vendor.Receipts.LogOnly` answers OK and logs (decision Q7: no MO traffic in v1; an
  unexpected MO is answered OK so the vendor never retries forever).
  """
  alias Sms.Switch.Smpp.Pdu

  @typedoc """
  Where the PDU came from: the session, its trunk (with its MsgID Type), the node, and when it arrived.
  """
  @type context :: %{
          session_id: String.t(),
          trunk: Sms.Switch.Vendor.Trunk.t(),
          node: node(),
          received_at: DateTime.t()
        }

  @callback handle(context(), Pdu.t()) ::
              :ok | {:error, Sms.Switch.Smpp.Status.name() | pos_integer()}

  @doc """
  Whether receipts can be taken now. Vendor connections are not opened before (a server starting: the pipeline's
  configuration is loaded first), so no receipt arrives that could not be handled (backend step 7).
  """
  @callback ready?() :: boolean()
  @optional_callbacks ready?: 0

  @doc "Whether `module` can take receipts now (true when it does not say)."
  @spec ready?(module()) :: boolean()
  def ready?(module) do
    Code.ensure_loaded?(module) and
      (not function_exported?(module, :ready?, 0) or module.ready?())
  end

  @doc "The configured implementation (`config :sms_switch, Sms.Switch.Vendor, receipts: Module`)."
  @spec impl() :: module()
  def impl do
    :sms_switch
    |> Application.get_env(Sms.Switch.Vendor, [])
    |> Keyword.get(:receipts, __MODULE__.LogOnly)
  end

  defmodule LogOnly do
    @moduledoc "Answers every receipt and MO with OK and logs it, until the pipeline takes them (step 4)."
    @behaviour Sms.Switch.Vendor.Receipts
    require Logger

    @impl true
    def handle(context, pdu) do
      Logger.info(
        "vendor #{pdu.command} from trunk #{context.trunk.id} answered OK and not processed (no pipeline yet): " <>
          "esm_class #{Map.get(pdu.fields, :esm_class, 0)}, tlvs #{inspect(Keyword.keys(pdu.tlvs))}"
      )

      :ok
    end
  end
end
