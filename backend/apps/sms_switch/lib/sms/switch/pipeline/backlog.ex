defmodule Sms.Switch.Pipeline.Backlog do
  @moduledoc """
  Overload protection (backend step 7). The intake answers a submit as soon as the message is stored on the bus; the
  sender takes it from there. The load test showed that past the machine's capacity the intake keeps accepting while
  the sender falls behind, so messages pile up on the bus and leave minutes late, though the customer was told they
  were accepted.

  Every `:interval_ms` (1 s) this reads how many accepted messages the sender has not finished (`Sms.Core.Bus.backlog/1`
  of `pipeline-sender`, shared by both servers). Above `:max` (default 20,000, about 20 s of traffic at 1,000 msg/s;
  `SWITCH_MAX_BACKLOG`, 0 = off) the intake refuses new messages with 0x58 (throttled: the customer's platform slows
  down and retries) until the backlog is back under 80 % of it. Receipts, EDRs and charges do not count: they may wait
  on the bus while ClickHouse or Redis is down without holding traffic back (S-7.3).

  If the backlog cannot be read, the last state is kept.
  """
  use GenServer
  require Logger
  alias Sms.Core.Bus

  @key {__MODULE__, :over}
  @consumer "pipeline-sender"
  @resume 0.8

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Whether new messages are refused because the sender is too far behind."
  @spec over?() :: boolean()
  def over?, do: :persistent_term.get(@key, false)

  @doc "Reads the backlog now (tests, and every interval)."
  @spec check() :: :ok
  def check, do: GenServer.call(__MODULE__, :check)

  @impl true
  def init(opts) do
    config = Keyword.merge(Application.get_env(:sms_switch, __MODULE__, []), opts)
    :persistent_term.put(@key, false)

    state = %{
      max: Keyword.get(config, :max, 20_000),
      interval: Keyword.get(config, :interval_ms, 1_000),
      reader: Keyword.get(config, :reader, fn -> Bus.backlog(@consumer) end)
    }

    if state.max > 0, do: Process.send_after(self(), :tick, state.interval)
    {:ok, state}
  end

  @impl true
  def handle_call(:check, _from, state), do: {:reply, read(state), state}

  @impl true
  def handle_info(:tick, state) do
    Process.send_after(self(), :tick, state.interval)
    _ = read(state)
    {:noreply, state}
  end

  defp read(%{max: max}) when max <= 0, do: :ok

  defp read(state) do
    case state.reader.() do
      {:ok, n} -> decide(n, state.max, over?())
      {:error, reason} -> Logger.debug("sender backlog not read: #{inspect(reason)}")
    end

    :ok
  end

  defp decide(n, max, false) when n > max do
    :persistent_term.put(@key, true)

    Logger.error(
      "sender backlog #{n} > #{max}: new messages refused with 0x58 until it is under #{round(max * @resume)}"
    )
  end

  defp decide(n, max, true) when n < max * @resume do
    :persistent_term.put(@key, false)
    Logger.warning("sender backlog #{n}: taking new messages again")
  end

  defp decide(_n, _max, _over), do: :ok
end
