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
end
