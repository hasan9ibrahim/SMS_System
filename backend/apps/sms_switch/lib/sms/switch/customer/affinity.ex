defmodule Sms.Switch.Customer.Affinity do
  @moduledoc """
  Which session may receive a delivery receipt (spec §13.1 rules 2–4, setting DLR Session Affinity):

  | Setting | Original session can receive | Original session gone, or it was TX |
  | --- | --- | --- |
  | `:strict` | only that session | any RX/TRX session of the trunk from the same IP |
  | `:same_ip` | that session first, then the trunk's other sessions from the same IP | sessions from the same IP |
  | `:same_trunk` | that session first, then the same IP, then any session of the trunk | same IP first, then any |

  A session from another IP is a candidate only with `:same_trunk` (§13.1 acceptance test d). An empty list means
  the receipt must be held until a matching session binds (step 4 keeps held receipts, up to the trunk's hold time).
  """
  alias Sms.Switch.Customer.{Sessions, Trunk}

  @type origin :: %{
          session_id: String.t(),
          trunk_id: pos_integer(),
          ip: :inet.ip_address(),
          bind: Sessions.bind()
        }

  @doc "The sessions to try, in order, for a receipt of a message that arrived from `origin`."
  @spec candidates(origin(), Trunk.affinity()) :: [pid()]
  def candidates(origin, mode) do
    own = if origin.bind in [:rx, :trx], do: Sessions.receiver(origin.session_id), else: []

    cond do
      own != [] and mode == :strict ->
        own

      mode == :same_trunk ->
        Enum.uniq(own ++ same_ip(origin) ++ Sessions.receivers(origin.trunk_id))

      true ->
        Enum.uniq(own ++ same_ip(origin))
    end
  end

  defp same_ip(origin), do: Sessions.receivers(origin.trunk_id, origin.ip)
end
