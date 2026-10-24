defmodule Sms.Switch.Pipeline.Ledger.Source do
  @moduledoc """
  Where the ledger's accounts come from and its buckets go (`Sms.Switch.Pipeline.Ledger.Sync`): PostgreSQL in
  production (`Postgres`), a stub in tests.
  """
  alias Sms.Switch.Pipeline.Ledger

  @callback accounts() :: {:ok, [Ledger.account()]} | {:error, term()}
  @callback charges(Ledger.account(), cutoff :: integer()) ::
              {:ok, [{bucket :: integer(), micro :: integer(), messages :: integer()}]}
              | {:error, term()}
  @callback persist([
              {Ledger.account(), bucket :: integer(), micro :: integer(), messages :: integer()}
            ]) ::
              :ok | {:error, term()}

  defmodule Postgres do
    @moduledoc "The ledger on the configuration database: `balance_ledger` and `traffic_charges` (migration 072)."
    @behaviour Sms.Switch.Pipeline.Ledger.Source
    alias Sms.Core.Repo
    alias Sms.Switch.Pipeline.Ledger

    @accounts """
    SELECT enterprise_id, side, currency, billing_type, credit_limit, base,
           CASE WHEN cutoff = '-infinity' THEN NULL ELSE extract(epoch FROM cutoff)::bigint END
      FROM balance_ledger
    """

    @impl true
    def accounts do
      case Repo.query(@accounts, [], log: false, timeout: 15_000) do
        {:ok, %{rows: rows}} -> {:ok, Enum.map(rows, &account/1)}
        {:error, _} = error -> error
      end
    end

    defp account([ent, side, currency, billing_type, limit, base, cutoff]) do
      side = if side == "vendor", do: :vendor, else: :customer
      prepaid = billing_type == "prepaid"

      %{
        key: Ledger.key(side, ent),
        enterprise_id: ent,
        side: side,
        currency: String.trim(currency),
        base: Ledger.to_micro(base),
        # Prepaid has no credit limit: it stops at 0 (product owner).
        limit: if(prepaid or side == :vendor, do: 0, else: Ledger.to_micro(limit)),
        credit_limit: Ledger.to_micro(limit),
        cutoff: if(cutoff, do: Ledger.bucket(cutoff), else: 0),
        prepaid: prepaid
      }
    end

    @impl true
    def charges(account, cutoff) do
      sql = """
      SELECT (extract(epoch FROM bucket)::bigint / #{Ledger.bucket_s()}), amount, messages FROM traffic_charges
       WHERE enterprise_id = $1 AND side = $2 AND bucket >= to_timestamp($3)
      """

      case Repo.query(sql, [account.enterprise_id, side(account), cutoff * Ledger.bucket_s()],
             log: false
           ) do
        {:ok, %{rows: rows}} ->
          {:ok, for([b, amount, n] <- rows, do: {b, Ledger.to_micro(amount), n})}

        {:error, _} = error ->
          error
      end
    end

    @impl true
    def persist([]), do: :ok

    def persist(rows) do
      {ents, sides, buckets, amounts, counts} =
        rows
        |> Enum.map(fn {a, bucket, micro, n} ->
          {a.enterprise_id, side(a), bucket * Ledger.bucket_s(), Ledger.units(micro), n}
        end)
        |> unzip5()

      sql = """
      INSERT INTO traffic_charges (enterprise_id, side, bucket, amount, messages, updated_at)
      SELECT e, s, to_timestamp(b), a, n, now()
        FROM unnest($1::bigint[], $2::text[], $3::bigint[], $4::numeric[], $5::bigint[]) AS t(e, s, b, a, n)
      ON CONFLICT (enterprise_id, side, bucket)
        DO UPDATE SET amount = EXCLUDED.amount, messages = EXCLUDED.messages, updated_at = now()
      """

      case Repo.query(sql, [ents, sides, buckets, amounts, counts], log: false) do
        {:ok, _} -> :ok
        {:error, _} = error -> error
      end
    end

    defp side(%{side: :vendor}), do: "vendor"
    defp side(_account), do: "customer"

    defp unzip5(list) do
      Enum.reduce(Enum.reverse(list), {[], [], [], [], []}, fn {a, b, c, d, e},
                                                               {as, bs, cs, ds, es} ->
        {[a | as], [b | bs], [c | cs], [d | ds], [e | es]}
      end)
    end
  end
end
