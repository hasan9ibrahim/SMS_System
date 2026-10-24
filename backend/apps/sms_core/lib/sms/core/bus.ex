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

  @doc false
  @spec adapter() :: module()
  def adapter, do: Keyword.fetch!(config(), :adapter)

  @doc false
  @spec config() :: keyword()
  def config, do: Application.fetch_env!(:sms_core, __MODULE__)
end
