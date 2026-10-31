defmodule Sms.Switch.Pipeline.Billing do
  @moduledoc """
  When a message is billable and for how much (spec §5.4, §5.5 Billing Type, §7), at the rates in force when it was
  submitted (S-6.1; a later rate change or RN never re-rates it, §13.32).

  Each side has its trunk's Billing Type (the customer's may be changed by an ingress translation, §6.4):

    * **attempt**: billable once we tried it: the customer on the message's final attempt to a vendor, a vendor on
      each attempt it received;
    * **submit**: billable once a vendor accepted it (submit_sm_resp OK);
    * **reported**: billable once its final receipt came (any final status);
    * **delivery**: billable only when delivered (DELIVRD).

  The customer is billed once per message, never per re-route. Attempt and submit are decided when the attempt ends
  and written on the `edr` attempt row; reported and delivery when the final status is known, on an `edr_receipt`
  outcome row (ClickHouse migration `005_outcome_billing.sql`). The customer's side bills on the status it was told
  (after the DLR maps), a vendor's on the vendor's own status. A message refused before it reached a vendor is never
  billed. Amounts: the customer's rate × its message parts, a vendor's rate × the parts sent to it.
  """
  alias Sms.Switch.Pipeline.{Config, Revenue}

  @at_send ["attempt", "submit"]

  @doc "The customer's billing type for a message (an ingress translation's wins, §6.4)."
  @spec customer_type(map()) :: String.t()
  def customer_type(msg),
    do: to_string(msg.ingress[:billing_type] || msg.trunk[:billing_type] || "submit")

  @doc "A vendor trunk's billing type."
  @spec vendor_type(integer() | nil) :: String.t()
  def vendor_type(nil), do: ""

  def vendor_type(vendor_trunk_id),
    do:
      to_string(
        (Config.ready?() && (Config.vendor_trunk(vendor_trunk_id) || %{})[:billing_type]) || ""
      )

  @doc "Whether the billing type decides when the attempt ends (attempt, submit)."
  @spec at_send?(String.t()) :: boolean()
  def at_send?(type), do: type in @at_send

  @doc "Billable when an attempt ends: `success` = the vendor accepted it."
  @spec on_send?(String.t(), boolean()) :: boolean()
  def on_send?("attempt", _success), do: true
  def on_send?("submit", success), do: success == true
  def on_send?(_type, _success), do: false

  @doc "Billable on the final status of the attempt (reported, delivery)."
  @spec on_receipt?(String.t(), String.t() | nil) :: boolean()
  def on_receipt?("reported", status), do: status not in [nil, "", "ENROUTE", "ACCEPTD"]
  def on_receipt?("delivery", status), do: status == "DELIVRD"
  def on_receipt?(_type, _status), do: false

  @doc """
  The billable flags of an attempt row (`row`: `no`, `final`, `success`, `vendor`, `accepted`): the customer on the
  final attempt of a message not yet billed, a vendor on any attempt it received. A vendor that accepted some parts of
  an attempt that then failed (`accepted` > 0) is billed for those as accepted (D2).
  """
  @spec flags(map(), map()) :: %{customer_billable: boolean(), vendor_billable: boolean()}
  def flags(msg, row) do
    vendor = row[:vendor]
    success = row[:success] == true
    accepted = success or (row[:accepted] || 0) > 0

    customer =
      msg[:sell] != nil and row[:final] == true and (row[:no] || 0) > 0 and
        not Map.get(msg, :charged, false) and
        on_send?(customer_type(msg), success)

    %{
      customer_billable: customer,
      vendor_billable: vendor != nil and on_send?(vendor_type(vendor.vendor_trunk_id), accepted)
    }
  end

  @doc """
  What an outcome row needs, kept with the message while it waits for its receipts: both sides' types, rates and
  parts, and the report dimensions of the attempt.
  """
  @spec of_attempt(map(), map(), pos_integer()) :: map()
  def of_attempt(msg, route, submits) do
    vt = Config.vendor_trunk(route.vendor_trunk_id) || %{}
    trunk = msg.trunk

    %{
      c_type: customer_type(msg),
      c_parts: msg.parts,
      sell: msg[:sell],
      charged: Map.get(msg, :charged, false),
      v_type: to_string(vt[:billing_type] || ""),
      v_parts: submits,
      cost: route[:cost],
      base_currency: trunk[:base_currency],
      attempt_no: 0,
      # §13.9: where its revenue counts once billed.
      rev_keys: Revenue.keys(msg, route[:rule_id]),
      dims: dims(trunk, vt, msg.destination || %{}, route)
    }
  end

  # The report dimensions of the attempt (edr_hourly's key).
  defp dims(trunk, vt, d, route) do
    %{
      "business_company_id" => trunk[:business_company_id] || 0,
      "product_category_id" => trunk[:product_category_id] || 0,
      "c_am_user_id" => trunk[:account_manager_id] || 0,
      "v_enterprise_id" => vt[:enterprise_id] || 0,
      "v_am_user_id" => vt[:account_manager_id] || 0,
      "c_mccmnc" => d[:mccmnc] || "",
      "c_country_iso" => d[:country_iso] || "",
      "route_rule_id" => route[:rule_id] || 0
    }
  end

  @doc "A rate × parts, and the same in the business company's base currency: `{amount, amount_sys}` (strings)."
  @spec amount(map() | nil, non_neg_integer(), String.t() | nil) :: {String.t(), String.t()}
  def amount(nil, _parts, _base), do: {"0", "0"}

  def amount(rate, parts, base),
    do: {money(Decimal.mult(rate.rate, parts)), money(Decimal.mult(sys_rate(rate, base), parts))}

  # 6 decimals (Q20), written without trailing zeros.
  defp money(d), do: d |> Decimal.round(6) |> Decimal.normalize() |> Decimal.to_string(:normal)

  @doc "A rate in the business company's base currency, at today's exchange rate (S-6.7)."
  @spec sys_rate(map(), String.t() | nil) :: Decimal.t()
  def sys_rate(rate, base), do: rate |> exchange(base) |> elem(1)

  @doc """
  Units of the rate's currency per unit of the business company's base currency, and the rate in that base:
  `{ex, sys}`. Without exchange rates: `{1, rate}`.
  """
  @spec exchange(map(), String.t() | nil) :: {Decimal.t(), Decimal.t()}
  def exchange(rate, base) do
    with from when is_number(from) <- Config.per_eur(rate.currency),
         to when is_number(to) and to > 0 <- Config.per_eur(base || rate.currency) do
      ex = Decimal.from_float(from / to) |> Decimal.round(8)

      if Decimal.eq?(ex, 0),
        do: {ex, Decimal.new(0)},
        else: {ex, Decimal.div(rate.rate, ex) |> Decimal.round(6)}
    else
      _ -> {Decimal.new(1), rate.rate}
    end
  end
end
