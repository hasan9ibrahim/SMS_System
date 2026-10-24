defmodule Sms.Switch.Pipeline.Ledger.Sync do
  @moduledoc """
  Keeps the ledger (`Sms.Switch.Pipeline.Ledger`) in step with PostgreSQL, every `:interval_ms` (5 s) on each server:

    1. reads every account from `balance_ledger` (migration 072): currency, prepaid or postpaid, credit limit, the base
       (opening balance + payments − invoices) and the cut-off (end of the last invoiced period);
    2. checks the credit alerts (`Sms.Switch.Pipeline.Ledger.Alerts`);
    3. when the cut-off moved (a new invoice), recounts the uninvoiced total from the buckets after it; when Redis has no
       buckets for an account yet (first start, or Redis was lost), loads them from PostgreSQL first;
    4. writes the buckets changed since the last run to `traffic_charges` (absolute amounts, so both servers writing
       the same bucket agree), and drops buckets older than two days before the cut-off from Redis.

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
    for t <- [Ledger.accounts_table(), Ledger.seen_table()],
        :ets.whereis(t) == :undefined,
        do: :ets.new(t, [:named_table, :public, :set, read_concurrency: true])

    Revenue.start_cache()
    source = Keyword.get(opts, :source, Ledger.Source.Postgres)
    {:ok, _} = :timer.send_interval(Keyword.get(opts, :interval_ms, @interval_ms), :tick)
    send(self(), :tick)
    {:ok, %{source: source}}
  end

  @impl true
  def handle_call(:sync, _from, state), do: {:reply, run(state.source), state}

  @impl true
  def handle_info(:tick, state) do
    _ = run(state.source)
    {:noreply, state}
  end

  defp run(source) do
    with {:ok, accounts} <- source.accounts(),
         :ok <- Enum.reduce_while(accounts, :ok, &load(source, &1, &2)) do
      Alerts.check(accounts)
      flush(source)
    else
      {:error, reason} = error ->
        Logger.warning("ledger not synced: #{inspect(reason)}")
        error
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
      {:ok, "OK"} ->
        with {:ok, buckets} <- source.charges(account, account.cutoff) do
          Enum.each(buckets, fn {bucket, micro, n} ->
            _ =
              Store.command([
                "HSETNX",
                "chg:#{account.key}",
                Integer.to_string(bucket),
                Integer.to_string(micro)
              ])

            _ =
              Store.command([
                "HSETNX",
                "chm:#{account.key}",
                Integer.to_string(bucket),
                Integer.to_string(n)
              ])
          end)

          rebase(account)
        end

      {:ok, nil} ->
        :ok

      {:error, _} = error ->
        error
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
    with {:ok, keys} when keys != [] <- Store.command(["SMEMBERS", "chd"]) do
      Enum.each(keys, &Store.command(["SREM", "chd", &1]))
      rows = Enum.flat_map(keys, &rows/1)

      case source.persist(rows) do
        :ok ->
          Enum.each(keys, &prune/1)

        {:error, reason} = error ->
          Enum.each(keys, &Store.command(["SADD", "chd", &1]))
          Logger.warning("traffic charges not written, tried again: #{inspect(reason)}")
          error
      end
    else
      {:ok, []} -> :ok
      {:error, _} = error -> error
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
    with %{} = account <- Ledger.account(key),
         {:ok, amounts} <- hash("chg:#{key}") do
      for {bucket, _} <- amounts, bucket < account.cutoff - @keep_buckets do
        _ = Store.command(["HDEL", "chg:#{key}", Integer.to_string(bucket)])
        Store.command(["HDEL", "chm:#{key}", Integer.to_string(bucket)])
      end
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
