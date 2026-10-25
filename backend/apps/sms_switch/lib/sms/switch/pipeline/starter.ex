defmodule Sms.Switch.Pipeline.Starter do
  @moduledoc """
  Starts the pipeline's bus consumers once the routing configuration is loaded (backend step 7). A server restarted
  under traffic otherwise pulled accepted messages before it could route them: each attempt failed and counted
  against the event's deliveries, and a message out of deliveries was dropped (found by the failover test).

  Until then the other server takes the work on the shared consumers. The configuration is checked every 200 ms; the
  consumers run under their own supervisor, linked to this process, and stop with it.
  """
  use GenServer
  require Logger
  alias Sms.Switch.Pipeline.Config

  @check_ms 200

  @doc "Options: `:children` (the consumers) and `:ready?` (a function, default: the configuration is loaded)."
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def child_spec(opts),
    do: %{
      id: __MODULE__,
      start: {__MODULE__, :start_link, [opts]},
      type: :supervisor,
      shutdown: :infinity
    }

  @doc "Whether the consumers are running."
  @spec started?() :: boolean()
  def started?, do: GenServer.call(__MODULE__, :started?)

  @impl true
  def init(opts) do
    Process.flag(:trap_exit, true)
    send(self(), :check)

    {:ok,
     %{
       children: Keyword.fetch!(opts, :children),
       ready?: Keyword.get(opts, :ready?, &Config.ready?/0),
       sup: nil
     }}
  end

  @impl true
  def handle_call(:started?, _from, state), do: {:reply, state.sup != nil, state}

  @impl true
  def handle_info(:check, state) do
    if state.ready?.() do
      {:ok, sup} = Supervisor.start_link(state.children, strategy: :one_for_one)
      Logger.info("routing configuration loaded: pipeline consumers started")
      {:noreply, %{state | sup: sup}}
    else
      Process.send_after(self(), :check, @check_ms)
      {:noreply, state}
    end
  end

  # The consumers' supervisor gave up: so does this, and the pipeline supervisor starts both again.
  def handle_info({:EXIT, pid, reason}, %{sup: pid} = state),
    do: {:stop, reason, %{state | sup: nil}}

  def handle_info({:EXIT, _pid, _reason}, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, %{sup: nil}), do: :ok
  def terminate(_reason, %{sup: sup}), do: Supervisor.stop(sup, :shutdown)
end
