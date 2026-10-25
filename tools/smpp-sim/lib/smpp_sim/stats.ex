defmodule SmppSim.Stats do
  @moduledoc """
  What the simulator measures, shared by every session without a bottleneck:

    * counters (`incr/2`), listed in `@counters`;
    * SMPP statuses of the customers' `submit_sm_resp` (`status/1`, ETS);
    * latency histograms (`SmppSim.Hist`): `:resp` (submit_sm → submit_sm_resp, what the customer waits for),
      `:e2e` (submit_sm → the delivery receipt back at the customer, through the vendor and its receipt delay);
    * the messages accepted, by the switch's message id (`:sim_msgs`), so each receipt is matched to exactly one
      accepted message: none missing, none twice, none unknown.

  `snapshot/0` copies all of it, so a test step is measured as the difference of two snapshots.
  """
  alias SmppSim.Hist

  @counters ~w(
    submitted parts_submitted resp_ok resp_throttled resp_rejected resp_timeout lost_inflight behind
    receipts receipts_unknown receipts_dup dlr_delivrd dlr_undeliv dlr_expired dlr_rejectd dlr_other
    binds bind_fail disconnects
    smsc_binds smsc_submits smsc_resp_error smsc_silent smsc_receipts smsc_receipts_dropped smsc_receipts_retried
    smsc_receipts_refused smsc_duplicates
    smsc_disconnects
  )a
  @index @counters |> Enum.with_index(1) |> Map.new()
  @hists [:resp, :e2e]

  @doc false
  def counters, do: @counters

  @doc "Creates the shared counters and tables (once, at application start)."
  @spec setup() :: :ok
  def setup do
    :persistent_term.put({__MODULE__, :counters}, :counters.new(length(@counters), [:write_concurrency]))
    for h <- @hists, do: :persistent_term.put({__MODULE__, h}, Hist.new())
    table(:sim_status, :set)
    table(:sim_msgs, :set)
    table(:sim_smsc_seen, :set)
    :ok
  end

  defp table(name, type) do
    if :ets.whereis(name) == :undefined do
      ^name = :ets.new(name, [type, :named_table, :public, write_concurrency: true, read_concurrency: true])
    end

    :ok
  end

  @doc "Clears everything (between test runs)."
  @spec reset() :: :ok
  def reset do
    true = :ets.delete_all_objects(:sim_status)
    true = :ets.delete_all_objects(:sim_msgs)
    true = :ets.delete_all_objects(:sim_smsc_seen)
    setup()
  end

  @spec incr(atom(), integer()) :: :ok
  def incr(name, n \\ 1), do: :counters.add(:persistent_term.get({__MODULE__, :counters}), Map.fetch!(@index, name), n)

  @spec get(atom()) :: integer()
  def get(name), do: :counters.get(:persistent_term.get({__MODULE__, :counters}), Map.fetch!(@index, name))

  @doc "Counts one submit_sm_resp status."
  @spec status(non_neg_integer()) :: :ok
  def status(code) do
    _ = :ets.update_counter(:sim_status, code, 1, {code, 0})
    :ok
  end

  @doc "Records a latency (µs) in one of the histograms."
  @spec record(:resp | :e2e, integer()) :: :ok
  def record(hist, us), do: Hist.record(:persistent_term.get({__MODULE__, hist}), us)

  # ---------------------------------------------------------------- accepted messages and receipts

  @doc "An accepted message: the switch's id and when its submit_sm went out (monotonic µs)."
  @spec accepted(binary(), integer()) :: :ok
  def accepted(id, sent_us) do
    true = :ets.insert(:sim_msgs, {id, sent_us, 0})
    :ok
  end

  @doc "A receipt for `id`: `:ok` with the submit time the first time, `:dup` again, `:unknown` for an id never accepted."
  @spec receipt(binary()) :: {:ok, integer()} | :dup | :unknown
  def receipt(id) do
    case :ets.update_counter(:sim_msgs, id, {3, 1}, {id, nil, 0}) do
      1 ->
        case :ets.lookup(:sim_msgs, id) do
          [{_, nil, _}] ->
            :ets.delete(:sim_msgs, id)
            :unknown

          [{_, sent, _}] ->
            {:ok, sent}
        end

      _ ->
        :dup
    end
  end

  @doc "Accepted messages with no receipt yet (an O(n) scan, for the end of a run)."
  @spec awaiting_receipts() :: non_neg_integer()
  def awaiting_receipts, do: :ets.select_count(:sim_msgs, [{{:_, :"$1", 0}, [{:"/=", :"$1", nil}], [true]}])

  @doc "Forgets messages whose receipt came more than `age_us` after they were sent, to bound memory in a soak."
  @spec forget_done(integer()) :: non_neg_integer()
  def forget_done(before_us),
    do: :ets.select_delete(:sim_msgs, [{{:_, :"$1", :"$2"}, [{:>, :"$2", 0}, {:<, :"$1", before_us}], [true]}])

  # ---------------------------------------------------------------- snapshots

  @type snapshot :: %{
          at: integer(),
          counters: %{atom() => integer()},
          statuses: %{non_neg_integer() => integer()},
          hists: %{atom() => Hist.snapshot()}
        }

  @spec snapshot() :: snapshot()
  def snapshot do
    %{
      at: System.monotonic_time(:microsecond),
      counters: Map.new(@counters, &{&1, get(&1)}),
      statuses: Map.new(:ets.tab2list(:sim_status)),
      hists: Map.new(@hists, &{&1, Hist.snapshot(:persistent_term.get({__MODULE__, &1}))})
    }
  end

  @doc "What happened between two snapshots: counters and statuses as differences, histograms as summaries."
  @spec diff(snapshot(), snapshot() | nil) :: map()
  def diff(later, earlier) do
    earlier = earlier || %{at: later.at, counters: %{}, statuses: %{}, hists: %{}}

    %{
      seconds: (later.at - earlier.at) / 1_000_000,
      counters: Map.new(later.counters, fn {k, v} -> {k, v - Map.get(earlier.counters, k, 0)} end),
      statuses:
        later.statuses
        |> Map.new(fn {k, v} -> {k, v - Map.get(earlier.statuses, k, 0)} end)
        |> Map.reject(fn {_, v} -> v == 0 end),
      latency: Map.new(later.hists, fn {k, h} -> {k, Hist.summary(Hist.diff(h, earlier.hists[k]))} end)
    }
  end
end
