defmodule Sms.Switch.Pipeline.Ledger do
  @moduledoc """
  Live balances and the credit check (spec §7, decision Q24, product owner 2026-10-24), the
  `Sms.Switch.Pipeline.Credit` implementation.

  A partner's balance is its opening balance, plus payments, minus invoiced charges (the **base**, from PostgreSQL's
  `balance_ledger` view, migration 072, re-read every few seconds so a payment counts within seconds), minus the
  traffic charged since its last invoice. Each billing side of an enterprise is one account (`c<id>`, `v<id>`):

    * **reserve** (before the resp, `reserve/1`): a customer message is accepted while balance + credit limit, less
      what is held for messages in flight, covers it at its rate × parts, converted to the account's currency; prepaid
      accounts have no credit limit, so they stop at 0. Refused with 0x45 (product owner). The check and the hold of
      the message's full cost (all parts) are one step in Redis (`Store.reserve_credit/5`), so two messages near the
      limit never both pass (S-6.3, decision 2026-10-31). An enterprise with no billing set up is not checked;
      `check/1` is the same check without a hold (a scheduled message at intake, S-2.12);
    * **charge** (`charge/6`): a message is charged when it becomes billable under its Billing Type
      (`Sms.Switch.Pipeline.Billing`), never before. Charges go through the bus (`sms.billing.charge`) and are applied
      once each (`apply_charge/1`) to 15-minute buckets in Redis (`chg:`, messages in `chm:`) and to the running
      uninvoiced total (`cht:`) the check reads; a customer charge releases its message's hold in the same step, so
      the charge replaces the hold. `Sms.Switch.Pipeline.Ledger.Sync` writes the buckets to PostgreSQL
      (`traffic_charges`) and the held totals (`credit_reservations`) and, when an invoice moves the cut-off, recounts
      the total from the buckets after it;
    * **release** (`release/2`): a message whose final outcome is not billable (refused by every vendor, expired,
      cancelled, undelivered under delivery billing, its DLR timeout status not billable) gives its hold back, through
      the same queue and applied once. A hold also expires on its own after its vendor trunk's receipt timeout plus an
      hour (moved on when the message is sent), and the timeout sweeper releases it (`sweep_holds/0`), so a lost
      message never locks credit.

  If Redis cannot be read, the last totals read in the past minute are used (Q24's grace: checked, nothing held);
  after that the message is refused. Amounts are kept as integer micro-units (6 decimals, Q20).
  """
  @behaviour Sms.Switch.Pipeline.Credit
  require Logger
  alias Sms.Core.Bus
  alias Sms.Switch.Pipeline.{Config, Revenue, Sender, Store}

  @accounts :sms_ledger_accounts
  @seen :sms_ledger_seen
  @grace_ms 60_000
  @bucket_s 900
  @charge_keep_s 7 * 86_400
  # A hold outlives its message's receipt timeout by an hour, as the message's record in Redis does; without a vendor
  # trunk to read it from, 48 h + 1 h (`:credit_hold_s`).
  @hold_margin_s 3_600
  @default_hold_s 176_400
  @sweep_batch 500

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

  @doc """
  The credit check without a hold (a scheduled message at intake, S-2.12): whether balance + credit limit, less what is
  charged and held, covers the message now.
  """
  @impl Sms.Switch.Pipeline.Credit
  def check(%{sell: sell} = msg) when is_map(sell) do
    case account(key(:customer, msg.trunk.enterprise_id)) do
      nil -> :ok
      account -> check(account, micro(sell, msg.parts, account.currency))
    end
  end

  def check(_msg), do: :ok

  defp check(account, cost) do
    case exposure(account.key) do
      {:ok, used, held} -> decide(account, cost, used, held)
      :error -> unchecked(account)
    end
  end

  @doc """
  The credit check and the hold of the message's full cost, in one step (S-6.3, decision 2026-10-31): held against the
  customer account until the message's charge replaces it, its outcome releases it, or it expires.
  """
  @impl Sms.Switch.Pipeline.Credit
  def reserve(%{sell: sell, id: id} = msg) when is_map(sell) and is_binary(id) do
    case account(key(:customer, msg.trunk.enterprise_id)) do
      nil -> :ok
      account -> reserve(account, msg, micro(sell, msg.parts, account.currency))
    end
  end

  def reserve(msg), do: check(msg)

  defp reserve(account, msg, cost) do
    until = System.os_time(:millisecond) + hold_s(msg) * 1_000

    case Store.reserve_credit(account.key, msg.id, cost, account.base + account.limit, until) do
      {:ok, :refused, used, held} ->
        remember_exposure(account.key, used, held)
        refuse(account, used, held, cost)

      {:ok, _held, used, held} ->
        remember_exposure(account.key, used, held)
        :ok

      {:error, reason} ->
        # Q24: checked on the last totals read within the minute; nothing can be held meanwhile.
        Logger.warning(
          "credit hold of #{account.key} failed (#{inspect(reason)}): last totals used"
        )

        case last_exposure(account.key, System.monotonic_time(:millisecond)) do
          {:ok, used, held} -> decide(account, cost, used, held)
          :error -> unchecked(account)
        end
    end
  end

  defp decide(account, cost, used, held) do
    if cost <= account.base + account.limit - used - held,
      do: :ok,
      else: refuse(account, used, held, cost)
  end

  defp unchecked(account) do
    Logger.error(
      "credit of #{account.key} not checked (Redis unavailable, no recent total): refused"
    )

    {:error, :esme_rsubmitfail}
  end

  defp refuse(account, used, held, cost) do
    Logger.info(
      "credit of #{account.key} used up: balance #{units(account.base - used)}, held #{units(held)}, " <>
        "limit #{units(account.limit)}, message #{units(cost)} #{account.currency}: refused 0x45"
    )

    {:error, :esme_rsubmitfail}
  end

  @doc false
  # How long a message's hold lasts (seconds): its vendor trunk's receipt timeout (S-5.10) plus an hour.
  @spec hold_s(map()) :: pos_integer()
  def hold_s(msg) do
    with %{vendor_trunk_id: vt} <- Map.get(msg, :route),
         true <- Config.ready?(),
         %{} = trunk <- Config.vendor_trunk(vt) do
      {timeout_s, _status} = Sender.receipt_timeout(trunk, msg)
      timeout_s + @hold_margin_s
    else
      _ -> default_hold_s()
    end
  end

  defp default_hold_s,
    do:
      :sms_switch
      |> Application.get_env(Sms.Switch.Pipeline, [])
      |> Keyword.get(:credit_hold_s, @default_hold_s)

  # What is charged and held on an account, with the grace of Q24.
  defp exposure(key) do
    now = System.monotonic_time(:millisecond)

    case Store.command(["MGET", "cht:#{key}", "chht:#{key}"]) do
      {:ok, [used, held]} ->
        remember_exposure(key, to_int(used), to_int(held))
        {:ok, to_int(used), to_int(held)}

      {:error, reason} ->
        Logger.warning(
          "ledger read failed (#{inspect(reason)}); last totals of #{key} used (Q24 grace)"
        )

        last_exposure(key, now)
    end
  end

  defp remember_exposure(key, used, held) do
    if :ets.whereis(@seen) != :undefined do
      now = System.monotonic_time(:millisecond)
      :ets.insert(@seen, [{key, used, now}, {{:held, key}, held, now}])
    end
  end

  # The totals read within the grace period (Q24); a hold total never read counts as none.
  defp last_exposure(key, now) do
    with {:ok, used} <- last_seen(key, now) do
      held =
        case :ets.whereis(@seen) != :undefined && :ets.lookup(@seen, {:held, key}) do
          [{_, held, at}] when now - at <= @grace_ms -> held
          _ -> 0
        end

      {:ok, used, held}
    end
  end

  # ---------------------------------------------------------------- holds

  @doc """
  Releases the hold of a customer message whose final outcome is not billable: queued like a charge and applied once
  (`apply_charge/1`). Nothing to do for an enterprise without customer billing.
  """
  @spec release(integer() | nil, String.t()) :: :ok | {:error, term()}
  def release(nil, _id), do: :ok

  def release(enterprise_id, id) do
    key = key(:customer, enterprise_id)

    if account(key) == nil do
      :ok
    else
      data = %{"id" => "#{id}:release", "h" => id, "hk" => key}

      case Bus.publish("sms.billing.charge", "billing.release", data, id: "charge:#{data["id"]}") do
        {:ok, _} ->
          :ok

        {:error, reason} = error ->
          Logger.error("hold of #{id} on #{key} not released (it expires): #{inspect(reason)}")
          error
      end
    end
  end

  @doc "Gives a message's hold back at once (it was held, then not stored after all)."
  @impl Sms.Switch.Pipeline.Credit
  def unreserve(%{id: id} = msg) do
    key = key(:customer, msg.trunk.enterprise_id)

    _ =
      with %{} <- account(key),
           {:error, reason} <- Store.release_credit(key, id),
           do:
             Logger.warning(
               "hold of #{id} on #{key} not released (it expires): #{inspect(reason)}"
             )

    :ok
  end

  @doc "Moves a message's hold expiry on when it is sent: its receipt timeout counts from now, plus an hour."
  @spec extend_hold(integer() | nil, String.t(), non_neg_integer()) :: :ok
  def extend_hold(nil, _id, _timeout_s), do: :ok

  def extend_hold(enterprise_id, id, timeout_s) do
    key = key(:customer, enterprise_id)

    _ =
      if account(key) != nil do
        until = System.os_time(:millisecond) + (timeout_s + @hold_margin_s) * 1_000
        Store.extend_credit_hold(key, id, until)
      end

    :ok
  end

  @doc "Releases the holds whose expiry passed (run by `Sms.Switch.Pipeline.Timeouts`); each by one server."
  @spec sweep_holds() :: :ok
  def sweep_holds do
    now = System.os_time(:millisecond)

    case Store.due_credit_holds(now, @sweep_batch) do
      {:ok, holds} ->
        Enum.each(holds, &expire_hold(&1, now))
        if length(holds) == @sweep_batch, do: sweep_holds(), else: :ok

      {:error, reason} ->
        Logger.warning("credit holds not swept: #{inspect(reason)}")
    end
  end

  defp expire_hold({key, id}, now) do
    case Store.release_credit(key, id, now) do
      {:ok, amount} when amount > 0 ->
        Logger.info("credit hold of #{id} on #{key} expired: #{units(amount)} released")

      _ ->
        :ok
    end
  end

  @doc "What is held on an account for messages in flight (micro-units)."
  @spec held(String.t()) :: integer()
  def held(key) do
    case Store.credit_held([key]) do
      {:ok, %{^key => held}} -> held
      _ -> 0
    end
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

    # The customer's charge replaces its message's hold (§7, decision 2026-10-31).
    data = if side == :customer, do: Map.merge(data, %{"h" => id, "hk" => key}), else: data

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

  # The message's hold goes in the same step as its charge: never counted twice, never dropped first.
  defp add(%{"id" => id} = charge) do
    case Store.transaction(
           ledger_commands(charge) ++ revenue_commands(charge) ++ hold_commands(charge)
         ) do
      {:ok, _} ->
        :ok

      {:error, _} = error ->
        _ = Store.command(["DEL", "cd:#{id}"])
        error
    end
  end

  defp ledger_commands(%{"k" => key, "b" => bucket} = charge) when is_binary(key) do
    [
      ["HINCRBY", "chg:#{key}", Integer.to_string(bucket), charge["m"]],
      ["HINCRBY", "chm:#{key}", Integer.to_string(bucket), charge["n"]],
      ["INCRBY", "cht:#{key}", charge["m"]],
      ["SADD", "chd", key]
    ]
  end

  defp ledger_commands(_charge), do: []

  defp revenue_commands(%{"b" => bucket} = charge),
    do: Revenue.commands(charge["rv"] || [], bucket, charge["rm"] || 0)

  defp revenue_commands(_release), do: []

  defp hold_commands(%{"h" => id, "hk" => key}) when is_binary(id) and is_binary(key),
    do: [Store.release_credit_command(key, id)]

  defp hold_commands(_charge), do: []

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
