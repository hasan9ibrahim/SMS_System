defmodule Sms.Core.Bus do
  @moduledoc """
  The event bus between the platform's services (docs/BACKEND_PLAN.md: NATS JetStream, behind this one module).

  `publish/4` returns only after the bus has stored the event (on three nodes in production), so an `:ok` means the
  event survives a crash. Consumers are `Sms.Core.Bus.Consumer` modules.

  Subjects are `sms.<area>.<what>`, e.g. `sms.msg.accepted`; the adapter, stream and limits are configured under
  `config :sms_core, Sms.Core.Bus`.
  """
  require Logger
  alias Sms.Core.Bus.{Event, Subject}

  @doc false
  def child_spec(_opts), do: Supervisor.child_spec(adapter().child_spec(config()), id: __MODULE__)

  @doc """
  Publishes an event and waits until it is stored. Options: `:id` (to retry a publish without duplicating it),
  `:version`, `:occurred_at`, `:timeout`.
  """
  @spec publish(String.t(), String.t(), map(), keyword()) :: {:ok, Event.t()} | {:error, term()}
  def publish(subject, type, data, opts \\ []) do
    cond do
      not Subject.valid_publish?(subject) ->
        {:error, {:invalid_subject, subject}}

      not (is_binary(type) and type != "") ->
        {:error, {:invalid_type, type}}

      not is_map(data) ->
        {:error, :data_must_be_a_map}

      true ->
        event = Event.new(subject, type, data, opts)
        timeout = Keyword.get(opts, :timeout, Keyword.fetch!(config(), :publish_timeout_ms))
        do_publish(event, timeout)
    end
  end

  defp do_publish(event, timeout) do
    meta = %{subject: event.subject, type: event.type}

    :telemetry.span([:sms, :bus, :publish], meta, fn ->
      result =
        try do
          adapter().publish(event.subject, Event.encode(event), event.id, timeout)
        rescue
          e in [Protocol.UndefinedError, Jason.EncodeError] ->
            {:error, {:not_encodable, Exception.message(e)}}
        end

      case result do
        :ok ->
          {{:ok, event}, Map.put(meta, :result, :ok)}

        {:error, reason} = error ->
          Logger.warning("event not published",
            event_id: event.id,
            subject: event.subject,
            reason: inspect(reason)
          )

          {error, Map.put(meta, :result, :error)}
      end
    end)
  end

  @doc "`:ok` when the bus accepts events."
  @spec health() :: :ok | {:error, term()}
  def health, do: adapter().health()

  @doc "How many events the consumer named `name` has not finished yet (waiting, or handed out and not acknowledged)."
  @spec backlog(String.t()) :: {:ok, non_neg_integer()} | {:error, term()}
  def backlog(name), do: adapter().backlog(name)

  # ---------------------------------------------------------------- queues

  @doc """
  Puts an event on the durable queue `queue` (e.g. `"ct.12"`, a customer trunk's overflow buffer) and waits until it is
  stored, like `publish/4`. Queues are taken one event at a time, oldest first (`take/1`), by whoever drains them at
  their own pace; each queue is separate, so a full one never holds the others back (backend step 7b).
  """
  @spec put(String.t(), String.t(), map(), keyword()) :: {:ok, Event.t()} | {:error, term()}
  def put(queue, type, data, opts \\ []) do
    with :ok <- ensure_queue(queue), do: publish(queue_subject(queue), type, data, opts)
  end

  @doc "The subject a queue's events are published under."
  @spec queue_subject(String.t()) :: String.t()
  def queue_subject(queue), do: "sms.q." <> queue

  @doc false
  @spec ensure_queue(String.t()) :: :ok | {:error, term()}
  def ensure_queue(queue) do
    if Subject.valid_publish?(queue_subject(queue)),
      do: adapter().ensure_queue(queue),
      else: {:error, {:invalid_queue, queue}}
  end

  @doc """
  The oldest event of a queue not handed out yet, and the handle to `ack/1` it once handled. An event taken and not
  acknowledged is handed out again later (after a crash). `:empty` when nothing waits.
  """
  @spec take(String.t()) :: {:ok, Event.t(), term()} | :empty | {:error, term()}
  def take(queue) do
    case adapter().take(queue) do
      {:ok, payload, handle} ->
        case Event.decode(payload) do
          {:ok, event} ->
            {:ok, event, handle}

          {:error, reason} ->
            Logger.error("unreadable event dropped from queue #{queue}: #{inspect(reason)}")
            _ = adapter().ack(handle)
            take(queue)
        end

      other ->
        other
    end
  end

  @doc "Acknowledges an event taken from a queue."
  @spec ack(term()) :: :ok | {:error, term()}
  def ack(handle), do: adapter().ack(handle)

  @doc "Every queue with events waiting or taken and not acknowledged, with that count."
  @spec queues() :: {:ok, %{String.t() => non_neg_integer()}} | {:error, term()}
  def queues, do: adapter().queues()

  @doc false
  @spec adapter() :: module()
  def adapter, do: Keyword.fetch!(config(), :adapter)

  @doc false
  @spec config() :: keyword()
  def config, do: Application.fetch_env!(:sms_core, __MODULE__)
end
