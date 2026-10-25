defmodule SmppSim.Hist do
  @moduledoc """
  A latency histogram in microseconds that any process can record into without a bottleneck (`:counters`).

  Buckets are log-linear: exact below 64 µs, then 32 buckets per power of two (about 3 % precision), up to about
  19 hours. `snapshot/1` copies the counts, so a test step can be measured as the difference of two snapshots.
  """
  import Bitwise

  @sub 32
  @exact 64
  @max_exp 30
  @size @exact + (@max_exp + 1) * @sub

  @type t :: %{counts: :counters.counters_ref(), max: :atomics.atomics_ref()}
  @type snapshot :: %{counts: tuple(), max: non_neg_integer()}

  @doc "A new, empty histogram."
  @spec new() :: t()
  def new, do: %{counts: :counters.new(@size, [:write_concurrency]), max: :atomics.new(1, signed: false)}

  @doc "Records one value (µs; negative values count as 0)."
  @spec record(t(), integer()) :: :ok
  def record(%{counts: counts, max: max}, us) do
    us = max(us, 0)
    :ok = :counters.add(counts, bucket(us) + 1, 1)
    bump_max(max, us)
  end

  defp bump_max(ref, us) do
    current = :atomics.get(ref, 1)

    cond do
      us <= current -> :ok
      :atomics.compare_exchange(ref, 1, current, us) == :ok -> :ok
      true -> bump_max(ref, us)
    end
  end

  @doc false
  @spec bucket(non_neg_integer()) :: non_neg_integer()
  def bucket(us) when us < @exact, do: us

  def bucket(us) do
    e = bit_length(us) - 6
    index = @exact + e * @sub + ((us >>> e) - @sub)
    min(index, @size - 1)
  end

  # The lower bound of a bucket.
  @doc false
  @spec lower(non_neg_integer()) :: non_neg_integer()
  def lower(index) when index < @exact, do: index

  def lower(index) do
    e = div(index - @exact, @sub)
    (rem(index - @exact, @sub) + @sub) <<< e
  end

  defp upper(index) when index < @exact, do: index + 1

  defp upper(index) do
    e = div(index - @exact, @sub)
    (rem(index - @exact, @sub) + @sub + 1) <<< e
  end

  defp bit_length(0), do: 0
  defp bit_length(v), do: 1 + bit_length(v >>> 1)

  @doc "A copy of the counts."
  @spec snapshot(t()) :: snapshot()
  def snapshot(%{counts: counts, max: max}) do
    %{counts: List.to_tuple(for(i <- 1..@size, do: :counters.get(counts, i))), max: :atomics.get(max, 1)}
  end

  @doc "The counts recorded between two snapshots (`later` minus `earlier`); the max is the later one's."
  @spec diff(snapshot(), snapshot() | nil) :: snapshot()
  def diff(later, nil), do: later

  def diff(later, earlier) do
    counts = for i <- 0..(@size - 1), do: elem(later.counts, i) - elem(earlier.counts, i)
    %{counts: List.to_tuple(counts), max: later.max}
  end

  @doc """
  Count, mean, the given percentiles (µs, each the middle of its bucket) and the max of a snapshot. The max is the
  largest value since the histogram was created, so for a difference of snapshots it is an upper bound.
  """
  @spec summary(snapshot(), [number()]) :: %{
          count: non_neg_integer(),
          mean: float(),
          max: non_neg_integer(),
          percentiles: %{number() => non_neg_integer()}
        }
  def summary(%{counts: counts, max: max}, percentiles \\ [50, 90, 95, 99, 99.9]) do
    list = Tuple.to_list(counts)
    total = Enum.sum(list)

    sum =
      list
      |> Enum.with_index()
      |> Enum.reduce(0, fn {n, i}, acc -> acc + n * div(lower(i) + upper(i), 2) end)

    %{
      count: total,
      mean: if(total == 0, do: 0.0, else: sum / total),
      max: if(total == 0, do: 0, else: max),
      percentiles: Map.new(percentiles, &{&1, percentile(list, total, &1)})
    }
  end

  defp percentile(_list, 0, _p), do: 0

  defp percentile(list, total, p) do
    target = max(1, ceil(total * p / 100))

    list
    |> Enum.with_index()
    |> Enum.reduce_while(0, fn {n, i}, acc ->
      if acc + n >= target, do: {:halt, {:at, i}}, else: {:cont, acc + n}
    end)
    |> case do
      {:at, i} -> div(lower(i) + upper(i), 2)
      _ -> 0
    end
  end
end
