defmodule Sms.Switch.Pipeline.Router do
  @moduledoc """
  Chooses the vendor for a message (spec §6.3, §6.4, S-4.8, S-4.9), the way the Route Simulator shows it
  (`mock/src/api/routeSimulator.ts`, `egress.ts`):

    1. the route rules that can match the destination, in order (`Sms.Switch.Rules.Route.route_through/4`), with the
       message after ingress translation and the customer's rate in the platform currency;
    2. the chosen vendor trunk's own (egress) translation rules on the message; when they block it, that vendor is
       skipped and routing runs again without it, up to ten times (decided 2026-10-18);
    3. the same for a vendor with no bound connection on either server, so a message no connected vendor can take is
       refused before the customer's resp (0x45, decided Q15; backend step 7);
    4. the same for a vendor whose rate line in force is blocked (blocked means blocked, decided 2026-10-30), priced
       with the sender it would receive after its egress translation (§6.2, decided 2026-10-30);
    5. the same for a vendor that cannot take the message as it would get it after its egress translation (§5.5
       capability filter, S-3.9, S-4.4): a data coding it does not allow (unless the text fits one it allows,
       `Sms.Switch.Message.Coding`), a source or destination TON / NPI it does not allow, a multipart message when it
       does not support multipart, or longer than its Max Msg Len; or a sender its egress translation left unfit to
       send (S-4.7, `Sms.Switch.Message.Address`).

  A rule with Deny Multipart never matches a message of more than one part (§6.3, S-3.9).

  Vendors already tried for this message (a refusal, a timeout, no connection) are skipped the same way, so a re-route
  (S-5.2, D4) follows the rules' own order to the next vendor.
  """
  alias Sms.Switch.Message.{Address, Coding, Text}
  alias Sms.Switch.Pipeline.{Config, LiveTps, Revenue, Warmup}
  alias Sms.Switch.Rules.{Route, Translation}
  alias Sms.Switch.Vendor

  @egress_tries 10

  @type input :: %{
          optional(:hlr_ported) => boolean() | nil,
          optional(:count_rule_tps) => boolean(),
          optional(:parts) => pos_integer(),
          optional(:message) => Coding.message() | nil,
          optional(:dest_ton) => non_neg_integer() | nil,
          optional(:dest_npi) => non_neg_integer() | nil,
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
      # §13.27: each warm-up vendor's own count (team trial round 6).
      warmup_sent: fn rule, v ->
        Warmup.sent(rule.id, v, input.customer_trunk.id, input.now_ms)
      end,
      list_has?: &Config.list_has?/3,
      # Deny Multipart (§6.3, S-3.9).
      multipart: (input[:parts] || 1) > 1
    }

    _ = if input[:count_rule_tps], do: count_rule_tps(rules, context, input)
    try_route(rules, context, options, input, skip, @egress_tries)
  end

  # §13.8 "Measured on: all traffic matching this rule": each rule with that scope counts every message its other
  # conditions let through, whichever rule then routes it; so "TPS > 50 → second vendor" can start once the traffic
  # passes 50 (decided 2026-10-25, as the spec words it). Counted once, when the message is taken (not on re-routes).
  defp count_rule_tps(rules, context, input) do
    for %{conditions: %{tps: %{scope: "rule"}}} = rule <- rules,
        Route.others_match?(rule, context) do
      LiveTps.count(["r:#{rule.id}"], input[:parts] || 1)
    end
  end

  # A message routed by a vendor's warm-up threshold counts towards it (§13.27).
  defp count_warmup(
         rules,
         %{rule_id: rule_id, vendor: %{decided_by: :warmup, vendor_trunk_id: vt}},
         input
       ) do
    with %{vendors: vendors} <- Enum.find(rules, &(&1.id == rule_id)),
         %{} = v <-
           Enum.find(vendors, &(&1.vendor_trunk_id == vt and &1[:warmup_count] not in [nil, 0])) do
      Warmup.count(rule_id, v, input.customer_trunk.id, input.now_ms, input[:parts] || 1)
    end
  end

  defp count_warmup(_rules, _decision, _input), do: :ok

  # A service trunk has no connection to wait for (team trial round 12).
  defp bound?(vendor_trunk_id) do
    check = Application.get_env(:sms_switch, __MODULE__, [])[:bound?] || (&Vendor.bound?/1)
    (Config.vendor_trunk(vendor_trunk_id) || %{})[:service] == true or check.(vendor_trunk_id)
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
        routed(rules, context, options, input, skip, tries, decision, vt)
    end
  end

  # The vendor routing picked, or routing run again without it (up to `tries` times) when its egress translation
  # blocks the message, its rate for the destination is blocked (§6.2, blocked means blocked, decided 2026-10-30) or
  # it has no connection.
  defp routed(rules, context, options, input, skip, tries, decision, vt) do
    egress = egress(vt, input)

    case vendor_check(vt, context.mccmnc, egress, input) do
      {:ok, price} ->
        _ = count_warmup(rules, decision, input)
        {:ok, %{decision: decision, vendor_trunk_id: vt, cost: price, egress: egress}}

      :rate_blocked when tries > 1 ->
        blocked = MapSet.put(context[:rate_blocked] || MapSet.new(), vt)

        try_route(
          rules,
          Map.put(context, :rate_blocked, blocked),
          options,
          input,
          skip,
          tries - 1
        )

      _passed_over when tries > 1 ->
        try_route(rules, context, options, input, MapSet.put(skip, vt), tries - 1)

      _passed_over ->
        {:error, :no_vendor, decision}
    end
  end

  # The vendor's price for the message, or why it is passed over.
  defp vendor_check(_vendor_trunk_id, _mccmnc, %{blocked: true}, _input), do: :egress_blocked

  defp vendor_check(vendor_trunk_id, mccmnc, egress, input) do
    case vendor_price(vendor_trunk_id, mccmnc, egress, input) do
      :blocked ->
        :rate_blocked

      price ->
        cond do
          not capable?(Config.vendor_trunk(vendor_trunk_id) || %{}, egress.after, input) ->
            :incapable

          bound?(vendor_trunk_id) ->
            {:ok, price}

          true ->
            :unbound
        end
    end
  end

  # §5.5, S-3.9, S-4.4: whether the vendor can take the message as it would get it after its egress translation (nil
  # lists allow any). Without the message (the Route Simulator's tests), every vendor can.
  defp capable?(_trunk, _after, %{message: nil}), do: true

  defp capable?(trunk, after_, %{message: %{}} = input) do
    src_ton = first([after_.sender_ton, input.sender_ton])
    src_npi = first([after_.sender_npi, input.sender_npi])

    # S-4.7: an egress translation that leaves the sender unfit to send passes the vendor over, as a block does.
    Address.source_problem(after_.sender, src_ton, src_npi) == nil and
      allowed?(trunk[:allowed_src_ton], src_ton) and allowed?(trunk[:allowed_src_npi], src_npi) and
      allowed?(trunk[:allowed_dst_ton], first([after_[:dest_ton], input[:dest_ton]])) and
      allowed?(trunk[:allowed_dst_npi], first([after_[:dest_npi], input[:dest_npi]])) and
      fits?(trunk, input.message, after_.text)
  end

  defp capable?(_trunk, _after, _input), do: true

  defp allowed?(nil, _value), do: true
  defp allowed?(list, value), do: value in list

  # The value the vendor gets: the first one set, else 0 (as the sender fills the PDU).
  defp first(values), do: Enum.find(values, 0, &(&1 != nil))

  # The coding (converted when it must be), the length and the part count the vendor would get.
  defp fits?(trunk, message, text) do
    case Coding.for_vendor(message, text, trunk[:allowed_data_codings]) do
      {:ok, bytes, alphabet, _coding} ->
        not (is_integer(trunk[:max_msg_len]) and Text.units(bytes, alphabet) > trunk[:max_msg_len]) and
          not (trunk[:support_multipart] == false and Text.part_count(bytes, alphabet) > 1)

      {:error, _reason} ->
        false
    end
  end

  # The vendor's price for the message: its Sender ID lines match the sender it receives after its egress
  # translation (§6.2, decided 2026-10-30); `:blocked` when the line in force is blocked.
  defp vendor_price(vendor_trunk_id, mccmnc, egress, input),
    do: Config.vendor_price(vendor_trunk_id, mccmnc, input.now_ms, egress.after.sender)

  @doc """
  The route to one chosen vendor trunk (Test SMS or Repush to a vendor, backend step 11c): its egress translation and
  its cost, with no route rule (`decided_by` manual). Errors: `:unknown_vendor`, `:vendor_inactive` (inactive or
  stopped), `:blocked` (its egress translation blocks the message), `:vendor_rate_blocked` (its rate line for the
  destination is blocked).
  """
  @spec forced(integer(), input()) ::
          {:ok,
           %{
             decision: map(),
             vendor_trunk_id: integer(),
             cost: Config.rate() | nil,
             egress: Translation.result()
           }}
          | {:error, :unknown_vendor | :vendor_inactive | :blocked | :vendor_rate_blocked, nil}
  def forced(vendor_trunk_id, input) do
    case Config.vendor_trunk(vendor_trunk_id) do
      nil ->
        {:error, :unknown_vendor, nil}

      %{active: false} ->
        {:error, :vendor_inactive, nil}

      _trunk ->
        egress = egress(vendor_trunk_id, input)
        price = vendor_price(vendor_trunk_id, input.destination.mccmnc, egress, input)

        cond do
          egress.blocked ->
            {:error, :blocked, nil}

          price == :blocked ->
            {:error, :vendor_rate_blocked, nil}

          true ->
            {:ok,
             %{
               decision: %{
                 rule_id: nil,
                 route_type: :manual,
                 outcome: :route,
                 vendor: %{vendor_trunk_id: vendor_trunk_id, level: 0, decided_by: :manual}
               },
               vendor_trunk_id: vendor_trunk_id,
               cost: price,
               egress: egress
             }}
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
