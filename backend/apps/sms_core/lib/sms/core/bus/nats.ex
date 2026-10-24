defmodule Sms.Core.Bus.Nats do
  @moduledoc """
  The event bus on NATS JetStream (docs/BACKEND_PLAN.md). One stream (`SMS`, subjects `sms.>`) on file storage,
  replicated on 3 nodes in production; the server writes every message to disk before it acknowledges it
  (`sync_interval: always`, deploy/nats/nats.conf), so a published event survives a crash of any one node.

  `publish/4` is a JetStream publish: it waits for the stream's acknowledgement, and the `Nats-Msg-Id` header makes a
  retried publish a no-op within the duplicate window.
  """
  @behaviour Sms.Core.Bus.Adapter
  alias Gnat.Jetstream.API.Stream
  alias Sms.Core.Bus

  @conn :sms_bus_nats

  @doc false
  def connection, do: @conn

  @impl Sms.Core.Bus.Adapter
  def child_spec(config) do
    children = [
      {Gnat.ConnectionSupervisor,
       %{
         name: @conn,
         backoff_period: 1_000,
         connection_settings: connection_settings(nats_config())
       }},
      {__MODULE__.Setup, config}
    ]

    %{
      id: __MODULE__,
      type: :supervisor,
      start: {Supervisor, :start_link, [children, [strategy: :rest_for_one, name: __MODULE__]]}
    }
  end

  @impl Sms.Core.Bus.Adapter
  def publish(subject, payload, msg_id, timeout) do
    case Gnat.request(@conn, subject, payload,
           headers: [{"Nats-Msg-Id", msg_id}],
           receive_timeout: timeout
         ) do
      {:ok, %{body: body}} -> parse_ack(body)
      {:error, :no_responders} -> {:error, :no_stream_for_subject}
      {:error, reason} -> {:error, reason}
    end
  catch
    :exit, _ -> {:error, :not_connected}
  end

  @doc false
  # JetStream's answer to a publish: stored, refused (e.g. too large), or something unexpected.
  @spec parse_ack(binary()) :: :ok | {:error, term()}
  def parse_ack(body) do
    case Jason.decode(body) do
      {:ok, %{"stream" => _, "seq" => _}} -> :ok
      {:ok, %{"error" => error}} -> {:error, {:jetstream, error}}
      _ -> {:error, {:unexpected_ack, body}}
    end
  end

  @impl Sms.Core.Bus.Adapter
  def consumer_child_spec(module, opts) do
    stream = Keyword.fetch!(Bus.config(), :stream)

    children = [
      {__MODULE__.EnsureConsumer, {stream, opts}},
      {__MODULE__.Puller, {module, stream, opts}}
    ]

    %{
      id: {__MODULE__, module},
      type: :supervisor,
      start: {Supervisor, :start_link, [children, [strategy: :rest_for_one]]}
    }
  end

  @impl Sms.Core.Bus.Adapter
  def health do
    case Stream.info(@conn, Keyword.fetch!(Bus.config(), :stream)) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  catch
    :exit, _ -> {:error, :not_connected}
  end

  @doc false
  # "host:port,host:port" (the 2 servers + witness) into Gnat connection settings.
  @spec connection_settings(keyword()) :: [map()]
  def connection_settings(config) do
    auth =
      case {config[:username], config[:password]} do
        {user, pass} when is_binary(user) and is_binary(pass) -> %{username: user, password: pass}
        _ -> %{}
      end

    config
    |> Keyword.fetch!(:hosts)
    |> String.split(",", trim: true)
    |> Enum.map(fn host_port ->
      case String.split(String.trim(host_port), ":") do
        [host, port] -> Map.merge(%{host: host, port: String.to_integer(port)}, auth)
        [host] -> Map.merge(%{host: host, port: 4222}, auth)
      end
    end)
  end

  @doc false
  @spec stream_config(keyword()) :: Stream.t()
  def stream_config(config) do
    %Stream{
      name: Keyword.fetch!(config, :stream),
      subjects: Keyword.fetch!(config, :subjects),
      storage: :file,
      retention: :limits,
      discard: :old,
      num_replicas: Keyword.fetch!(config, :replicas),
      max_age: :timer.hours(24 * Keyword.fetch!(config, :max_age_days)) * 1_000_000,
      duplicate_window: Keyword.fetch!(config, :duplicate_window_ms) * 1_000_000
    }
  end

  defp nats_config, do: Application.fetch_env!(:sms_core, __MODULE__)

  @doc false
  # Waits until `fun` returns {:ok, value} (the connection may still be coming up), for at most ~30 s.
  @spec retry((-> {:ok, term()} | {:error, term()}), non_neg_integer()) ::
          {:ok, term()} | {:error, term()}
  def retry(fun, attempts \\ Keyword.fetch!(Bus.config(), :setup_attempts)) do
    case safe(fun) do
      {:ok, _} = ok ->
        ok

      {:error, _} = error when attempts <= 1 ->
        error

      {:error, _} ->
        Process.sleep(1_000)
        retry(fun, attempts - 1)
    end
  end

  defp safe(fun) do
    fun.()
  catch
    :exit, reason -> {:error, {:exit, reason}}
  end

  defmodule Setup do
    @moduledoc false
    # Creates the stream, or brings an existing one to the configured settings, before any consumer starts.
    use GenServer, restart: :permanent
    require Logger
    alias Gnat.Jetstream.API.Stream
    alias Sms.Core.Bus.Nats

    def start_link(config), do: GenServer.start_link(__MODULE__, config)

    @impl true
    def init(config) do
      stream = Nats.stream_config(config)

      case Nats.retry(fn -> ensure(stream) end) do
        {:ok, _} -> {:ok, stream.name}
        {:error, reason} -> {:stop, {:stream_setup_failed, reason}}
      end
    end

    defp ensure(stream) do
      conn = Nats.connection()

      case Stream.info(conn, stream.name) do
        {:ok, _} -> Stream.update(conn, stream)
        {:error, %{"err_code" => 10_059}} -> Stream.create(conn, stream)
        {:error, reason} -> {:error, reason}
      end
    end
  end

  defmodule EnsureConsumer do
    @moduledoc false
    # Creates the durable consumer if it does not exist yet. An existing one keeps its position; it is never
    # deleted here, because that would lose where it was.
    use GenServer, restart: :permanent
    require Logger
    alias Gnat.Jetstream.API.Consumer
    alias Sms.Core.Bus.Nats

    def start_link(arg), do: GenServer.start_link(__MODULE__, arg)

    @impl true
    def init({stream, opts}) do
      consumer = %Consumer{
        stream_name: stream,
        durable_name: opts[:name],
        filter_subject: opts[:filter],
        ack_policy: :explicit,
        ack_wait: opts[:ack_wait_ms] * 1_000_000,
        max_deliver: opts[:max_deliver],
        max_ack_pending: 1_000,
        deliver_policy: :all
      }

      case Nats.retry(fn -> ensure(consumer) end) do
        {:ok, _} -> {:ok, opts[:name]}
        {:error, reason} -> {:stop, {:consumer_setup_failed, opts[:name], reason}}
      end
    end

    defp ensure(consumer) do
      conn = Nats.connection()

      case Consumer.info(conn, consumer.stream_name, consumer.durable_name) do
        {:ok, %{config: %{filter_subject: filter}} = info}
        when filter == consumer.filter_subject ->
          {:ok, info}

        {:ok, _other} ->
          {:error, {:consumer_exists_with_another_filter, consumer.durable_name}}

        {:error, %{"err_code" => 10_014}} ->
          Consumer.create(conn, consumer)

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defmodule Puller do
    @moduledoc false
    # Feeds one durable consumer its events. Done → ack; discard → term (never again); error → no reply, so
    # JetStream delivers it again after ack_wait, up to max_deliver times.
    use Gnat.Jetstream.PullConsumer
    require Logger
    alias Gnat.Jetstream.PullConsumer
    alias Sms.Core.Bus.{Consumer, Event, Nats}

    def start_link(arg), do: PullConsumer.start_link(__MODULE__, arg)

    @impl true
    def init({module, stream, opts}) do
      state = %{module: module, name: opts[:name], max_deliver: opts[:max_deliver]}

      {:ok, state,
       connection_name: Nats.connection(), stream_name: stream, consumer_name: opts[:name]}
    end

    @impl true
    def handle_message(message, state) do
      case Event.decode(message.body) do
        {:ok, event} ->
          {outcome(Consumer.run(state.module, event), event.id, deliveries(message), state),
           state}

        {:error, reason} ->
          Logger.error("unreadable event discarded",
            consumer: state.name,
            reason: inspect(reason)
          )

          {:term, state}
      end
    end

    defp outcome(:ok, _id, _n, _state), do: :ack

    defp outcome({:discard, reason}, id, _n, state) do
      Logger.error("event discarded", event_id: id, consumer: state.name, reason: inspect(reason))
      :term
    end

    defp outcome({:error, reason}, id, n, state) do
      if n >= state.max_deliver,
        do:
          Logger.error("event failed on every delivery, given up",
            event_id: id,
            consumer: state.name,
            reason: inspect(reason)
          ),
        else:
          Logger.warning("event failed, will be delivered again",
            event_id: id,
            consumer: state.name,
            reason: inspect(reason)
          )

      :noreply
    end

    # $JS.ACK.<stream>.<consumer>.<delivered>.<stream seq>.<consumer seq>.<time>.<pending>
    defp deliveries(%{reply_to: "$JS.ACK." <> rest}) do
      case String.split(rest, ".") do
        [_stream, _consumer, n | _] -> String.to_integer(n)
        _ -> 1
      end
    end

    defp deliveries(_), do: 1
  end
end
