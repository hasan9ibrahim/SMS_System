defmodule Sms.Switch.Pipeline.Credit do
  @moduledoc """
  The credit check before a message is accepted (spec §7: prepaid traffic stops at zero plus credit, postpaid at the
  credit limit; decision Q24: exact and atomic per message, all its parts, with a short grace on the last known
  balance while the balance store is unreachable).

  `check/1` gets the message as the intake built it (trunk, rate, parts) and answers `:ok` or `{:error, status}`;
  the intake refuses the message with that status. Balances counted in Redis and recorded in PostgreSQL come with
  billing at send time (build step 6); until then `Sms.Switch.Pipeline.Credit.Open` lets every message through.
  """

  @callback check(message :: map()) ::
              :ok | {:error, Sms.Switch.Smpp.Status.name() | pos_integer()}

  @doc "The configured implementation (`config :sms_switch, Sms.Switch.Pipeline, credit: Module`)."
  @spec impl() :: module()
  def impl,
    do:
      :sms_switch
      |> Application.get_env(Sms.Switch.Pipeline, [])
      |> Keyword.get(:credit, __MODULE__.Open)

  defmodule Open do
    @moduledoc "No credit limit yet (build step 6 brings balances)."
    @behaviour Sms.Switch.Pipeline.Credit

    @impl true
    def check(_message), do: :ok
  end
end
