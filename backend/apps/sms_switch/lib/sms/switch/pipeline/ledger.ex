defmodule Sms.Switch.Pipeline.Ledger do
  @moduledoc """
  Live balances and the credit check (spec §7, decision Q24, product owner 2026-10-24), the
  `Sms.Switch.Pipeline.Credit` implementation.

  A partner's balance is its opening balance, plus payments, minus invoiced charges (the **base**, from PostgreSQL's
  `balance_ledger` view, migration 072, re-read every few seconds so a payment counts within seconds), minus the
  traffic charged since its last invoice. Each billing side of an enterprise is one account (`c<id>`, `v<id>`):

    * **check** (before the resp): a customer message is accepted while balance + credit limit covers it at its rate
      × parts, converted to the account's currency; prepaid accounts have no credit limit, so they stop at 0. Refused
      with 0x45 (product owner). An enterprise with no billing set up is not checked;
    * **charge** (`charge/5`): a message is charged when it becomes billable under its Billing Type
      (`Sms.Switch.Pipeline.Billing`), never before: nothing is reserved for messages still waiting for a receipt.
      Charges go through the bus (`sms.billing.charge`) and are applied once each (`apply_charge/1`) to 15-minute
      buckets in Redis (`chg:`, messages in `chm:`) and to the running uninvoiced total (`cht:`) the check reads;
      `Sms.Switch.Pipeline.Ledger.Sync` writes the buckets to PostgreSQL (`traffic_charges`) and, when an invoice moves
      the cut-off, recounts the total from the buckets after it.

  If Redis cannot be read, the last total read in the past minute is used (Q24's grace); after that the message is
  refused. Amounts are kept as integer micro-units (6 decimals, Q20).
  """
  @behaviour Sms.Switch.Pipeline.Credit
  require Logger
  alias Sms.Core.Bus
  alias Sms.Switch.Pipeline.{Config, Revenue, Store}

  @accounts :sms_ledger_accounts
  @seen :sms_ledger_seen
  @grace_ms 60_000
  @bucket_s 900
  @charge_keep_s 7 * 86_400

  @typedoc "One billing side of an enterprise, as `Sync` loads it."
  @type account :: %{
          required(:key) => String.t(),
          required(:enterprise_id) => integer(),
          required(:side) => :customer | :vendor,
          required(:currency) => String.t(),
          required(:base) => integer(),
          required(:limit) => integer(),
          required(:cutoff) => integer(),
          required(:prepaid) => boolean(),
          optional(:credit_limit) => integer(),
          optional(:alerts) => [number()],
          optional(:periods) => %{optional(String.t()) => integer()}
        }

  @doc false
  def accounts_table, do: @accounts

  @doc false
  def seen_table, do: @seen

  @doc "The account key of an enterprise's side."
  @spec key(:customer | :vendor, integer()) :: String.t()
  def key(:customer, enterprise_id), do: "c#{enterprise_id}"
  def key(:vendor, enterprise_id), do: "v#{enterprise_id}"

  @doc "The 15-minute bucket of a time (Unix seconds)."
  @spec bucket(integer()) :: integer()
  def bucket(unix_s), do: div(unix_s, @bucket_s)

  @doc "The bucket length in seconds."
  @spec bucket_s() :: 900
  def bucket_s, do: @bucket_s

  @doc "An account, if the enterprise has billing set up for that side."
  @spec account(String.t()) :: account() | nil
  def account(key) do
    if :ets.whereis(@accounts) != :undefined do
      case :ets.lookup(@accounts, key) do
        [{_, account}] -> account
        [] -> nil
      end
    end
  end

  # ---------------------------------------------------------------- the check

  @impl Sms.Switch.Pipeline.Credit
  def check(%{sell: sell} = msg) when is_map(sell) do
    case account(key(:customer, msg.trunk.enterprise_id)) do
      nil -> :ok
      account -> check(account, micro(sell, msg.parts, account.currency))
    end
  end

  def check(_msg), do: :ok

  defp check(account, cost) do
    case used(account.key) do
      {:ok, used} ->
        if cost <= account.base + account.limit - used,
          do: :ok,
          else: refuse(account, used, cost)

      :error ->
        Logger.error(
          "credit of #{account.key} not checked (Redis unavailable, no recent total): refused"
        )

        {:error, :esme_rsubmitfail}
    end
  end

  defp refuse(account, used, cost) do
    Logger.info(
      "credit of #{account.key} used up: balance #{units(account.base - used)}, limit #{units(account.limit)}, " <>
        "message #{units(cost)} #{account.currency}: refused 0x45"
    )

    {:error, :esme_rsubmitfail}
  end

  @doc "The traffic charged on an account since its last invoice (micro-units), with the grace of Q24."
  @spec used(String.t()) :: {:ok, integer()} | :error
  def used(key) do
    now = System.monotonic_time(:millisecond)

    case Store.command(["GET", "cht:#{key}"]) do
      {:ok, value} ->
        used = to_int(value)
        if :ets.whereis(@seen) != :undefined, do: :ets.insert(@seen, {key, used, now})
        {:ok, used}

      {:error, reason} ->
        case :ets.whereis(@seen) != :undefined && :ets.lookup(@seen, key) do
          [{_, used, at}] when now - at <= @grace_ms ->
            Logger.warning(
              "ledger read failed (#{inspect(reason)}); last total of #{key} used (Q24 grace)"
            )

            {:ok, used}

          _ ->
            :error
        end
    end
  end

  @doc """
  The traffic charged on several accounts since their last invoice, read in one round trip; the last totals read in
  the past minute when Redis cannot be read (Q24), `:error` when an account has none.
  """
  @spec used_many([String.t()]) :: {:ok, %{String.t() => integer()}} | :error
  def used_many([]), do: {:ok, %{}}

  def used_many(keys) do
    now = System.monotonic_time(:millisecond)

    case Store.command(["MGET" | Enum.map(keys, &"cht:#{&1}")]) do
      {:ok, values} ->
        totals = keys |> Enum.zip(Enum.map(values, &to_int/1)) |> Map.new()

        remember(totals, now)
        {:ok, totals}

      {:error, reason} ->
        Logger.warning("ledger read failed (#{inspect(reason)}); last totals used (Q24 grace)")

        Enum.reduce_while(keys, {:ok, %{}}, &add_last_seen(&1, &2, now))
    end
  end

  defp remember(totals, now) do
    if :ets.whereis(@seen) != :undefined,
      do: :ets.insert(@seen, for({k, u} <- totals, do: {k, u, now}))
  end

  defp add_last_seen(key, {:ok, acc}, now) do
    case last_seen(key, now) do
      {:ok, used} -> {:cont, {:ok, Map.put(acc, key, used)}}
      :error -> {:halt, :error}
    end
  end

  # The total read for an account within the grace period (Q24).
  defp last_seen(key, now) do
    case :ets.whereis(@seen) != :undefined && :ets.lookup(@seen, key) do
      [{_, used, at}] when now - at <= @grace_ms -> {:ok, used}
      _ -> :error
    end
  end

  @doc "The live balance of an account (micro-units), or nil without billing."
  @spec balance(String.t()) :: integer() | nil
  def balance(key) do
    with %{} = account <- account(key),
         {:ok, used} <- used(key) do
      account.base - used
    else
      _ -> nil
    end
  end

  # ---------------------------------------------------------------- charges

  @doc """
  Charges an account for a billable message: `id` makes the charge unique (the message id for the customer, the
  attempt's EDR id for a vendor), `rate` × `parts` its amount in the rate's currency. Accounts without billing are not
  charged. `revenue` (`{scope keys, platform currency micro-units}`) counts the customer's revenue for accumulated
  revenue conditions in the same step (`Sms.Switch.Pipeline.Revenue`, §13.9).
  """
  @spec charge(
          :customer | :vendor,
          integer() | nil,
          String.t(),
          map() | nil,
          non_neg_integer(),
          {[String.t()], integer()} | nil
        ) :: :ok | {:error, term()}
  def charge(side, enterprise_id, id, rate, parts, revenue \\ nil)
  def charge(_side, nil, _id, _rate, _parts, _revenue), do: :ok
  def charge(_side, _enterprise_id, _id, nil, _parts, _revenue), do: :ok

  def charge(side, enterprise_id, id, rate, parts, revenue) do
    key = key(side, enterprise_id)
    account = account(key)

    if account == nil and revenue == nil,
      do: :ok,
      else: publish_charge(side, key, account, id, rate, parts, revenue || {[], 0})
  end

  defp publish_charge(side, key, account, id, rate, parts, {rev_keys, rev_micro}) do
    data = %{
      "k" => account && key,
      "id" => "#{id}:#{side}",
      "b" => bucket(System.os_time(:second)),
      "m" => if(account, do: micro(rate, parts, account.currency), else: 0),
      "n" => parts,
      "rv" => rev_keys,
      "rm" => rev_micro
    }

    case Bus.publish("sms.billing.charge", "billing.charge", data, id: "charge:#{data["id"]}") do
      {:ok, _} ->
        :ok

      {:error, reason} = error ->
        Logger.error("charge #{data["id"]} on #{key} not queued: #{inspect(reason)}")
        error
    end
  end

  @doc "Applies a queued charge once (`Sms.Switch.Pipeline.Ledger.Charges`)."
  @spec apply_charge(map()) :: :ok | {:error, term()}
  def apply_charge(%{"id" => id} = charge) do
    case Store.command(["SET", "cd:#{id}", "1", "NX", "EX", @charge_keep_s]) do
      {:ok, "OK"} -> add(charge)
      # Applied already (a redelivery).
      {:ok, nil} -> :ok
      {:error, _} = error -> error
    end
  end

  defp add(%{"id" => id, "b" => bucket} = charge) do
    key = charge["k"]

    ledger =
      if key,
        do: [
          ["HINCRBY", "chg:#{key}", Integer.to_string(bucket), charge["m"]],
          ["HINCRBY", "chm:#{key}", Integer.to_string(bucket), charge["n"]],
          ["INCRBY", "cht:#{key}", charge["m"]],
          ["SADD", "chd", key]
        ],
        else: []

    case Store.transaction(
           ledger ++ Revenue.commands(charge["rv"] || [], bucket, charge["rm"] || 0)
         ) do
      {:ok, _} ->
        :ok

      {:error, _} = error ->
        _ = Store.command(["DEL", "cd:#{id}"])
        error
    end
  end

  # ---------------------------------------------------------------- amounts

  @doc "A rate × parts in micro-units of `currency` (converted through the EUR rates, S-6.7)."
  @spec micro(map(), non_neg_integer(), String.t()) :: integer()
  def micro(rate, parts, currency) do
    amount = Decimal.mult(rate.rate, parts)

    converted =
      with true <- rate.currency != currency and Config.ready?(),
           from when is_number(from) and from > 0 <- Config.per_eur(rate.currency),
           to when is_number(to) <- Config.per_eur(currency) do
        Decimal.mult(amount, Decimal.from_float(to / from))
      else
        _ -> amount
      end

    converted |> Decimal.mult(1_000_000) |> Decimal.round(0) |> Decimal.to_integer()
  end

  @doc "Micro-units from a decimal amount."
  @spec to_micro(Decimal.t() | number() | nil) :: integer()
  def to_micro(nil), do: 0

  def to_micro(%Decimal{} = d),
    do: d |> Decimal.mult(1_000_000) |> Decimal.round(0) |> Decimal.to_integer()

  def to_micro(n) when is_integer(n), do: n * 1_000_000
  def to_micro(n) when is_float(n), do: round(n * 1_000_000)

  @doc "Micro-units as a decimal amount."
  @spec units(integer()) :: Decimal.t()
  def units(micro), do: Decimal.div(Decimal.new(micro), 1_000_000) |> Decimal.normalize()

  defp to_int(nil), do: 0
  defp to_int(n) when is_integer(n), do: n
  defp to_int(s) when is_binary(s), do: String.to_integer(s)
end
