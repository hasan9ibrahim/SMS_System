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
  """
  alias Sms.Core.Bus
  alias Sms.Core.Bus.{Event, Subject}

  @type result :: :ok | {:error, term()} | {:discard, term()}
  @type options :: [
          name: String.t(),
          filter: String.t(),
          max_deliver: pos_integer(),
          ack_wait_ms: pos_integer()
        ]

  @callback handle_event(Event.t()) :: result()

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

    unless is_binary(name) and Regex.match?(~r/\A[a-z0-9][a-z0-9_-]{0,63}\z/, name),
      do:
        raise(
          ArgumentError,
          "consumer name must be lower-case letters, digits, - or _: #{inspect(name)}"
        )

    unless Subject.valid_filter?(filter) and String.starts_with?(filter, "sms."),
      do:
        raise(
          ArgumentError,
          "consumer filter must be a valid subject filter under sms.: #{inspect(filter)}"
        )

    [
      name: name,
      filter: filter,
      max_deliver: Keyword.get(opts, :max_deliver, 10),
      ack_wait_ms: Keyword.get(opts, :ack_wait_ms, 30_000)
    ]
  end

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
