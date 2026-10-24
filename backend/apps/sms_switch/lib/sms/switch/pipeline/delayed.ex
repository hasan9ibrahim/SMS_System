defmodule Sms.Switch.Pipeline.Delayed do
  @moduledoc """
  Delayed Submit customer trunks (§5 "respond submit_sm_resp only after vendor accepts", docs/SMPP_SCENARIOS.md S-2.18,
  decision D11), the one exception to S-2.2: the intake stores the message as usual, then waits for the sender's final
  outcome, after any re-route, and only then answers.

    * a vendor accepted it → OK with our message id;
    * no vendor took it → the last vendor's error status (0x45 when it was a timeout or not an SMPP error); the
      customer then gets no receipt for it, the resp carried the outcome.

  No wait limit of our own (D11): the vendors' Submit Timeouts decide. `:delayed_wait_ms` (10 minutes) only stops a
  waiting process living for ever if the bus stalls; the client has timed out long before.

  The waiting intake joins a cluster-wide `:pg` group named after the message, so the sender finds it on either
  server. A message put together from its parts is not waited for: each part was answered when it came (S-3.2).
  """
  alias Sms.Switch.Smpp.Status

  @scope :sms_delayed_submit
  @default_wait_ms 600_000

  @doc false
  def child_spec(_opts), do: %{id: @scope, start: {:pg, :start_link, [@scope]}}

  @doc "Whether the message's resp waits for its vendor."
  @spec delayed?(map()) :: boolean()
  def delayed?(msg),
    do: msg.trunk[:delayed_submit] == true and not Map.get(msg, :reassembled, false)

  @doc "Starts waiting for message `id`: call before the message is stored, so an outcome is never missed."
  @spec join(String.t()) :: :ok
  def join(id), do: :pg.join(@scope, {:delayed, id}, self())

  @doc "Stops waiting (the message was refused or not stored)."
  @spec leave(String.t()) :: :ok | :not_joined
  def leave(id), do: :pg.leave(@scope, {:delayed, id}, self())

  @doc "Waits for the outcome of message `id`: the intake's reply."
  @spec await(String.t()) :: {:ok, map(), list()} | {:error, Status.name()}
  def await(id) do
    receive do
      {:delayed, ^id, outcome} ->
        _ = leave(id)
        reply(id, outcome)
    after
      wait_ms() ->
        _ = leave(id)
        {:error, :esme_rsubmitfail}
    end
  end

  defp reply(id, :ok), do: {:ok, %{message_id: id}, []}
  defp reply(_id, {:error, code}), do: {:error, status(code)}

  defp status(code) do
    case is_integer(code) and code != 0 and Status.name(code) do
      name when is_atom(name) and name not in [nil, false] -> name
      _ -> :esme_rsubmitfail
    end
  end

  @doc "Tells the waiting intake, if any, the outcome; true when one was waiting."
  @spec notify(String.t(), :ok | {:error, integer() | nil}) :: boolean()
  def notify(id, outcome) do
    members = :pg.get_members(@scope, {:delayed, id})
    Enum.each(members, &send(&1, {:delayed, id, outcome}))
    members != []
  end

  defp wait_ms,
    do:
      :sms_switch
      |> Application.get_env(Sms.Switch.Pipeline, [])
      |> Keyword.get(:delayed_wait_ms, @default_wait_ms)
end
