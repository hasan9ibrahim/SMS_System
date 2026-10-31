defmodule Sms.Switch.Pipeline.Credit do
  @moduledoc """
  The credit check before a message is accepted (spec §7: prepaid traffic stops at zero plus credit, postpaid at the
  credit limit; decision Q24: exact and atomic per message, all its parts, with a short grace on the last known
  balance while the balance store is unreachable).

  The checks get the message as the intake built it (trunk, rate, parts, route) and answer `:ok` or
  `{:error, status}`; the intake refuses the message with that status:

    * `reserve/1`: the check and the hold of the message's cost against the account, in one step, so messages in
      flight count until they are charged or released (S-6.3, decision 2026-10-31);
    * `check/1`: the same check without a hold (a scheduled message at intake, S-2.12: held at its release);
    * `unreserve/1`: gives the hold back at once for a message that was not stored after all.

  `Sms.Switch.Pipeline.Ledger` implements it; `Sms.Switch.Pipeline.Credit.Open` lets every message through.
  """

  @callback check(message :: map()) ::
              :ok | {:error, Sms.Switch.Smpp.Status.name() | pos_integer()}

  @callback reserve(message :: map()) ::
              :ok | {:error, Sms.Switch.Smpp.Status.name() | pos_integer()}

  @callback unreserve(message :: map()) :: :ok

  @doc "The configured implementation (`config :sms_switch, Sms.Switch.Pipeline, credit: Module`)."
  @spec impl() :: module()
  def impl,
    do:
      :sms_switch
      |> Application.get_env(Sms.Switch.Pipeline, [])
      |> Keyword.get(:credit, __MODULE__.Open)

  defmodule Open do
    @moduledoc "No credit limit (a deployment without balances)."
    @behaviour Sms.Switch.Pipeline.Credit

    @impl true
    def check(_message), do: :ok

    @impl true
    def reserve(_message), do: :ok

    @impl true
    def unreserve(_message), do: :ok
  end
end
