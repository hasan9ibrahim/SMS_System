defmodule Sms.Switch.Pipeline.Backlog do
  @moduledoc """
  Overload protection (backend step 7). The intake answers a submit as soon as the message is stored on the bus; the
  sender takes it from there. The load test showed that past the machine's capacity the intake keeps accepting while
  the sender falls behind, so messages pile up on the bus and leave minutes late, though the customer was told they
  were accepted.

  The guard is **how long accepted messages wait** before the sender takes them (product owner 2026-10-25): the sender
  reports each message's wait (`observe/1`, from the time it was accepted), and every `:interval_ms` (1 s) the
  shortest wait of the messages taken in that second is compared with `:max_wait_ms` (default 10 s,
  `SWITCH_MAX_WAIT_MS`; 0 = off). The queue is first in, first out, so when even the freshest message taken had waited
  that long, every message is that late. Then the intake refuses new messages with 0x58 (throttled: the customer's
  platform slows down and retries) until the wait is back under 80 % of it. The shortest wait is used so a single old
  message delivered again after a crash does not trip it.

  A safety cap on the number of accepted messages not yet finished (`Sms.Core.Bus.backlog/1` of `pipeline-sender`,
  shared by both servers; `:max`, default 100,000, `SWITCH_MAX_BACKLOG`, 0 = off) also refuses, for a sender that has
  stopped taking messages at all. Receipts, EDRs and charges do not count: they may wait on the bus while ClickHouse or
  Redis is down without holding traffic back (S-7.3).

  If the backlog cannot be read, or no message was taken in a second, the last state of that measure is kept.
  """
  use GenServer
  require Logger
  alias Sms.Core.Bus

  @key {__MODULE__, :over}
  @waits {__MODULE__, :waits}
  @consumer "pipeline-sender"
  @resume 0.8
  @none 0xFFFFFFFFFFFF

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Whether new messages are refused because the sender is too far behind."
  @spec over?() :: boolean()
  def over?, do: :persistent_term.get(@key, false)

  @doc "Records the wait of a message the sender is taking (it was accepted at `accepted_at`)."
  @spec observe(DateTime.t()) :: :ok
  def observe(%DateTime{} = accepted_at) do
    case :persistent_term.get(@waits, nil) do
      nil ->
        :ok

      ref ->
        lower(
          ref,
          max(System.os_time(:millisecond) - DateTime.to_unix(accepted_at, :millisecond), 0)
        )
    end
  end

  @doc "Reads the wait and the backlog now (tests, and every interval)."
  @spec check() :: :ok
  def check, do: GenServer.call(__MODULE__, :check)

  @impl true
  def init(opts) do
    config = Keyword.merge(Application.get_env(:sms_switch, __MODULE__, []), opts)
    :persistent_term.put(@key, false)
    ref = :atomics.new(1, signed: false)
    :atomics.put(ref, 1, @none)
    :persistent_term.put(@waits, ref)

    state = %{
      max: Keyword.get(config, :max, 100_000),
      max_wait: Keyword.get(config, :max_wait_ms, 10_000),
      interval: Keyword.get(config, :interval_ms, 1_000),
      reader: Keyword.get(config, :reader, fn -> Bus.backlog(@consumer) end),
      ref: ref,
      slow: false,
      full: false
    }

    _ =
      if state.max > 0 or state.max_wait > 0,
        do: Process.send_after(self(), :tick, state.interval)

    {:ok, state}
  end

  @impl true
  def handle_call(:check, _from, state), do: {:reply, :ok, read(state)}

  @impl true
  def handle_info(:tick, state) do
    Process.send_after(self(), :tick, state.interval)
    {:noreply, read(state)}
  end

  @impl true
  def terminate(_reason, _state), do: :persistent_term.erase(@waits)

  # The shortest wait seen, kept with a compare-and-swap so the sender's 50 workers never block on each other.
  defp lower(ref, wait) do
    current = :atomics.get(ref, 1)

    cond do
      wait >= current -> :ok
      :atomics.compare_exchange(ref, 1, current, wait) == :ok -> :ok
      true -> lower(ref, wait)
    end
  end

  defp read(state) do
    state = %{state | slow: slow?(state), full: full?(state)}
    decide(state.slow or state.full, over?(), state)
    state
  end

  defp slow?(%{max_wait: max}) when max <= 0, do: false

  defp slow?(state) do
    case :atomics.exchange(state.ref, 1, @none) do
      @none -> state.slow
      wait when state.slow -> wait >= state.max_wait * @resume
      wait -> wait > state.max_wait
    end
  end

  defp full?(%{max: max}) when max <= 0, do: false

  defp full?(state) do
    case state.reader.() do
      {:ok, n} when state.full ->
        n >= state.max * @resume

      {:ok, n} ->
        n > state.max

      {:error, reason} ->
        Logger.debug("sender backlog not read: #{inspect(reason)}")
        state.full
    end
  end

  defp decide(true, false, state) do
    :persistent_term.put(@key, true)

    Logger.error(
      "sender behind (#{if state.slow, do: "messages wait over #{state.max_wait} ms", else: "over #{state.max} waiting"}): " <>
        "new messages refused with 0x58"
    )
  end

  defp decide(false, true, _state) do
    :persistent_term.put(@key, false)
    Logger.warning("sender caught up: taking new messages again")
  end

  defp decide(_now, _before, _state), do: :ok
end
