defmodule Sms.Switch.Customer.Intake do
  @moduledoc """
  Where a customer session hands each message request: `submit_sm`, `data_sm`, `query_sm` and `cancel_sm`. The
  message pipeline (build step 4) implements it; the session only frames, checks the bind and the TPS limits, and
  answers on the same session with the same sequence number (§13.1 rule 1).

  Each call runs in its own process, never in the session, so a slow request never holds back the others in the
  client's window. The session waits at most its `:intake_timeout_ms` and then answers 0x08 (system error), so
  the client never times out on us (S-2.3); an implementation must answer well before that, after the message is
  safely stored and never after the vendor answers (S-2.2), except on a Delayed Submit trunk (S-2.18).

  If the session is gone when the answer is ready, the answer is dropped (and logged): the message has been
  accepted and is processed anyway (S-2.6).
  """
  alias Sms.Switch.Customer.{Affinity, Trunk}
  alias Sms.Switch.Smpp.{Pdu, Status, Tlv}

  @typedoc """
  The session a request arrived on: stored with the message so its receipt can follow it (§13.1 rule 2, EDR
  columns Customer Session ID and Customer Bind Type). `buffered`: accepted over the trunk's TPS into its overflow
  buffer (S-2.4); the pipeline sends it when the TPS allows and gives the buffer place back.
  """
  @type context :: %{
          origin: Affinity.origin(),
          trunk: Trunk.t(),
          port: :inet.port_number(),
          node: node(),
          received_at: DateTime.t(),
          buffered: boolean()
        }

  @typedoc "The answer: fields and TLVs of the response, or an error status (the response then has no body)."
  @type reply :: {:ok, map(), [Tlv.t()]} | {:error, Status.name()}

  @callback handle(context(), Pdu.t()) :: reply()

  @doc "The configured implementation (`config :sms_switch, Sms.Switch.Customer, intake: Module`)."
  @spec impl() :: module()
  def impl do
    :sms_switch
    |> Application.get_env(Sms.Switch.Customer, [])
    |> Keyword.get(:intake, __MODULE__.NotReady)
  end

  defmodule NotReady do
    @moduledoc """
    The intake until the message pipeline exists (build step 4): every message request is refused with 0x45
    (submit failed), so a test client binds and sees a clean, immediate answer and nothing is ever lost silently.
    """
    @behaviour Sms.Switch.Customer.Intake

    @impl true
    def handle(_context, %Pdu{command: :query_sm}), do: {:error, :esme_rqueryfail}
    def handle(_context, %Pdu{command: :cancel_sm}), do: {:error, :esme_rcancelfail}
    def handle(_context, %Pdu{}), do: {:error, :esme_rsubmitfail}
  end
end
