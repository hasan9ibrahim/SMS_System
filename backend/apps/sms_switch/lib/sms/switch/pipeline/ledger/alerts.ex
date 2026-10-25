defmodule Sms.Switch.Pipeline.Ledger.Alerts do
  @moduledoc """
  Credit alerts (spec §5.1 Credit Alert with Notice / Warning / Critical %, §7, product owner 2026-10-24) and prepaid
  vendor balance alerts (decision Q22), checked by `Sms.Switch.Pipeline.Ledger.Sync` on every run.

    * a customer with a credit limit and Credit Alert on: the share of the limit in use (how far the balance is below
      0) is compared with its Notice, Warning and Critical percentages; at 100 % it has reached its limit and its
      messages are refused;
    * a prepaid customer (no credit limit): an alert when the balance is used up (0 or less);
    * a prepaid vendor with Balance Alert on (Q22, product owner 2026-10-25): its Notice / Warning / Critical
      percentages (default 50 / 70 / 90) of the prepaid funds used, and the funds used up. It only alerts, it never
      stops traffic.

  Each account's last level is kept in Redis (`cal:`), so one alert goes out per level reached, by one server, and a
  payment that brings the level down re-arms it. Alerts are events (`sms.billing.credit_alert`); the API sends the
  Credit Alert / Balance Alert e-mails from them.

  Every watched account's total and last level are read in one round trip; only an account whose level changed is
  written (two commands per account on every run grew with the number of partners, backend step 7).
  """
  require Logger
  alias Sms.Core.Bus
  alias Sms.Switch.Pipeline.{Ledger, Store}

  @levels %{1 => "notice", 2 => "warning", 3 => "critical", 4 => "limit_reached", 5 => "used_up"}

  @doc "Checks every account's level and publishes the alerts newly reached."
  @spec check([Ledger.account()]) :: :ok
  def check(accounts) do
    watched = Enum.filter(accounts, &watched?/1)
    keys = Enum.map(watched, & &1.key)

    # Nothing watched: no MGET (Redis refuses one without keys; seen in the lab, backend step 8).
    with [_ | _] <- keys,
         {:ok, used} <- Ledger.used_many(keys),
         {:ok, levels} <- Store.command(["MGET" | Enum.map(keys, &"cal:#{&1}")]) do
      watched
      |> Enum.zip(levels)
      |> Enum.each(fn {account, stored} ->
        compare(account, Map.fetch!(used, account.key), stored)
      end)
    else
      [] -> :ok
      :error -> Logger.warning("credit alerts not checked: ledger totals unavailable")
      {:error, reason} -> Logger.warning("credit alerts not checked: #{inspect(reason)}")
    end

    :ok
  end

  defp compare(account, used, stored) do
    balance = account.base - used
    level = level(account, balance)
    if level != to_int(stored), do: raise_level(account, level, balance)
  end

  defp watched?(%{side: :customer, alerts: [_ | _], limit: limit}) when limit > 0, do: true
  defp watched?(%{side: :customer, prepaid: true}), do: true
  # Balance alert off: no alerts for this vendor.
  defp watched?(%{side: :vendor, prepaid: true, alerts: [_ | _]}), do: true
  defp watched?(_account), do: false

  # The level is swapped in Redis: only the server that raises it alerts (the other may have swapped it already).
  defp raise_level(account, level, balance) do
    case Store.command(["SET", "cal:#{account.key}", Integer.to_string(level), "GET"]) do
      {:ok, old} ->
        if level > to_int(old), do: publish(account, level, balance)

      {:error, reason} ->
        Logger.warning("credit alert of #{account.key} not checked: #{inspect(reason)}")
    end
  end

  @doc false
  # 0 none; 1–3 the Notice / Warning / Critical percentage of the credit limit in use; 4 the limit reached; 5 a
  # prepaid balance used up.
  @spec level(Ledger.account(), integer()) :: 0..5
  # A prepaid vendor: the share of the prepaid funds (the base: payments − accepted invoices) used since its last
  # invoice, against its balance alert levels (product owner 2026-10-25).
  def level(%{side: :vendor, prepaid: true, base: base, alerts: alerts}, balance) do
    if balance <= 0,
      do: 5,
      else: alerts |> Enum.take_while(&((base - balance) * 100 / base >= &1)) |> length()
  end

  def level(%{prepaid: true}, balance), do: if(balance <= 0, do: 5, else: 0)

  def level(%{limit: limit, alerts: alerts}, balance) do
    pct = max(0, -balance) * 100 / limit

    if pct >= 100, do: 4, else: alerts |> Enum.take_while(&(pct >= &1)) |> length()
  end

  defp publish(account, level, balance) do
    data = %{
      "enterprise_id" => account.enterprise_id,
      "side" => to_string(account.side),
      "level" => @levels[level],
      "balance" => Decimal.to_string(Ledger.units(balance), :normal),
      "credit_limit" => Decimal.to_string(Ledger.units(account.limit), :normal),
      "currency" => account.currency
    }

    Logger.info(
      "credit alert #{data["level"]} for #{account.key}: balance #{data["balance"]} #{account.currency}"
    )

    case Bus.publish("sms.billing.credit_alert", "billing.credit_alert", data,
           id:
             "credit_alert:#{account.key}:#{level}:#{System.os_time(:millisecond)}:#{System.unique_integer([:positive])}"
         ) do
      {:ok, _} ->
        :ok

      {:error, reason} ->
        # Re-armed so the next run tries again.
        _ = Store.command(["SET", "cal:#{account.key}", Integer.to_string(level - 1)])
        Logger.error("credit alert of #{account.key} not queued: #{inspect(reason)}")
    end
  end

  defp to_int(nil), do: 0
  defp to_int(s) when is_binary(s), do: String.to_integer(s)
  defp to_int(n) when is_integer(n), do: n
end
