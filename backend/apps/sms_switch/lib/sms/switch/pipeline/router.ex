defmodule Sms.Switch.Pipeline.Router do
  @moduledoc """
  Chooses the vendor for a message (spec §6.3, §6.4, S-4.8, S-4.9), the way the Route Simulator shows it
  (`mock/src/api/routeSimulator.ts`, `egress.ts`):

    1. the route rules that can match the destination, in order (`Sms.Switch.Rules.Route.route_through/4`), with the
       message after ingress translation and the customer's rate in the platform currency;
    2. the chosen vendor trunk's own (egress) translation rules on the message; when they block it, that vendor is
       skipped and routing runs again without it, up to ten times (decided 2026-10-18);
    3. the same for a vendor with no bound connection on either server, so a message no connected vendor can take is
       refused before the customer's resp (0x45, decided Q15; backend step 7).

  Vendors already tried for this message (a refusal, a timeout, no connection) are skipped the same way, so a re-route
  (S-5.2, D4) follows the rules' own order to the next vendor.
  """
  alias Sms.Switch.Pipeline.{Config, LiveTps, Revenue}
  alias Sms.Switch.Rules.{Route, Translation}
  alias Sms.Switch.Vendor

  @egress_tries 10

  @type input :: %{
          optional(:hlr_ported) => boolean() | nil,
          customer_trunk: map(),
          sender: String.t(),
          receiver: String.t(),
          text: String.t(),
          sender_ton: non_neg_integer() | nil,
          sender_npi: non_neg_integer() | nil,
          destination: Config.destination(),
          sell: Config.rate(),
          now_ms: integer()
        }

  @type routed :: %{
          decision: Route.decision(),
          vendor_trunk_id: integer(),
          cost: Config.rate() | nil,
          egress: Translation.result()
        }

  @doc """
  The vendor for a message, skipping `skip` (vendor trunk ids). Errors: `:no_rule` (no rule matches), `:blocked` (the
  matching rule blocks), `:no_vendor` (the rules matched but no vendor qualifies), with the last decision.
  """
  @spec route(input(), MapSet.t()) ::
          {:ok, routed()} | {:error, :no_rule | :blocked | :no_vendor, Route.decision() | nil}
  def route(input, skip \\ MapSet.new()) do
    mccmnc = input.destination.mccmnc
    rules = Config.route_rules(mccmnc, input.now_ms)
    options = Config.vendor_options(mccmnc, input.now_ms)

    context = %{
      now: input.now_ms,
      customer_trunk_id: input.customer_trunk.id,
      category_id: input.customer_trunk.product_category_id,
      receiver: input.receiver,
      sender: input.sender,
      content: input.text,
      mccmnc: mccmnc,
      destination: "#{input.destination.country} · #{network(input.destination)}",
      # §13.8: live TPS from the switch's counters, with each rule's hysteresis.
      tps: fn rule_id, t ->
        LiveTps.check(rule_id, LiveTps.scope_key(t[:scope], rule_id, input), t)
      end,
      vendor_tps_pct: &LiveTps.vendor_pct(&1, Config.vendor_trunk(&1)[:tps_limit]),
      sell_rate: input.sell.platform,
      # §13.9: accumulated revenue from the switch's counters, per scope and period.
      accumulated_revenue: fn rule_id, rev ->
        Revenue.value(
          LiveTps.scope_key(rev[:scope], rule_id, input),
          rev[:period],
          input.customer_trunk.enterprise_id
        )
      end,
      # §13.24: the HLR result's ported flag, for rules with an HLR Ported condition.
      hlr_ported: input[:hlr_ported],
      warmup_sent: 0,
      list_has?: &Config.list_has?/3
    }

    try_route(rules, context, options, input, skip, @egress_tries)
  end

  defp bound?(vendor_trunk_id) do
    check = Application.get_env(:sms_switch, __MODULE__, [])[:bound?] || (&Vendor.bound?/1)
    check.(vendor_trunk_id)
  end

  defp network(%{all_networks: true}), do: "All networks"
  defp network(d), do: d.network

  defp try_route(rules, context, options, input, skip, tries) do
    %{decision: decision} =
      Route.route_through(rules, Map.put(context, :egress_blocked, skip), options, 0)

    case decision do
      nil ->
        {:error, :no_rule, nil}

      %{outcome: :block} ->
        {:error, :blocked, decision}

      %{outcome: :no_vendor} ->
        {:error, :no_vendor, decision}

      %{outcome: :route, vendor: %{vendor_trunk_id: vt}} ->
        egress = egress(vt, input)

        cond do
          not egress.blocked and bound?(vt) ->
            cost = Config.vendor_rate(vt, context.mccmnc, input.now_ms)
            {:ok, %{decision: decision, vendor_trunk_id: vt, cost: cost, egress: egress}}

          tries > 1 ->
            try_route(rules, context, options, input, MapSet.put(skip, vt), tries - 1)

          true ->
            {:error, :no_vendor, decision}
        end
    end
  end

  @doc "The vendor trunk's egress translation of the message after ingress (S-4.8)."
  @spec egress(integer(), map()) :: Translation.result()
  def egress(vendor_trunk_id, input) do
    Translation.run(
      Config.translation_rules(:vendor, vendor_trunk_id),
      %{
        sender: input.sender,
        receiver: input.receiver,
        text: input.text,
        sender_ton: input.sender_ton,
        sender_npi: input.sender_npi
      },
      translation_context()
    )
  end

  @doc "What the translation engine needs from the configuration."
  @spec translation_context() :: Translation.Context.t()
  def translation_context do
    %Translation.Context{
      list_has?: &Config.list_matches?/3,
      list_entries: &Config.list_entries/1,
      templates: &Config.templates/2,
      mccmnc_of: &Config.mccmnc_of/1,
      now: DateTime.utc_now()
    }
  end
end
