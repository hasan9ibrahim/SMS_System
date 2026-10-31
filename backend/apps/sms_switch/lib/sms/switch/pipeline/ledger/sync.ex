defmodule Sms.Switch.Pipeline.Ledger.Sync do
  @moduledoc """
  Keeps the ledger (`Sms.Switch.Pipeline.Ledger`) in step with PostgreSQL, every `:interval_ms` (5 s) on each server:

    1. reads every account from `balance_ledger` (migration 072): currency, prepaid or postpaid, credit limit, the base
       (opening balance + payments − invoices) and the cut-off (end of the last invoiced period);
    2. checks the credit alerts (`Sms.Switch.Pipeline.Ledger.Alerts`);
    3. when the cut-off moved (a new invoice), recounts the uninvoiced total from the buckets after it; when Redis has no
       buckets for an account yet (first start, or Redis was lost), loads them from PostgreSQL first;
    4. writes the buckets changed since the last run to `traffic_charges` (absolute amounts, so both servers writing
       the same bucket agree), and drops buckets older than two days before the cut-off from Redis;
    5. writes what each customer account holds for messages in flight (§7, decision 2026-10-31) to
       `credit_reservations` (migration 103) when it changed since the last run, for the balance screens.

  A failed run is logged and tried on the next tick; the check keeps using the accounts already loaded.
  """
  use GenServer
  require Logger
  alias Sms.Switch.Pipeline.{Ledger, Revenue, Store}
  alias Sms.Switch.Pipeline.Ledger.Alerts

  @interval_ms 5_000
  # Buckets kept in Redis before the cut-off (two days), for receipts charged just after an invoice.
  @keep_buckets 192

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Runs one sync now (tests, and the first run at start)."
  @spec sync() :: :ok | {:error, term()}
  def sync, do: GenServer.call(__MODULE__, :sync, 30_000)

  @impl true
  def init(opts) do
    Enum.each([Ledger.accounts_table(), Ledger.seen_table()], &new_table/1)

    Revenue.start_cache()
    source = Keyword.get(opts, :source, Ledger.Source.Postgres)
    {:ok, _} = :timer.send_interval(Keyword.get(opts, :interval_ms, @interval_ms), :tick)
    send(self(), :tick)
    {:ok, %{source: source, held: nil}}
  end

  defp new_table(name) do
    if :ets.whereis(name) == :undefined do
      ^name = :ets.new(name, [:named_table, :public, :set, read_concurrency: true])
    end

    :ok
  end

  @impl true
  def handle_call(:sync, _from, state) do
    {reply, state} = run(state)
    {:reply, reply, state}
  end

  @impl true
  def handle_info(:tick, state) do
    {_, state} = run(state)
    {:noreply, state}
  end

  defp run(%{source: source} = state) do
    with {:ok, accounts} <- source.accounts(),
         :ok <- Enum.reduce_while(accounts, :ok, &load(source, &1, &2)) do
      Alerts.check(accounts)
      result = flush(source)
      {result, %{state | held: reservations(source, accounts, state.held)}}
    else
      {:error, reason} = error ->
        Logger.warning("ledger not synced: #{inspect(reason)}")
        {error, state}
    end
  end

  # The customer accounts' holds (one read), written when they changed since the last run; all of them on the first
  # run, so a row left from before a restart is corrected. A failed read or write is tried on the next run.
  defp reservations(source, accounts, last) do
    customers = for %{side: :customer} = a <- accounts, do: a

    with {:ok, held} <- Store.credit_held(Enum.map(customers, & &1.key)),
         changed =
           for(
             a <- customers,
             last == nil or Map.get(last, a.key) != held[a.key],
             do: {a, held[a.key]}
           ),
         :ok <- source.persist_reservations(changed) do
      held
    else
      {:error, reason} ->
        Logger.warning("credit reservations not written, tried again: #{inspect(reason)}")
        last
    end
  end

  defp load(source, account, :ok) do
    previous = Ledger.account(account.key)
    :ets.insert(Ledger.accounts_table(), {account.key, account})

    with :ok <- seed(source, account),
         :ok <- if(previous && previous.cutoff == account.cutoff, do: :ok, else: rebase(account)) do
      {:cont, :ok}
    else
      {:error, _} = error -> {:halt, error}
    end
  end

  # Redis without this account's buckets (first start, or lost): the buckets after the cut-off from PostgreSQL. A
  # bucket a charge already started is left as it is.
  defp seed(source, account) do
    case Store.command(["SET", "lgs:#{account.key}", "1", "NX"]) do
      {:ok, "OK"} -> seed_buckets(source, account)
      {:ok, nil} -> :ok
      {:error, _} = error -> error
    end
  end

  defp seed_buckets(source, account) do
    with {:ok, buckets} <- source.charges(account, account.cutoff) do
      Enum.each(buckets, fn {bucket, micro, n} ->
        b = Integer.to_string(bucket)
        _ = Store.command(["HSETNX", "chg:#{account.key}", b, Integer.to_string(micro)])
        Store.command(["HSETNX", "chm:#{account.key}", b, Integer.to_string(n)])
      end)

      rebase(account)
    end
  end

  defp rebase(account) do
    case Store.rebase("chg:#{account.key}", "cht:#{account.key}", account.cutoff) do
      {:ok, _} -> :ok
      {:error, _} = error -> error
    end
  end

  # The buckets of accounts charged since the last run, written whole; an account whose write failed is marked again.
  defp flush(source) do
    case Store.command(["SMEMBERS", "chd"]) do
      {:ok, []} -> :ok
      {:ok, keys} -> write(source, keys)
      {:error, _} = error -> error
    end
  end

  defp write(source, keys) do
    Enum.each(keys, &Store.command(["SREM", "chd", &1]))

    case source.persist(Enum.flat_map(keys, &rows/1)) do
      :ok ->
        Enum.each(keys, &prune/1)

      {:error, reason} = error ->
        Enum.each(keys, &Store.command(["SADD", "chd", &1]))
        Logger.warning("traffic charges not written, tried again: #{inspect(reason)}")
        error
    end
  end

  defp rows(key) do
    with %{} = account <- Ledger.account(key),
         {:ok, amounts} <- hash("chg:#{key}"),
         {:ok, counts} <- hash("chm:#{key}") do
      for {bucket, micro} <- amounts,
          do: {account, bucket, micro, Map.get(counts, bucket, 0)}
    else
      _ -> []
    end
  end

  defp prune(key) do
    _ =
      with %{} = account <- Ledger.account(key),
           {:ok, amounts} <- hash("chg:#{key}") do
        amounts
        |> Map.keys()
        |> Enum.filter(&(&1 < account.cutoff - @keep_buckets))
        |> Enum.each(fn bucket ->
          _ = Store.command(["HDEL", "chg:#{key}", Integer.to_string(bucket)])
          Store.command(["HDEL", "chm:#{key}", Integer.to_string(bucket)])
        end)
      end

    :ok
  end

  defp hash(key) do
    case Store.command(["HGETALL", key]) do
      {:ok, flat} ->
        {:ok, flat |> Enum.chunk_every(2) |> Map.new(fn [k, v] -> {int(k), int(v)} end)}

      error ->
        error
    end
  end

  defp int(v) when is_integer(v), do: v
  defp int(v), do: String.to_integer(v)
end
