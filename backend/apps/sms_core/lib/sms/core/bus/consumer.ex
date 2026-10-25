defmodule Sms.Core.Bus.Consumer do
  @moduledoc """
  A durable consumer of bus events: it sees every event matching its filter at least once, survives restarts where it
  left off, and gets an event again when handling it failed. Handlers must therefore be idempotent (the event id is
  the key).

      defmodule Sms.Billing.Rater do
        use Sms.Core.Bus.Consumer, name: "billing-rater", filter: "sms.msg.>"

        @impl true
        def handle_event(%Sms.Core.Bus.Event{} = event), do: ...
      end

  Return `:ok` when done, `{:error, reason}` to have the event delivered again (up to `max_deliver` times, with
  growing delays), or `{:discard, reason}` for an event that can never be handled (logged, not retried). A handler
  that raises counts as `{:error, _}`.

  Options:

    * `:max_deliver` (default 10; `:infinity` never gives up, for events that must never be lost);
    * `:ack_wait_ms` (default 30 s): how long a delivery may take before it is delivered again;
    * `:concurrency` (default 1): events handled at once on each node (several workers share the durable consumer);
    * `:batch_size`: hand events over in batches of up to this many to `handle_batch/1` instead of one by one to
      `handle_event/1`, after at most `:batch_wait_ms` (default 200 ms). The batch is acknowledged only when
      `handle_batch/1` returns `:ok`; on an error every event of the batch is delivered again after `:ack_wait_ms`.
  """
  alias Sms.Core.Bus
  alias Sms.Core.Bus.{Event, Subject}

  @type result :: :ok | {:error, term()} | {:discard, term()}
  @type options :: [
          name: String.t(),
          filter: String.t(),
          max_deliver: pos_integer() | :infinity,
          ack_wait_ms: pos_integer(),
          progress_ms: pos_integer() | nil,
          concurrency: pos_integer(),
          batch_size: pos_integer() | nil,
          batch_wait_ms: pos_integer()
        ]

  @callback handle_event(Event.t()) :: result()
  @callback handle_batch([Event.t()]) :: :ok | {:error, term()}
  @optional_callbacks handle_event: 1, handle_batch: 1

  defmacro __using__(opts) do
    quote bind_quoted: [opts: opts, consumer: __MODULE__] do
      @behaviour consumer
      @consumer_opts consumer.validate!(opts)

      @doc false
      def child_spec(_arg), do: unquote(consumer).child_spec_for(__MODULE__, @consumer_opts)

      @doc false
      def consumer_options, do: @consumer_opts
    end
  end

  @doc false
  # The adapter's process for `module`, under the module's own name so it can be stopped by name.
  @spec child_spec_for(module(), options()) :: Supervisor.child_spec()
  def child_spec_for(module, opts) do
    Supervisor.child_spec(Bus.adapter().consumer_child_spec(module, opts), id: module)
  end

  @doc false
  @spec validate!(keyword()) :: options()
  def validate!(opts) do
    name = Keyword.fetch!(opts, :name)
    filter = Keyword.fetch!(opts, :filter)

    check!(
      is_binary(name) and Regex.match?(~r/\A[a-z0-9][a-z0-9_-]{0,63}\z/, name),
      "consumer name must be lower-case letters, digits, - or _: #{inspect(name)}"
    )

    check!(
      Subject.valid_filter?(filter) and String.starts_with?(filter, "sms."),
      "consumer filter must be a valid subject filter under sms.: #{inspect(filter)}"
    )

    max_deliver = Keyword.get(opts, :max_deliver, 10)
    concurrency = Keyword.get(opts, :concurrency, 1)
    batch_size = Keyword.get(opts, :batch_size)

    check!(
      max_deliver == :infinity or pos_integer?(max_deliver),
      "max_deliver must be a positive integer or :infinity: #{inspect(max_deliver)}"
    )

    check!(
      pos_integer?(concurrency),
      "concurrency must be a positive integer: #{inspect(concurrency)}"
    )

    progress_ms = Keyword.get(opts, :progress_ms)

    check!(
      is_nil(progress_ms) or pos_integer?(progress_ms),
      "progress_ms must be a positive integer: #{inspect(progress_ms)}"
    )

    check!(
      is_nil(batch_size) or pos_integer?(batch_size),
      "batch_size must be a positive integer: #{inspect(batch_size)}"
    )

    [
      name: name,
      filter: filter,
      max_deliver: max_deliver,
      ack_wait_ms: Keyword.get(opts, :ack_wait_ms, 30_000),
      progress_ms: progress_ms,
      concurrency: concurrency,
      batch_size: batch_size,
      batch_wait_ms: Keyword.get(opts, :batch_wait_ms, 200)
    ]
  end

  defp check!(true, _message), do: :ok
  defp check!(false, message), do: raise(ArgumentError, message)

  defp pos_integer?(value), do: is_integer(value) and value > 0

  @doc false
  # Runs a batch handler; a raise or a bad return is an error, so the whole batch comes back.
  @spec run_batch(module(), [Event.t()]) :: :ok | {:error, term()}
  def run_batch(consumer, events) do
    case consumer.handle_batch(events) do
      :ok -> :ok
      {:error, _} = error -> error
      other -> {:error, {:bad_return, other}}
    end
  rescue
    e -> {:error, {:raised, Exception.message(e)}}
  end

  @doc false
  # Whether `max_deliver` deliveries have been made (never for :infinity).
  @spec given_up?(pos_integer() | :infinity, pos_integer()) :: boolean()
  def given_up?(:infinity, _n), do: false
  def given_up?(max, n), do: n >= max

  @doc false
  # Runs the handler for one delivery; a raise or a bad return is an error, so the event comes back.
  @spec run(module(), Event.t()) :: result()
  def run(consumer, %Event{} = event) do
    case consumer.handle_event(event) do
      :ok -> :ok
      {:error, _} = error -> error
      {:discard, _} = discard -> discard
      other -> {:error, {:bad_return, other}}
    end
  rescue
    e -> {:error, {:raised, Exception.message(e)}}
  end
end
