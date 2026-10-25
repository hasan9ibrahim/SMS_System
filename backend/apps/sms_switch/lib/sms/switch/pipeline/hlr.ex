defmodule Sms.Switch.Pipeline.Hlr do
  @moduledoc """
  HLR / MNP lookups before the customer's resp (§6.5, §13.24; product owner 2026-10-25, S-6.5): on traffic with HLR,
  the destination and network the message is rated and routed by come from the lookup instead of the master table.

  Which traffic, and which providers:

    * a route rule's action "Do HLR with policy X" for the customer trunks it names (all of the rule's traffic when
      it names none) wins; the policy's entry for the destination (its network, else its country, else the catch-all)
      lists the providers in order, or for "auto" those meeting the minimum success rate by price, then the rest;
    * else the customer trunk's HLR rules in their order: the first whose DNID pattern matches the receiver names the
      provider.

  A provider that is inactive, down, or over its daily budget is skipped. A provider that answers with an error
  falls back to the next; a provider that does not answer within its timeout ends the lookup (product owner
  2026-10-25: the master table then, so the resp waits at most one timeout). When no provider answers, the message
  is rated and routed by the master table, as without HLR.

  Results are cached in Redis (`hlr:<number>`): the policy entry's hours for ported / not ported numbers, else the
  provider's Enable Caching days; a cached result is free. The cost of a live lookup (the provider's price for the
  destination, else its default) is recorded in the EDR (`hlr_cost_sys`); charging it to the customer comes later
  (product owner 2026-10-25).
  """
  require Logger
  alias Sms.Switch.Pipeline.{Config, Store}

  @type result :: %{
          provider_id: integer(),
          fetch_type: String.t(),
          mccmnc: String.t() | nil,
          ported: boolean() | nil,
          accomplished: boolean(),
          error_code: non_neg_integer(),
          cost_sys: float()
        }

  @doc "What a lookup of this message would use, or nil when its traffic has no HLR."
  @spec plan(integer(), String.t(), map() | nil, integer() | nil) :: map() | nil
  def plan(trunk_id, receiver, table_destination, route_rule_id) do
    h = Config.hlr()

    case action(h, route_rule_id, trunk_id) do
      %{policy_id: policy_id} ->
        policy_plan(h, Map.get(h.policies, policy_id, []), table_destination)

      nil ->
        trunk_plan(h, trunk_id, receiver)
    end
  end

  @doc "Whether a route rule may ask this trunk's traffic for HLR (so the route is worth deciding first)."
  @spec actions_for?(integer()) :: boolean()
  def actions_for?(trunk_id) do
    Config.hlr().actions
    |> Map.values()
    |> Enum.any?(&(&1.customer_trunk_ids == [] or trunk_id in &1.customer_trunk_ids))
  end

  defp action(_h, nil, _trunk_id), do: nil

  defp action(h, rule_id, trunk_id) do
    case Map.get(h.actions, rule_id) do
      %{customer_trunk_ids: ids} = a when ids == [] -> a
      %{customer_trunk_ids: ids} = a -> if trunk_id in ids, do: a
      nil -> nil
    end
  end

  defp trunk_plan(h, trunk_id, receiver) do
    h.trunk_rules
    |> Map.get(trunk_id, [])
    |> Enum.find_value(fn rule_id ->
      rule = Map.fetch!(h.rules, rule_id)
      if Regex.match?(rule.regex, receiver), do: Map.get(h.providers, rule.provider_id)
    end)
    |> case do
      nil -> nil
      provider -> %{providers: [provider], entry: nil}
    end
  end

  defp policy_plan(h, entries, dest) do
    case entry_for(entries, dest && dest.mccmnc) do
      nil ->
        nil

      entry ->
        listed = for id <- entry.provider_ids, p = Map.get(h.providers, id), do: p
        %{providers: order(entry, listed, h, dest), entry: entry}
    end
  end

  @doc false
  # The policy entry for a network: its own code, else its country's MCC, else the catch-all (mock `entryFor`).
  def entry_for(entries, mccmnc) do
    (mccmnc && Enum.find(entries, &(&1.code == mccmnc))) ||
      (mccmnc && Enum.find(entries, &(&1.code == binary_part(mccmnc, 0, 3)))) ||
      Enum.find(entries, &is_nil(&1.code))
  end

  # "auto": those meeting the minimum success rate first, each group by price (mock `orderProviders`).
  defp order(%{mode: :auto} = entry, providers, h, dest) do
    Enum.sort_by(providers, fn p -> {if(meets?(entry, p), do: 0, else: 1), price(h, p, dest)} end)
  end

  defp order(_entry, providers, _h, _dest), do: providers

  defp meets?(%{min_success_pct: nil}, _p), do: true
  defp meets?(%{min_success_pct: min}, p), do: (p.success_pct || 0) >= min

  @doc false
  # The provider's price for the destination: the network's own, else its country's "all networks", else the default.
  def price(h, provider, dest) do
    rate =
      (dest && Map.get(h.rates, {provider.id, dest.mccmnc})) ||
        (dest && Map.get(h.rates, {provider.id, {:all, dest.mcc}})) || provider.default_rate

    to_float(rate)
  end

  # ---------------------------------------------------------------- the lookup

  @doc "Looks the number up (cache first, then the plan's providers); nil when no provider could be asked."
  @spec lookup(map(), String.t(), map() | nil) :: result() | nil
  def lookup(plan, number, table_destination) do
    case cached(number) do
      {:ok, result} -> result
      :miss -> ask(plan, number, table_destination, plan.providers, nil)
    end
  end

  defp cached(number) do
    with {:ok, json} when is_binary(json) <- Store.command(["GET", "hlr:" <> number]),
         {:ok, %{"p" => provider_id} = c} <- Jason.decode(json) do
      {:ok,
       %{
         provider_id: provider_id,
         fetch_type: "cached",
         mccmnc: c["m"],
         ported: c["o"],
         accomplished: true,
         error_code: 0,
         cost_sys: 0.0
       }}
    else
      _ -> :miss
    end
  end

  defp ask(_plan, _number, _dest, [], last), do: last

  defp ask(plan, number, dest, [provider | rest], last) do
    h = Config.hlr()
    cost = price(h, provider, dest)

    cond do
      provider.live_status in [:inactive, :down] ->
        ask(plan, number, dest, rest, last)

      over_budget?(provider, cost) ->
        Logger.info("HLR provider #{provider.id} over its daily budget: skipped")
        ask(plan, number, dest, rest, last)

      true ->
        started = System.monotonic_time(:millisecond)
        answer = client().request(provider, number)
        spend(provider, cost)
        cost_sys = Config.to_platform(cost, provider.currency) || 0.0

        case answer do
          {:ok, %{accomplished: true} = found} ->
            result = live(provider, found, cost_sys)
            _ = remember(plan, provider, number, result)
            result

          {:ok, found} ->
            ask(plan, number, dest, rest, live(provider, found, cost_sys))

          {:error, :timeout} ->
            Logger.warning(
              "HLR provider #{provider.id} gave no answer in #{System.monotonic_time(:millisecond) - started} ms: " <>
                "master table used"
            )

            failed(provider, cost_sys, 408)

          {:error, reason} ->
            Logger.warning(
              "HLR provider #{provider.id} failed (#{inspect(reason)}): next provider"
            )

            ask(plan, number, dest, rest, failed(provider, cost_sys, 0))
        end
    end
  end

  defp live(provider, found, cost_sys) do
    %{
      provider_id: provider.id,
      fetch_type: "live",
      mccmnc: found[:mccmnc],
      ported: found[:ported],
      accomplished: found.accomplished,
      error_code: found[:error_code] || 0,
      cost_sys: cost_sys
    }
  end

  defp failed(provider, cost_sys, code) do
    %{
      provider_id: provider.id,
      fetch_type: "live",
      mccmnc: nil,
      ported: nil,
      accomplished: false,
      error_code: code,
      cost_sys: cost_sys
    }
  end

  # Cache time: the policy entry's hours for a ported / not ported number, else the provider's days.
  defp remember(plan, provider, number, result) do
    hours =
      case plan.entry do
        %{cache_hours_ported: h} when result.ported == true and is_number(h) -> h
        %{cache_hours_not_ported: h} when result.ported != true and is_number(h) -> h
        _ -> provider.cache_days * 24
      end

    if hours > 0 and result.mccmnc do
      json = Jason.encode!(%{p: provider.id, m: result.mccmnc, o: result.ported})
      _ = Store.command(["SET", "hlr:" <> number, json, "EX", round(hours * 3600)])
    end
  end

  # The day's spend per provider, in millionths of its currency, shared by both servers.
  defp over_budget?(%{daily_budget: nil}, _cost), do: false

  defp over_budget?(provider, cost) do
    case Store.command(["GET", budget_key(provider)]) do
      {:ok, spent} when is_binary(spent) ->
        (String.to_integer(spent) + micro(cost)) / 1_000_000 > to_float(provider.daily_budget)

      _ ->
        false
    end
  end

  defp spend(%{daily_budget: nil}, _cost), do: :ok

  defp spend(provider, cost) do
    key = budget_key(provider)
    _ = Store.command(["INCRBY", key, micro(cost)])
    _ = Store.command(["EXPIRE", key, 2 * 86_400])
    :ok
  end

  defp budget_key(provider),
    do: "hlrbud:#{provider.id}:#{Date.to_iso8601(Date.utc_today(), :basic)}"

  defp micro(amount), do: round(amount * 1_000_000)

  defp to_float(%Decimal{} = d), do: Decimal.to_float(d)
  defp to_float(n) when is_integer(n), do: n * 1.0
  defp to_float(n) when is_float(n), do: n
  defp to_float(_), do: 0.0

  defp client,
    do: Application.get_env(:sms_switch, __MODULE__, [])[:client] || Sms.Switch.Pipeline.Hlr.Http
end
