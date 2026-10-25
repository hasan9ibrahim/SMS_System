defmodule Sms.Core.Bus.Adapter do
  @moduledoc """
  What an event bus implementation provides. `Sms.Core.Bus.Nats` is the real one (NATS JetStream);
  `Sms.Core.Bus.Local` keeps everything in memory for tests. Swapping NATS for Kafka later means a new adapter here,
  nothing else (docs/BACKEND_PLAN.md).
  """

  @doc "The process tree the adapter needs (connection, stream setup)."
  @callback child_spec(keyword()) :: Supervisor.child_spec()

  @doc "Stores `payload` durably under `subject`; `:ok` only once it is stored. `msg_id` de-duplicates retries."
  @callback publish(subject :: String.t(), payload :: binary(), msg_id :: String.t(), timeout()) ::
              :ok | {:error, term()}

  @doc "The process that feeds `consumer` (a `Sms.Core.Bus.Consumer`) its events."
  @callback consumer_child_spec(consumer :: module(), Sms.Core.Bus.Consumer.options()) ::
              Supervisor.child_spec()

  @doc "`:ok` when the bus accepts events."
  @callback health() :: :ok | {:error, term()}

  @doc "How many events a consumer has not finished yet: waiting for it, and handed out but not acknowledged."
  @callback backlog(consumer :: String.t()) :: {:ok, non_neg_integer()} | {:error, term()}
  @callback waiting(consumer :: String.t()) :: {:ok, non_neg_integer()} | {:error, term()}

  @doc """
  Creates the durable queue `queue` (events published to `sms.q.<queue>`) if it does not exist yet. A queue keeps its
  position for ever: it is never deleted, so its events are never handed out twice.
  """
  @callback ensure_queue(queue :: String.t()) :: :ok | {:error, term()}

  @doc "The oldest event of a queue not handed out yet, with the handle to acknowledge it; `:empty` when none waits."
  @callback take(queue :: String.t()) :: {:ok, binary(), term()} | :empty | {:error, term()}

  @doc "Acknowledges an event taken from a queue: it is never handed out again."
  @callback ack(handle :: term()) :: :ok | {:error, term()}

  @doc "Every queue with events waiting or taken and not acknowledged, with that count."
  @callback queues() :: {:ok, %{String.t() => non_neg_integer()}} | {:error, term()}
end
