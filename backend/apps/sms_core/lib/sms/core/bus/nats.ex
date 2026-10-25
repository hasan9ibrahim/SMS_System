defmodule Sms.Core.Bus.Nats do
  @moduledoc """
  The event bus on NATS JetStream (docs/BACKEND_PLAN.md). One stream (`SMS`, subjects `sms.>`) on file storage,
  replicated on 3 nodes in production; a publish is acknowledged once a majority of them hold it, so a published
  event survives a crash of any one node. Disk writes use the NATS default (every 2 minutes, deploy/nats/nats.conf):
  writing every event first halved capacity in the load test (product owner 2026-10-25, backend step 7).

  `publish/4` is a JetStream publish: it waits for the stream's acknowledgement, and the `Nats-Msg-Id` header makes a
  retried publish a no-op within the duplicate window.

  The node keeps `:connections` connections (default 4): one connection process carried every publish and every
  consumer's pulls, and became the limit under load (backend step 7). A process always publishes on the same
  connection, so its own events keep their order; consumers' pullers are spread over the connections.

  A queue (`Sms.Core.Bus.put/4`) is a durable consumer named `q-<queue>` on `sms.q.<queue>`, created before its first
  event is published (a consumer created later would replay older events) and never deleted. `take/1` asks it for one
  message at a time without waiting; an event not acknowledged within `@queue_ack_wait_ms` is handed out again.
  """
  @behaviour Sms.Core.Bus.Adapter
  alias Gnat.Jetstream.API.Stream
  alias Sms.Core.Bus

  @conn :sms_bus_nats

  @doc false
  def connection, do: @conn

  @doc false
  # The `i`-th connection (any integer, wrapped onto the pool); the first is `connection/0`.
  @spec connection(integer()) :: atom()
  def connection(i) do
    case rem(abs(i), connections()) do
      0 -> @conn
      n -> :"#{@conn}_#{n + 1}"
    end
  end

  defp connections, do: Keyword.get(Bus.config(), :connections, 1)

  @impl Sms.Core.Bus.Adapter
  def child_spec(config) do
    settings = connection_settings(nats_config())

    connections =
      for i <- 0..(Keyword.get(config, :connections, 1) - 1) do
        Supervisor.child_spec(
          {Gnat.ConnectionSupervisor,
           %{name: connection(i), backoff_period: 1_000, connection_settings: settings}},
          id: {Gnat.ConnectionSupervisor, i}
        )
      end

    children = connections ++ [{__MODULE__.Setup, config}, __MODULE__.Queues]

    %{
      id: __MODULE__,
      type: :supervisor,
      start: {Supervisor, :start_link, [children, [strategy: :rest_for_one, name: __MODULE__]]}
    }
  end

  @impl Sms.Core.Bus.Adapter
  def publish(subject, payload, msg_id, timeout) do
    case Gnat.request(connection(:erlang.phash2(self())), subject, payload,
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

    # Several pullers share one durable consumer (`:concurrency`); a batch consumer's puller hands every message to its
    # batcher, which acknowledges the batch once the handler has stored it.
    workers =
      if opts[:batch_size] do
        [
          {__MODULE__.Batcher, {module, opts}},
          Supervisor.child_spec({__MODULE__.Puller, {module, stream, opts, 0}},
            id: {__MODULE__.Puller, module, 0}
          )
        ]
      else
        for i <- 1..opts[:concurrency],
            do:
              Supervisor.child_spec({__MODULE__.Puller, {module, stream, opts, i}},
                id: {:puller, i}
              )
      end

    children = [{__MODULE__.EnsureConsumer, {stream, opts}} | workers]

    %{
      id: {__MODULE__, module},
      type: :supervisor,
      start: {Supervisor, :start_link, [children, [strategy: :rest_for_one]]}
    }
  end

  @impl Sms.Core.Bus.Adapter
  def backlog(consumer) do
    case Gnat.Jetstream.API.Consumer.info(@conn, Keyword.fetch!(Bus.config(), :stream), consumer) do
      {:ok, info} -> {:ok, info.num_pending + info.num_ack_pending}
      {:error, _} = error -> error
    end
  catch
    :exit, _ -> {:error, :not_connected}
  end

  # How long a taken queue event may stay unacknowledged before it is handed out again: a vendor buffer's message may
  # wait 30 s for its vendor, then a Submit Timeout and re-routes (backend step 7b).
  @queue_ack_wait_ms 300_000

  @impl Sms.Core.Bus.Adapter
  def ensure_queue(queue) do
    name = queue_consumer(queue)

    if __MODULE__.Queues.known?(name) do
      :ok
    else
      consumer = %Gnat.Jetstream.API.Consumer{
        stream_name: Keyword.fetch!(Bus.config(), :stream),
        durable_name: name,
        filter_subject: Bus.queue_subject(queue),
        ack_policy: :explicit,
        ack_wait: @queue_ack_wait_ms * 1_000_000,
        max_deliver: -1,
        max_ack_pending: 1_000,
        deliver_policy: :all
      }

      case Gnat.Jetstream.API.Consumer.create(@conn, consumer) do
        {:ok, _} -> __MODULE__.Queues.known(name)
        {:error, reason} -> {:error, reason}
      end
    end
  catch
    :exit, _ -> {:error, :not_connected}
  end

  @impl Sms.Core.Bus.Adapter
  def take(queue) do
    stream = Keyword.fetch!(Bus.config(), :stream)
    conn = connection(:erlang.phash2(queue))

    # A pulled message comes under its own subject to the reply inbox, which Gnat.request cannot match: own inbox.
    inbox = "_INBOX.q." <> Base.encode32(:crypto.strong_rand_bytes(10), padding: false)
    {:ok, sid} = Gnat.sub(conn, self(), inbox)

    try do
      :ok =
        Gnat.pub(
          conn,
          "$JS.API.CONSUMER.MSG.NEXT.#{stream}.#{queue_consumer(queue)}",
          ~s({"batch":1,"no_wait":true}),
          reply_to: inbox
        )

      receive do
        {:msg, %{sid: ^sid, status: status}} when status in ["404", "408"] ->
          :empty

        {:msg, %{sid: ^sid, status: status} = m} when is_binary(status) and status != "" ->
          {:error, {:jetstream, status, m[:description]}}

        {:msg, %{sid: ^sid, body: body, reply_to: reply_to}} ->
          {:ok, body, {conn, reply_to}}
      after
        2_000 -> {:error, :timeout}
      end
    after
      _ = Gnat.unsub(conn, sid)
    end
  catch
    :exit, _ -> {:error, :not_connected}
  end

  @impl Sms.Core.Bus.Adapter
  def ack({gnat, reply_to}) do
    Gnat.pub(gnat, reply_to, "")
  catch
    :exit, _ -> {:error, :not_connected}
  end

  @impl Sms.Core.Bus.Adapter
  def queues do
    stream = Keyword.fetch!(Bus.config(), :stream)
    list_queues(stream, 0, %{})
  catch
    :exit, _ -> {:error, :not_connected}
  end

  # JetStream lists consumers 256 at a time.
  defp list_queues(stream, offset, acc) do
    body = Jason.encode!(%{offset: offset})

    with {:ok, %{body: raw}} <- Gnat.request(@conn, "$JS.API.CONSUMER.LIST.#{stream}", body),
         {:ok, %{"consumers" => consumers, "total" => total}} <- Jason.decode(raw) do
      acc =
        for %{"name" => "q-" <> _ = name} = c <- consumers || [],
            n = (c["num_pending"] || 0) + (c["num_ack_pending"] || 0),
            n > 0,
            into: acc,
            do: {queue_name(name), n}

      next = offset + length(consumers || [])
      if consumers != [] and next < total, do: list_queues(stream, next, acc), else: {:ok, acc}
    else
      {:ok, %{"error" => error}} -> {:error, {:jetstream, error}}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc false
  # A queue's consumer name: NATS names cannot hold dots.
  @spec queue_consumer(String.t()) :: String.t()
  def queue_consumer(queue), do: "q-" <> String.replace(queue, ".", "-")

  defp queue_name("q-" <> rest), do: String.replace(rest, "-", ".")

  @impl Sms.Core.Bus.Adapter
  def health do
    case Stream.info(@conn, Keyword.fetch!(Bus.config(), :stream)) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  catch
    :exit, _ -> {:error, :not_connected}
  end

  # Publishes wait for JetStream's ack: without nodelay, Nagle can hold a publish for the previous write's ACK (up to
  # 40 ms with delayed ACKs), which the load test found in every submit_sm_resp (backend step 7).
  @tcp_opts [:binary, nodelay: true]

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
        [host, port] ->
          Map.merge(%{host: host, port: String.to_integer(port), tcp_opts: @tcp_opts}, auth)

        [host] ->
          Map.merge(%{host: host, port: 4222, tcp_opts: @tcp_opts}, auth)
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

  defmodule Queues do
    @moduledoc false
    # The queues this node has created or found, so a put checks JetStream only the first time.
    use GenServer

    @table __MODULE__

    def start_link(_opts), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

    def known?(name), do: :ets.whereis(@table) != :undefined and :ets.member(@table, name)

    def known(name) do
      _ = :ets.whereis(@table) != :undefined and :ets.insert(@table, {name})
      :ok
    end

    @impl true
    def init(:ok) do
      :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
      {:ok, nil}
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
        max_deliver: if(opts[:max_deliver] == :infinity, do: -1, else: opts[:max_deliver]),
        max_ack_pending: max(1_000, max((opts[:batch_size] || 0) * 4, opts[:concurrency] * 4)),
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

    @fetch 256
    alias Sms.Core.Bus.{Consumer, Event, Nats}

    def start_link(arg), do: PullConsumer.start_link(__MODULE__, arg)

    @impl true
    def init({module, stream, opts, i}) do
      state = %{
        module: module,
        name: opts[:name],
        max_deliver: opts[:max_deliver],
        batcher: if(opts[:batch_size], do: Nats.Batcher.name(module))
      }

      {:ok, state,
       [connection_name: Nats.connection(i), stream_name: stream, consumer_name: opts[:name]] ++
         fetch_options(opts)}
    end

    # A batch consumer's puller fetches up to #{@fetch} events per pull request instead of one (the load test found
    # one-at-a-time pulls holding EDRs back, backend step 7). The client holds a partly filled fetch until the pull
    # expires: 1 s, and at most a quarter of ack_wait, so the batch is acknowledged before it would be delivered again.
    defp fetch_options(opts) do
      case opts[:batch_size] do
        nil -> []
        size -> [batch_size: min(size, @fetch), request_expires: expires_ms(opts) * 1_000_000]
      end
    end

    defp expires_ms(opts), do: min(1_000, div(opts[:ack_wait_ms], 4))

    @impl true
    def handle_message(message, %{batcher: batcher} = state) when batcher != nil do
      # Acknowledged by the batcher once the batch is stored.
      send(batcher, {:message, message})
      {:noreply, state}
    end

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
      if Consumer.given_up?(state.max_deliver, n),
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

    defp deliveries(message), do: Nats.deliveries(message)
  end

  @doc false
  # How many times a message has been delivered, from its reply subject:
  # $JS.ACK.<stream>.<consumer>.<delivered>.<stream seq>.<consumer seq>.<time>.<pending>
  def deliveries(%{reply_to: "$JS.ACK." <> rest}) do
    case String.split(rest, ".") do
      [_stream, _consumer, n | _] -> String.to_integer(n)
      _ -> 1
    end
  end

  def deliveries(_), do: 1

  defmodule Batcher do
    @moduledoc false
    # Collects a batch consumer's messages and hands them to `handle_batch/1` when `batch_size` are waiting or
    # `batch_wait_ms` after the first one. Stored → every message acknowledged; failed → none is, so JetStream delivers
    # them all again after ack_wait. Unreadable messages are terminated (never delivered again).
    use GenServer
    require Logger
    alias Gnat.Jetstream
    alias Sms.Core.Bus.{Consumer, Event}

    def name(module), do: Module.concat(module, Batcher)

    def start_link({module, opts}),
      do: GenServer.start_link(__MODULE__, {module, opts}, name: name(module))

    @impl true
    def init({module, opts}) do
      {:ok, %{module: module, opts: opts, batch: [], count: 0, timer: nil}}
    end

    @impl true
    def handle_info({:message, message}, state) do
      case Event.decode(message.body) do
        {:ok, event} ->
          state = %{state | batch: [{event, message} | state.batch], count: state.count + 1}

          state =
            if state.timer,
              do: state,
              else: %{
                state
                | timer: Process.send_after(self(), :flush, state.opts[:batch_wait_ms])
              }

          if state.count >= state.opts[:batch_size],
            do: {:noreply, flush(state)},
            else: {:noreply, state}

        {:error, reason} ->
          Logger.error("unreadable event discarded",
            consumer: state.opts[:name],
            reason: inspect(reason)
          )

          Jetstream.ack_term(message)
          {:noreply, state}
      end
    end

    def handle_info(:flush, state), do: {:noreply, flush(%{state | timer: nil})}

    defp flush(%{batch: []} = state), do: state

    defp flush(state) do
      _ = if state.timer, do: Process.cancel_timer(state.timer)
      entries = Enum.reverse(state.batch)

      case Consumer.run_batch(state.module, Enum.map(entries, &elem(&1, 0))) do
        :ok ->
          Enum.each(entries, fn {_event, message} -> Jetstream.ack(message) end)

        {:error, reason} ->
          Logger.warning("batch failed, will be delivered again",
            consumer: state.opts[:name],
            reason: inspect(reason),
            events: length(entries)
          )
      end

      %{state | batch: [], count: 0, timer: nil}
    end
  end
end
