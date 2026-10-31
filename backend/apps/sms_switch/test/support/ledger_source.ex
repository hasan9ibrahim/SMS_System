defmodule Sms.Switch.Test.LedgerSource do
  @moduledoc "A ledger source for tests (`Sms.Switch.Pipeline.Ledger.Source`): accounts and stored buckets set by the test."
  @behaviour Sms.Switch.Pipeline.Ledger.Source
  alias Sms.Switch.Pipeline.Ledger

  @key {__MODULE__, :state}

  @doc "Sets the accounts (keyword fields per account, see `account/1`) and the buckets PostgreSQL holds."
  def put(accounts, charges \\ %{}, opts \\ []) do
    :persistent_term.put(@key, %{
      accounts: Enum.map(accounts, &account/1),
      charges: charges,
      persisted: [],
      reservations: %{},
      fail: Keyword.get(opts, :fail, false)
    })
  end

  @doc "The rows written so far."
  def persisted, do: state().persisted

  @doc "The credit held per account as last written (`persist_reservations/1`)."
  def reservations, do: state().reservations

  @doc "An account: enterprise 1's customer side, postpaid, EUR, base 0, no limit, no invoice unless given."
  def account(fields) do
    f = Map.new(fields)
    side = Map.get(f, :side, :customer)
    ent = Map.get(f, :enterprise_id, 11)
    prepaid = Map.get(f, :prepaid, false)

    %{
      key: Ledger.key(side, ent),
      enterprise_id: ent,
      side: side,
      currency: Map.get(f, :currency, "EUR"),
      base: money(Map.get(f, :base, 0)),
      limit: if(prepaid, do: 0, else: money(Map.get(f, :limit, 0))),
      credit_limit: money(Map.get(f, :limit, 0)),
      cutoff: Map.get(f, :cutoff, 0),
      prepaid: prepaid,
      alerts: Map.get(f, :alerts, [])
    }
  end

  defp money(s) when is_binary(s), do: s |> Decimal.new() |> Ledger.to_micro()
  defp money(n), do: Ledger.to_micro(n)

  defp state, do: :persistent_term.get(@key)

  @impl true
  def accounts, do: if(state().fail, do: {:error, :down}, else: {:ok, state().accounts})

  @impl true
  def charges(account, cutoff) do
    {:ok, for({b, m, n} <- Map.get(state().charges, account.key, []), b >= cutoff, do: {b, m, n})}
  end

  @impl true
  def persist(rows) do
    s = state()

    if s.fail do
      {:error, :down}
    else
      :persistent_term.put(@key, %{s | persisted: s.persisted ++ rows})
      :ok
    end
  end

  @impl true
  def persist_reservations(rows) do
    s = state()

    if s.fail do
      {:error, :down}
    else
      held = Map.merge(s.reservations, Map.new(rows, fn {a, micro} -> {a.key, micro} end))
      :persistent_term.put(@key, %{s | reservations: held})
      :ok
    end
  end
end
