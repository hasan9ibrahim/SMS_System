defmodule Sms.Switch.Commands.Inject do
  @moduledoc """
  Messages the platform itself sends (backend step 11c, spec §9.1, §9.2), taken by the pipeline as if the customer
  trunk had submitted them (`Sms.Switch.Pipeline.Intake.inject/3`): never billed to the customer, no receipt to it.

    * **Test SMS** (Route Simulator): one message on a customer trunk, routed by the route rules or straight to a
      chosen vendor trunk. The answer says whether the switch took it; its receipt shows in EDR Search.
    * **EDR Repush**: the selected EDRs' messages sent again on a chosen vendor trunk, each a new attempt carrying the
      repush request's id, so the screen counts the request's outcome from the EDRs.
  """
  alias Sms.Core.ClickHouse
  alias Sms.Switch.Message.Text
  alias Sms.Switch.Pipeline.Intake
  alias Sms.Switch.Smpp.Pdu

  # short_message holds at most 254 octets; a longer text goes in message_payload (SMPP 3.4 §5.3.2.32).
  @short_max 254
  @repush_max 5_000

  @doc "Test SMS: `customer_trunk_id`, `receiver`, optional `sender`, `text`, `data_coding`, `source_ton`, `source_npi`, `vendor_trunk_id`."
  @spec test_sms(map()) :: {:ok, map()} | {:error, term()}
  def test_sms(data) do
    with {:ok, trunk_id} <- id(data["customer_trunk_id"], "customer_trunk_id"),
         {:ok, vendor} <- optional_id(data["vendor_trunk_id"], "vendor_trunk_id"),
         {:ok, receiver} <- receiver(data["receiver"]),
         {:ok, pdu} <-
           pdu(%{
             # The switch refuses a message with no sender (S-2.10); the Route Simulator may leave it empty.
             source: if(blank?(data["sender"]), do: "Test", else: to_string(data["sender"])),
             destination: receiver,
             text: to_string(data["text"] || "Test"),
             data_coding: data["data_coding"],
             source_ton: data["source_ton"],
             source_npi: data["source_npi"]
           }) do
      case Intake.inject(context(trunk_id), pdu, %{kind: "test", vendor_trunk_id: vendor}) do
        {:ok, id} ->
          {:ok,
           %{
             message_id: id,
             status: "ACCEPTD",
             detail: "Taken by the switch; its receipt shows in EDR Search"
           }}

        {:error, reason} ->
          {:ok, %{message_id: nil, status: "REJECTD", detail: "Refused: #{reason_text(reason)}"}}
      end
    end
  end

  @doc "EDR Repush: `request_id`, `vendor_trunk_id`, `edr_ids` (final attempts; at most #{@repush_max})."
  @spec repush(map()) :: {:ok, map()} | {:error, term()}
  def repush(data) do
    with {:ok, request_id} <- id(data["request_id"], "request_id"),
         {:ok, vendor} <- id(data["vendor_trunk_id"], "vendor_trunk_id"),
         {:ok, ids} <- edr_ids(data["edr_ids"]),
         {:ok, rows} <- final_attempts(ids) do
      results = Enum.map(rows, &send_again(&1, vendor, request_id))

      refused = for {:error, reason} <- results, do: reason_text(reason)

      {:ok,
       %{
         sent: Enum.count(results, &match?({:ok, _}, &1)),
         refused: length(refused),
         not_found: length(ids) - length(rows),
         reasons:
           refused |> Enum.frequencies() |> Enum.map(fn {r, n} -> %{reason: r, count: n} end)
       }}
    end
  end

  defp send_again(row, vendor, request_id) do
    with {:ok, pdu} <- pdu(row) do
      internal = %{kind: "repush", vendor_trunk_id: vendor, repush_request_id: request_id}
      Intake.inject(context(row.trunk_id), pdu, internal)
    end
  end

  defp context(trunk_id) do
    %{
      origin: %{session_id: "platform", trunk_id: trunk_id, ip: nil, bind: :tx},
      port: nil,
      node: node(),
      received_at: DateTime.utc_now(),
      buffered: false
    }
  end

  # The final attempt of each message: what the customer sent (before any vendor's translation).
  defp final_attempts(ids) do
    sql = """
    SELECT toString(edr_id), c_trunk_id, src_addr, dst_addr, message_text, c_coding, c_src_ton, c_src_npi
      FROM edr
     WHERE edr_id IN {ids:Array(UUID)} AND is_final_attempt = 1 AND msg_type = 'MT'
     LIMIT 1 BY edr_id
    """

    case ClickHouse.query(sql, %{"ids" => ids}) do
      {:ok, %{rows: rows}} ->
        {:ok,
         for [_id, trunk, src, dst, text, coding, ton, npi] <- rows do
           %{
             trunk_id: trunk,
             source: src,
             destination: dst,
             text: text,
             data_coding: coding,
             source_ton: ton,
             source_npi: npi
           }
         end}

      {:error, reason} ->
        {:error, "the EDR store did not answer: #{inspect(reason)}"}
    end
  end

  @doc false
  # A submit_sm for a text: in the coding asked for (GSM 7-bit when it fits, else UCS-2, when none is given); a binary
  # coding takes the text as hex (as EDRs record a binary body).
  @spec pdu(map()) :: {:ok, Pdu.t()} | {:error, term()}
  def pdu(m) do
    with {:ok, coding, bytes} <- encode(m.text, m.data_coding) do
      fields = %{
        source_addr: m.source,
        source_addr_ton: m.source_ton || 0,
        source_addr_npi: m.source_npi || 0,
        destination_addr: m.destination,
        dest_addr_ton: 1,
        dest_addr_npi: 1,
        data_coding: coding,
        registered_delivery: 0
      }

      {:ok,
       if(byte_size(bytes) <= @short_max,
         do: Pdu.new(:submit_sm, Map.put(fields, :short_message, bytes)),
         else: Pdu.new(:submit_sm, fields, tlvs: [{:message_payload, bytes}])
       )}
    end
  end

  defp encode(text, nil), do: encode(text, if(Text.gsm?(text), do: 0, else: 8))

  defp encode(text, coding) when is_integer(coding) and coding in 0..255 do
    case Text.alphabet(coding) do
      :binary ->
        case Base.decode16(text, case: :mixed) do
          {:ok, bytes} -> {:ok, coding, bytes}
          :error -> {:error, {:bad_input, "a binary message needs its body as hex"}}
        end

      alphabet ->
        case Text.encode(text, alphabet) do
          {:ok, bytes} -> {:ok, coding, bytes}
          :error -> {:ok, 8, elem(Text.encode(text, :ucs2), 1)}
        end
    end
  end

  defp encode(_text, _coding), do: {:error, {:bad_input, "data_coding must be 0 to 255"}}

  defp blank?(v), do: v in [nil, ""] or (is_binary(v) and String.trim(v) == "")

  defp id(n, _name) when is_integer(n) and n > 0, do: {:ok, n}
  defp id(_, name), do: {:error, {:bad_input, "#{name} must be a positive integer"}}

  defp optional_id(nil, _name), do: {:ok, nil}
  defp optional_id(n, name), do: id(n, name)

  defp receiver(r) when is_binary(r) do
    digits = String.replace(r, ~r/[\s+()-]/, "")

    if Regex.match?(~r/^\d{1,20}$/, digits),
      do: {:ok, digits},
      else: {:error, {:bad_input, "receiver must be a number of up to 20 digits"}}
  end

  defp receiver(_), do: {:error, {:bad_input, "receiver must be a number of up to 20 digits"}}

  defp edr_ids(ids) when is_list(ids) and ids != [] and length(ids) <= @repush_max do
    if Enum.all?(ids, &uuid?/1),
      do: {:ok, Enum.uniq(ids)},
      else: {:error, {:bad_input, "edr_ids must be EDR ids (UUIDs)"}}
  end

  defp edr_ids(_), do: {:error, {:bad_input, "edr_ids must list 1 to #{@repush_max} EDR ids"}}

  defp uuid?(id),
    do:
      is_binary(id) and Regex.match?(~r/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/, id)

  @doc false
  @spec reason_text(term()) :: String.t()
  def reason_text({:bad_input, text}) when is_binary(text), do: text
  def reason_text({status, reason}) when is_atom(status), do: "#{reason_text(reason)} (#{status})"
  def reason_text(:no_customer_rate), do: "no customer rate for the destination"

  def reason_text(:customer_rate_blocked),
    do: "the customer's rate for the destination is blocked"

  def reason_text(:vendor_rate_blocked), do: "the vendor's rate for the destination is blocked"
  def reason_text(:no_rule), do: "no route rule matches"
  def reason_text(:blocked), do: "blocked by a route or translation rule"
  def reason_text(:no_vendor), do: "no vendor qualifies"
  def reason_text(:invalid_sender), do: "every vendor that could take it refuses the sender"
  def reason_text(:unknown_vendor), do: "unknown vendor trunk"
  def reason_text(:vendor_inactive), do: "the vendor trunk is inactive or stopped"
  def reason_text(:unknown_trunk), do: "unknown customer trunk"
  def reason_text(:not_ready), do: "the switch is still loading its configuration"
  def reason_text(:multipart), do: "a multipart message cannot be sent this way"

  def reason_text(reason) when is_atom(reason),
    do: reason |> Atom.to_string() |> String.replace("_", " ")

  def reason_text(reason), do: inspect(reason)
end
