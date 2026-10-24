defmodule Sms.Switch.Customer do
  @moduledoc """
  The customer side of the switch, where it is the SMSC (spec §2, §5.4, §13.1; build step 2).

  Clients connect to the listeners (`Sms.Switch.Customer.Listener`), each connection is a
  `Sms.Switch.Customer.Session`, binds are checked against the trunks in `Sms.Switch.Customer.TrunkStore`, and every
  message request goes to `Sms.Switch.Customer.Intake` (the message pipeline, step 4).

  This module is the entry point for the rest of the switch: receipts (`deliver/4`), draining a node before it
  stops (S-1.16) and listing sessions (Network Status).

  Settings live under `config :sms_switch, Sms.Switch.Customer`:

    * `:enabled`: start the customer side (off in unit tests, which start the parts they need);
    * `:listeners`: e.g. `[[port: 2775], [port: 3550, tls: true], [port: 2780, proxy_protocol: true]]`;
    * `:tls`: `[certfile: ..., keyfile: ..., cacertfile: ...]` for the TLS listeners;
    * `:session`: see `Sms.Switch.Customer.Session` (timeouts, windows);
    * `:intake`: the `Sms.Switch.Customer.Intake` implementation;
    * `:trunk_refresh_ms`.
  """
  alias Sms.Switch.Customer.{Affinity, Listener, Session, Sessions, Trunk, TrunkStore}

  @draining {__MODULE__, :draining}

  @doc """
  Sends a receipt (a `deliver_sm` with these fields and TLVs) for a message that arrived from `origin`, to the
  first session that §13.1 allows and that takes it (`Sms.Switch.Customer.Affinity`).

  Returns `{:ok, session_id, response}` once the client has answered (a non-zero `response.status` is the client
  refusing it), `{:error, :timeout, session_id}` when that session did not answer (the client may have it; retry
  on the same session, S-5.14), or `:hold` when no allowed session can take it now (none bound, all windows full):
  the caller keeps it and tries again, for instance when `sms.session.customer.bound` says a session bound.
  """
  @spec deliver(Affinity.origin(), Trunk.affinity(), map(), list()) ::
          {:ok, String.t(), map()}
          | {:error, :timeout, String.t()}
          | {:error, {:invalid_pdu, term()}}
          | :hold
  def deliver(origin, mode, fields, tlvs \\ []) do
    origin |> Affinity.candidates(mode) |> try_deliver(fields, tlvs)
  end

  defp try_deliver([], _fields, _tlvs), do: :hold

  defp try_deliver([pid | rest], fields, tlvs) do
    case Session.deliver(pid, fields, tlvs) do
      {:ok, response} ->
        {:ok, Map.fetch!(response, :session_id), Map.delete(response, :session_id)}

      {:error, :timeout} ->
        {:error, :timeout, session_id(pid)}

      {:error, {:invalid_pdu, _}} = error ->
        error

      {:error, _busy_or_gone} ->
        try_deliver(rest, fields, tlvs)
    end
  end

  defp session_id(pid) do
    Session.info(pid).id
  catch
    :exit, _ -> nil
  end

  @doc """
  Starts draining this node (S-1.16): listeners stop accepting connections, new binds are refused and new
  `submit_sm` / `data_sm` get 0x58 so clients send them to the other server; answers already being decided still go
  out. Stop the node once the sessions' in-flight counts reach zero.
  """
  @spec drain() :: :ok
  def drain do
    :persistent_term.put(@draining, true)
    Listener.suspend_all()
  end

  @doc "Ends draining: listeners accept again and submits are taken."
  @spec resume() :: :ok
  def resume do
    :persistent_term.erase(@draining)
    Listener.resume_all()
  end

  @doc "Whether this node is draining."
  @spec draining?() :: boolean()
  def draining?, do: :persistent_term.get(@draining, false)

  @doc "The sessions bound on this node (Network Status, §13.1)."
  @spec sessions() :: [map()]
  def sessions do
    for {pid, meta} <- Sessions.local(), do: Map.put(meta, :pid, pid)
  end

  @doc "Reloads the customer trunks now (after a trunk is saved; also done every few seconds)."
  @spec reload_trunks() :: {:ok, non_neg_integer()} | {:error, term()}
  def reload_trunks, do: TrunkStore.refresh()
end
