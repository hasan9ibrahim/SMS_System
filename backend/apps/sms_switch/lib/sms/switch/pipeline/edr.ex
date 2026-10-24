defmodule Sms.Switch.Pipeline.Edr do
  @moduledoc """
  EDR rows (spec §9.1 schema, `db/clickhouse/migrations`), appended and never updated (docs/BACKEND_PLAN.md §3.2):

    * `edr`: one row per attempt to a vendor, written when the attempt ends; a message refused before it reached a
      vendor gets one row too, with the reason in `command_status` and `c_msg_status` REJECTD;
    * `edr_receipt`: one row per receipt from a vendor (`kind` vendor) and one when the customer's receipt went out
      or could not (`kind` customer), joined to the attempt by `edr_id`.

  Rates, currencies and exchange rates are the ones in force when the message was submitted (S-6.1, S-6.7): the
  customer's and vendor's rates per message, `*_ex_rate` the currency's units per business company base unit and
  `*_sys_rate` the rate in that base. Revenue, cost and the billable flags come with billing at send time (build
  step 6) and stay 0 here.

  Rows travel on the bus (`sms.edr.attempt`, `sms.edr.receipt`) to `Sms.Switch.Pipeline.EdrWriter`, so an EDR is never
  lost while ClickHouse is down (S-7.3).
  """
  alias Sms.Core.Bus
  alias Sms.Switch.Pipeline.Config

  @doc "Publishes an attempt row; a failure is logged by the bus and returned."
  @spec publish_attempt(map()) :: :ok | {:error, term()}
  def publish_attempt(row), do: publish("sms.edr.attempt", "edr.attempt", row)

  @doc "Publishes a receipt row."
  @spec publish_receipt(map()) :: :ok | {:error, term()}
  def publish_receipt(row), do: publish("sms.edr.receipt", "edr.receipt", row)

  defp publish(subject, type, row) do
    case Bus.publish(subject, type, row, id: "#{type}:#{row["edr_id"]}:#{row["row_key"] || ""}") do
      {:ok, _} -> :ok
      {:error, _} = error -> error
    end
  end

  @doc """
  The `edr` row of one attempt. `attempt`: `no`, `final`, `vendor` (nil when no vendor was reached: the message was
  refused or every vendor failed), `submit_time`, `resp_time` (ms), `command_status`, `success`, `vendor_message_id`,
  `msg_count`.
  """
  @spec attempt_row(map(), map()) :: map()
  def attempt_row(msg, attempt) do
    vendor = attempt[:vendor]
    egress = (vendor && vendor.egress) || %{}

    %{
      "edr_id" => attempt.edr_id,
      "row_key" => "#{attempt.no}",
      "start_time" => time(msg.received_at),
      "submit_time" => time(attempt[:submit_time] || msg.received_at),
      "submit_resp_time" => attempt[:resp_time] && time(attempt.resp_time),
      "delivery_time" => nil,
      "msg_type" => "MT",
      "c_msg_status" => msg_status(attempt),
      "v_registered_delivery" => flag(vendor),
      "attempt_no" => attempt.no,
      "is_final_attempt" => flag(attempt.final),
      "is_submit_success" => flag(attempt.success),
      "command_status" => attempt.command_status,
      "msg_count" => attempt[:msg_count] || msg.parts,
      "is_buffered" => flag(msg[:buffered]),
      "measured_tps" => 0,
      "revenue_checked" => decimal(msg.sell && msg.sell.platform)
    }
    |> Map.merge(customer_leg(msg))
    |> Map.merge(customer_addresses(msg.fields))
    |> Map.merge(vendor_addresses(msg, vendor, egress))
    |> Map.merge(destination(msg.destination))
    |> Map.merge(customer_rate(msg))
    |> Map.merge(vendor_leg(msg, vendor, egress, attempt))
  end

  defp msg_status(%{success: success}) when success not in [nil, false], do: "ACCEPTD"
  defp msg_status(%{final: final}) when final not in [nil, false], do: "REJECTD"
  defp msg_status(_attempt), do: ""

  defp flag(value) when value in [nil, false], do: 0
  defp flag(_value), do: 1

  defp customer_leg(msg) do
    trunk = msg.trunk

    %{
      "business_company_id" => trunk.business_company_id || 0,
      "product_category_id" => trunk.product_category_id || 0,
      "c_enterprise_id" => trunk.enterprise_id,
      "c_trunk_id" => trunk.id,
      "c_am_user_id" => trunk.account_manager_id || 0,
      "c_ip" => ip(msg.client.ip),
      "c_port" => msg.client.port || 0,
      "c_session_id" => msg.origin.session_id,
      "c_bind_type" => bind(msg.origin.bind),
      "c_protocol" => "SMPP",
      "c_message_id" => msg.id,
      "c_coding" => msg.data_coding,
      "c_translation_rule_ids" => msg.ingress[:fired] || [],
      "udh" => hex(msg.udh)
    }
  end

  defp customer_addresses(f) do
    %{
      "c_src_ton" => f[:source_addr_ton] || 0,
      "c_src_npi" => f[:source_addr_npi] || 0,
      "c_dst_ton" => f[:dest_addr_ton] || 0,
      "c_dst_npi" => f[:dest_addr_npi] || 0,
      "src_addr" => f[:source_addr] || "",
      "dst_addr" => f[:destination_addr] || "",
      "registered_delivery" => f[:registered_delivery] || 0
    }
  end

  # What the vendor was sent: the egress translation's result, else the ingress one, else the customer's.
  defp vendor_addresses(msg, vendor, egress) do
    ingress = msg.ingress
    f = msg.fields

    %{
      "routed_dst_addr" => Map.get(egress, :receiver, ingress[:receiver] || ""),
      "v_src_addr" => Map.get(egress, :sender, ingress[:sender] || ""),
      "message_text" => msg.text || hex(msg.body),
      "v_message_text" => Map.get(egress, :text) || msg.text || hex(msg.body),
      "v_src_ton" => egress_or(egress, :sender_ton, f, :source_addr_ton),
      "v_src_npi" => egress_or(egress, :sender_npi, f, :source_addr_npi),
      "v_dst_ton" => egress_or(egress, :dest_ton, f, :dest_addr_ton),
      "v_dst_npi" => egress_or(egress, :dest_npi, f, :dest_addr_npi),
      "v_coding" => (vendor && vendor[:data_coding]) || msg.data_coding
    }
  end

  defp egress_or(egress, key, f, field), do: Map.get(egress, key) || f[field] || 0

  defp destination(nil),
    do: %{"c_mccmnc" => "", "c_mcc" => "", "c_mnc" => "", "c_country_iso" => ""}

  defp destination(d),
    do: %{
      "c_mccmnc" => d.mccmnc,
      "c_mcc" => d.mcc,
      "c_mnc" => d.mnc,
      "c_country_iso" => d.country_iso || ""
    }

  defp customer_rate(%{sell: nil} = msg),
    do: %{"c_billing_type" => to_string(msg.trunk.billing_type)}

  defp customer_rate(msg) do
    {ex, sys} = exchange(msg.sell, msg.trunk.base_currency)

    %{
      "c_billing_type" => (msg.ingress[:billing_type] || msg.trunk.billing_type) |> to_string(),
      "c_rate_table_id" => msg.sell.rate_table_id,
      "c_rate_line_id" => msg.sell.line_id,
      "c_rate" => Decimal.to_string(msg.sell.rate, :normal),
      "c_currency" => msg.sell.currency,
      "c_ex_rate" => ex,
      "c_sys_rate" => sys
    }
  end

  defp vendor_leg(_msg, nil, _egress, _attempt), do: %{}

  defp vendor_leg(msg, vendor, egress, attempt) do
    vt = Config.vendor_trunk(vendor.vendor_trunk_id) || %{}

    msg
    |> vendor_rate(vendor[:cost])
    |> Map.merge(%{
      "v_enterprise_id" => vt[:enterprise_id] || 0,
      "v_trunk_id" => vendor.vendor_trunk_id,
      "v_am_user_id" => vt[:account_manager_id] || 0,
      "v_message_id" => attempt[:vendor_message_id] || "",
      "v_message_keys" => attempt[:vendor_message_keys] || [],
      "v_mccmnc" => (msg.destination && msg.destination.mccmnc) || "",
      "v_billing_type" => to_string(vt[:billing_type] || ""),
      "v_translation_rule_ids" => egress[:fired] || []
    })
    |> Map.merge(route(vendor))
  end

  defp vendor_rate(_msg, cost) when cost in [nil, false], do: %{}

  defp vendor_rate(msg, cost) do
    {ex, sys} = exchange(cost, msg.trunk.base_currency)

    %{
      "v_rate_table_id" => cost.rate_table_id,
      "v_rate_line_id" => cost.line_id,
      "v_rate" => Decimal.to_string(cost.rate, :normal),
      "v_currency" => cost.currency,
      "v_ex_rate" => ex,
      "v_sys_rate" => sys
    }
  end

  defp route(vendor) do
    %{
      "route_rule_id" => vendor[:rule_id] || 0,
      "route_type" => to_string(vendor[:route_type] || ""),
      "route_level" => vendor[:level] || 0,
      "route_decided_by" => to_string(vendor[:decided_by] || "")
    }
  end

  # Units of the rate's currency per unit of the business company's base currency, and the rate in that base.
  defp exchange(rate, base) do
    with from when is_number(from) <- Config.per_eur(rate.currency),
         to when is_number(to) and to > 0 <- Config.per_eur(base || rate.currency) do
      ex = Decimal.from_float(from / to) |> Decimal.round(8)

      sys =
        if Decimal.eq?(ex, 0),
          do: Decimal.new(0),
          else: Decimal.div(rate.rate, ex) |> Decimal.round(6)

      {Decimal.to_string(ex, :normal), Decimal.to_string(sys, :normal)}
    else
      _ -> {"1", Decimal.to_string(rate.rate, :normal)}
    end
  end

  @doc """
  An `edr_receipt` row. `r`: `edr_id`, `kind` (`"vendor"` or `"customer"`), `at` (ms), `msg` (the message), `part`,
  `vendor_trunk_id`, `vendor_message_id`, `status`, `error`, `network_error`, `customer_status`, `customer_error`,
  `session_id`, `held_ms`, `late`, `duplicate`, `source` (`"vendor"` or `"switch"` for a receipt we made).
  """
  @spec receipt_row(map()) :: map()
  def receipt_row(r) do
    msg = r.msg

    %{
      "edr_id" => r.edr_id,
      "row_key" => "#{r.kind}:#{r.part}:#{r.at}",
      "kind" => r.kind,
      "receipt_time" => time(r.at),
      "start_time" => time(msg.received_at),
      "c_enterprise_id" => msg.trunk.enterprise_id,
      "c_trunk_id" => msg.trunk.id,
      "v_trunk_id" => r[:vendor_trunk_id] || 0,
      "c_message_id" => msg.id,
      "part_no" => r.part,
      "v_message_id" => r[:vendor_message_id] || "",
      "delivery_delay_ms" => max(0, r.at - msg.received_at),
      "receipt_session_id" => r[:session_id] || "",
      "receipt_held_ms" => r[:held_ms] || 0,
      "is_late" => flag(r[:late]),
      "is_duplicate" => flag(r[:duplicate]),
      "source" => r[:source] || "vendor"
    }
    |> Map.merge(receipt_status(r))
  end

  defp receipt_status(r) do
    %{
      "msg_status" => r[:status] || "",
      "delivery_error" => r[:error] || "",
      "network_error" => r[:network_error] || 0,
      "c_msg_status" => r[:customer_status] || "",
      "c_delivery_error" => r[:customer_error] || ""
    }
  end

  @doc "A new EDR id."
  @spec new_id() :: String.t()
  def new_id do
    <<a::32, b::16, _::4, c::12, _::2, d::62>> = :crypto.strong_rand_bytes(16)
    <<u::128>> = <<a::32, b::16, 4::4, c::12, 2::2, d::62>>
    hex = u |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(32, "0")

    <<p1::binary-8, p2::binary-4, p3::binary-4, p4::binary-4, p5::binary-12>> = hex
    "#{p1}-#{p2}-#{p3}-#{p4}-#{p5}"
  end

  defp time(ms),
    do:
      ms
      |> DateTime.from_unix!(:millisecond)
      |> Calendar.strftime("%Y-%m-%d %H:%M:%S.%f")
      |> binary_part(0, 23)

  defp ip(nil), do: "0.0.0.0"
  defp ip({_, _, _, _} = ip), do: ip |> :inet.ntoa() |> to_string()

  # The EDR column is IPv4; an IPv6 client is recorded as 0.0.0.0 (its address is in the session events).
  defp ip(_), do: "0.0.0.0"

  defp bind(:tx), do: "TX"
  defp bind(:rx), do: "RX"
  defp bind(:trx), do: "TR"
  defp bind(_), do: ""

  defp hex(nil), do: ""
  defp hex(bytes), do: Base.encode16(bytes)

  defp decimal(nil), do: "0"

  defp decimal(f) when is_float(f),
    do: f |> Decimal.from_float() |> Decimal.round(6) |> Decimal.to_string(:normal)
end
