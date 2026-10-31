defmodule Sms.Switch.Pipeline.Intake do
  @moduledoc """
  The message pipeline's front: a customer's `submit_sm` / `data_sm` from the moment it arrives to its
  `submit_sm_resp` (spec §2, §6, docs/BACKEND_PLAN.md §3.3). In memory, in this order:

    1. **checks**: the message body (short_message or message_payload, not both, S-2.8), the multipart header (UDH
       or SAR, S-3.6), an empty message (0x01, D10), the addresses (0x0A / 0x0B, S-2.10);
    2. **ingress translation**: the customer trunk's translation rules in their order (§6.4, §13.2); a block refuses
       the message (0x45);
    3. **destination and rate**: the longest dial code of the receiver (§6.1) and the customer's rate (§5.4); none →
       0x0B (S-6.2);
    4. **routing**: the route rules and the egress-block skip (`Sms.Switch.Pipeline.Router`); no rule, a blocking rule
       or no vendor → 0x45 (decided Q15);
    5. **credit**: `Sms.Switch.Pipeline.Credit` (balances come with build step 6);
    6. **stored**: the message goes on the durable bus (`sms.msg.accepted`, JetStream), and only then the resp is
       sent with our message_id (S-2.2). The vendor leg runs from the bus (`Sms.Switch.Pipeline.Sender`).

  A message refused here is answered at once and recorded as an EDR (attempt 0, REJECTD, the reason as
  command_status).

  Translation growing the part count (D3) does not refuse the message here: it is accepted and gets a REJECTD receipt,
  as decided.

  The parts of a multipart message (UDH or SAR) are answered at once and held until all have come
  (`Sms.Switch.Pipeline.Reassembly`, S-3.2); steps 2–6 then run once on the whole message (S-4.3).
  """
  @behaviour Sms.Switch.Customer.Intake
  require Logger
  alias Sms.Core.Bus
  alias Sms.Switch.Customer.Intake.NotReady
  alias Sms.Switch.Customer.Trunk
  alias Sms.Switch.Message.{Concat, Text}
  alias Sms.Switch.Metrics

  alias Sms.Switch.Pipeline.{
    Backlog,
    Buffers,
    Config,
    Credit,
    Delayed,
    Edr,
    Hlr,
    LiveTps,
    MessageId,
    Queries,
    Reassembly,
    Router,
    Store
  }

  alias Sms.Switch.Rules.Translation
  alias Sms.Switch.Smpp.{Pdu, Status}
  alias Sms.Switch.Throttle

  # How long a queued mark lasts (a buffered message can wait for its TPS) and a cancelled one is remembered.
  @queued_s 86_400

  @impl true
  def handle(context, %Pdu{command: command} = pdu) when command in [:submit_sm, :data_sm] do
    reply =
      cond do
        # Overload protection (backend step 7): the sender is too far behind to take more now.
        Backlog.over?() -> unread(context, :esme_rthrottled)
        not Config.ready?() -> unread(context, :esme_rsyserr)
        true -> accept(context, pdu)
      end

    Metrics.submit(reply)
    reply
  end

  # S-2.15, D8.
  def handle(context, %Pdu{command: :query_sm} = pdu), do: Queries.query(context, pdu.fields)
  def handle(context, %Pdu{command: :cancel_sm} = pdu), do: Queries.cancel(context, pdu.fields)
  def handle(context, pdu), do: NotReady.handle(context, pdu)

  defp unread(context, status) do
    leave_buffer(context)
    {:error, status}
  end

  @doc false
  # S-2.4: a message accepted over its trunk's TPS holds an overflow buffer place until the buffer releases it
  # (`Sms.Switch.Pipeline.Buffers`). One that never reaches the buffer (refused, a duplicate, not stored) gives its
  # place back at once; the parts of a multipart message give theirs back as their group ends (`Reassembly`).
  @spec leave_buffer(map(), non_neg_integer()) :: :ok
  def leave_buffer(msg_or_context, n \\ 1)

  def leave_buffer(%{buffered: true, trunk: %{id: id}}, n),
    do: Throttle.buffer_release(Trunk.buffer_key(id), n)

  def leave_buffer(_msg, _n), do: :ok

  @doc """
  A message from the platform itself (backend step 11c): Test SMS from the Route Simulator or EDR Repush (§9.2), taken
  as if the customer trunk had submitted it, with `internal`:

    * `kind`: `"test"` or `"repush"`;
    * `vendor_trunk_id`: send to this vendor trunk instead of the route rules' choice, and never re-route to another
      (nil: the route rules decide, as for the customer's own traffic);
    * `repush_request_id`: written on its EDRs, so the screen counts the request's outcome.

  It is never billed to the customer and the customer gets no receipt for it (it never sent it); the vendor is billed
  as usual. No duplicate filter, Delayed Submit, overflow buffer or customer credit check applies. Answers the message
  id, or why it was refused (nothing is written for a refused one).
  """
  @spec inject(map(), Pdu.t(), map()) :: {:ok, String.t()} | {:error, term()}
  def inject(context, %Pdu{} = pdu, internal) do
    cond do
      not Config.ready?() ->
        {:error, :not_ready}

      trunk = Config.customer_trunk(context.origin.trunk_id) ->
        inject(context, pdu, internal, trunk)

      true ->
        {:error, :unknown_trunk}
    end
  end

  defp inject(context, pdu, internal, trunk) do
    msg = context |> new_message(pdu, trunk) |> Map.merge(%{internal: internal, charged: true})

    with {:ok, msg} <- build(msg, pdu),
         :ok <- process(msg) do
      {:ok, msg.id}
    else
      {:part, _msg} -> {:error, :multipart}
      {:reject, status, reason, _msg} -> {:error, {status, reason}}
      {:error, _} = error -> error
    end
  end

  defp accept(context, pdu) do
    case Config.customer_trunk(context.origin.trunk_id) do
      # The trunk is newer than the pipeline's configuration (loaded within seconds): the client retries.
      nil ->
        unread(context, :esme_rsyserr)

      trunk ->
        msg = new_message(context, pdu, trunk)

        case build(msg, pdu) do
          {:reject, status, reason, msg} -> refuse(msg, status, reason)
          {kind, msg} -> filtered(kind, msg)
        end
    end
  end

  defp new_message(context, pdu, trunk) do
    %{
      id: MessageId.new(),
      received_at: DateTime.to_unix(context.received_at, :millisecond),
      node: node(),
      origin: context.origin,
      client: %{ip: context.origin.ip, port: context.port},
      trunk: trunk,
      command: pdu.command,
      fields: Map.drop(pdu.fields, [:short_message]),
      tlvs: Enum.reject(pdu.tlvs, &match?({:message_payload, _}, &1)),
      data_coding: Map.get(pdu.fields, :data_coding, 0),
      alphabet: nil,
      udh: <<>>,
      body: <<>>,
      text: nil,
      concat: nil,
      parts: 1,
      payload: false,
      ingress: %{},
      destination: nil,
      sell: nil,
      route: nil,
      rejected: nil,
      buffered: Map.get(context, :buffered, false),
      # A buffered message waits for these counters before it goes to a vendor (S-2.4).
      tps_counters:
        if(Map.get(context, :buffered, false), do: Trunk.tps_counters(context.trunk), else: [])
    }
  end

  # ---------------------------------------------------------------- the steps

  # The checks of the message as sent; a part of a multipart message is then held for the rest (S-3.2).
  defp build(msg, pdu) do
    with {:ok, msg} <- body(msg, pdu),
         {:ok, msg} <- addresses(msg) do
      if msg.concat, do: {:part, msg}, else: {:ok, msg}
    end
  end

  @doc false
  # The decision and storage of a whole message (one sent as one, or put together from its parts): ingress
  # translation, rate, route and credit, then the durable bus.
  @spec process(map()) :: :ok | {:reject, atom(), term(), map()} | {:error, term()}
  def process(msg) do
    with {:ok, msg} <- run_ingress(msg),
         msg = hlr(msg),
         {:ok, msg} <- rate(msg),
         {:ok, msg} <- route_now(msg),
         :ok <- credit(msg) do
      store(msg)
    end
  end

  # D6, S-5.16: the same message again on this trunk within its window gets the first one's id and is not sent again;
  # the same message coming back on another trunk while ours is in flight (a vendor routing into us) is refused.
  defp filtered(kind, msg) do
    fingerprint = fingerprint(msg)

    case duplicate(msg, fingerprint) do
      {:duplicate, first} ->
        Logger.info(
          "duplicate of #{first} on trunk #{msg.trunk.id}: answered with its id, not sent (D6)"
        )

        leave_buffer(msg)
        {:ok, %{message_id: first}, []}

      :new ->
        if loop?(msg),
          do: refuse_filtered(msg, fingerprint, :esme_rsubmitfail, :loop),
          else: go(kind, msg, fingerprint)

      {:error, reason} ->
        Logger.error("duplicate filter unavailable, message taken: #{inspect(reason)}")
        go(kind, msg, nil)
    end
  end

  defp go(:part, msg, _fingerprint), do: Reassembly.hold(msg)

  defp go(:ok, msg, fingerprint) do
    reply = if Delayed.delayed?(msg), do: delayed(msg), else: answer(msg, process(msg))

    case reply do
      {:ok, _, _} = ok ->
        ok

      error ->
        forget_fingerprint(msg, fingerprint)
        error
    end
  end

  # S-2.18, D11: stored as usual, then the resp waits for the vendor's outcome.
  defp delayed(msg) do
    :ok = Delayed.join(msg.id)

    case process(msg) do
      :ok ->
        Delayed.await(msg.id)

      other ->
        _ = Delayed.leave(msg.id)
        answer(msg, other)
    end
  end

  defp refuse_filtered(msg, fingerprint, status, reason) do
    forget_fingerprint(msg, fingerprint)
    refuse(msg, status, reason)
  end

  # A refused message is not a duplicate of anything: a resend of it is a new message.
  defp forget_fingerprint(_msg, nil), do: :ok

  defp forget_fingerprint(msg, fingerprint) do
    _ = Store.release_fingerprint(msg.trunk.id, fingerprint)
    :ok
  end

  defp duplicate(msg, fingerprint) do
    case msg.trunk[:duplicate_window_s] || 0 do
      0 -> :new
      window -> Store.claim_fingerprint(msg.trunk.id, fingerprint, msg.id, window)
    end
  end

  defp loop?(%{trunk: %{loop_detection: true}} = msg) do
    f = msg.fields

    case Store.in_flight(fingerprint(f[:source_addr], f[:destination_addr], msg.text || msg.body)) do
      {:ok, trunk} when is_integer(trunk) and trunk != msg.trunk.id -> true
      _ -> false
    end
  end

  defp loop?(_msg), do: false

  # A part's fingerprint includes its reference and number, so the parts of one message are not each other's duplicates.
  defp fingerprint(msg) do
    f = msg.fields
    part = if msg.concat, do: ":#{msg.concat.ref}:#{msg.concat.seq}/#{msg.concat.total}", else: ""
    fingerprint(f[:source_addr], f[:destination_addr], (msg.text || msg.body) <> part)
  end

  @doc "The fingerprint of a message for the duplicate filter and Loop Detection: source, destination and text (D6)."
  @spec fingerprint(String.t() | nil, String.t() | nil, binary()) :: String.t()
  def fingerprint(source, destination, text) do
    :crypto.hash(:sha256, [source || "", 0, destination || "", 0, text || ""])
    |> binary_part(0, 16)
    |> Base.url_encode64(padding: false)
  end

  defp answer(msg, :ok), do: {:ok, %{message_id: msg.id}, []}
  defp answer(_msg, {:reject, status, reason, msg}), do: refuse(msg, status, reason)

  defp answer(msg, {:error, reason}) do
    Logger.error("message #{msg.id} not stored, answered 0x14: #{inspect(reason)}")
    leave_buffer(msg)
    {:error, :esme_rmsgqful}
  end

  # S-2.8: short_message and message_payload together are refused; data_sm carries its text in message_payload only.
  defp body(msg, pdu) do
    short = Map.get(pdu.fields, :short_message, "") || ""

    payload =
      case List.keyfind(pdu.tlvs, :message_payload, 0) do
        {_, bytes} -> bytes
        nil -> nil
      end

    if short != "" and payload != nil,
      do: {:reject, :esme_rinvoptparamval, :short_message_and_payload, msg},
      else: parse_body(msg, pdu, payload || short, payload != nil)
  end

  defp parse_body(msg, pdu, raw, payload) do
    alphabet = Text.alphabet(msg.data_coding, msg.trunk.default_coding)

    case Concat.parse(raw, Map.get(msg.fields, :esm_class, 0), pdu.tlvs) do
      {:ok, udh, data, concat} ->
        decoded(msg, raw, udh, data, concat, alphabet, payload)

      {:error, :incomplete_sar} ->
        {:reject, :esme_rmissingoptparam, :incomplete_sar, msg}

      {:error, reason} ->
        {:reject, :esme_rinvmsglen, reason, msg}
    end
  end

  # D10: an empty message is refused (0x01) unless the customer trunk allows empty messages.
  defp decoded(%{trunk: trunk} = msg, _raw, _udh, <<>>, _concat, _alphabet, _payload)
       when trunk.allow_empty_messages != true,
       do: {:reject, :esme_rinvmsglen, :empty_message, msg}

  defp decoded(msg, _raw, udh, data, concat, alphabet, payload) do
    text =
      case Text.decode(data, alphabet) do
        {:ok, text} -> text
        :binary -> nil
      end

    parts = if concat, do: 1, else: max(1, Text.part_count(data, alphabet))

    {:ok,
     %{
       msg
       | udh: udh,
         body: data,
         text: text,
         alphabet: alphabet,
         concat: concat,
         parts: parts,
         payload: payload
     }}
  end

  # S-2.10: a receiver must be a number (an optional + then digits); a sender must be there, and an alphanumeric one
  # (TON 5) at most 11 characters.
  defp addresses(msg) do
    source = Map.get(msg.fields, :source_addr, "")
    dest = Map.get(msg.fields, :destination_addr, "")

    cond do
      not Regex.match?(~r/\A\+?[0-9]{1,20}\z/, dest) ->
        {:reject, :esme_rinvdstadr, :invalid_destination, msg}

      source == "" ->
        {:reject, :esme_rinvsrcadr, :no_source, msg}

      Map.get(msg.fields, :source_addr_ton) == 5 and String.length(source) > 11 ->
        {:reject, :esme_rinvsrcadr, :sender_too_long, msg}

      true ->
        {:ok, msg}
    end
  end

  # Ingress translation (§6.4, S-4.8).
  defp run_ingress(msg) do
    f = msg.fields

    result =
      Translation.run(
        Config.translation_rules(:customer, msg.trunk.id),
        %{
          sender: Map.get(f, :source_addr, ""),
          receiver: Map.get(f, :destination_addr, ""),
          text: msg.text || "",
          sender_ton: Map.get(f, :source_addr_ton),
          sender_npi: Map.get(f, :source_addr_npi)
        },
        Router.translation_context()
      )

    after_ = result.after
    fired = for s <- result.steps, s.fired, do: s.rule_id
    # Binary messages have no text to change.
    text_changed = msg.text != nil and after_.text != msg.text

    ingress = %{
      sender: after_.sender,
      # Routing and the destination use the digits of the translated receiver (as the Route Simulator).
      receiver: after_.receiver,
      route_receiver: digits(after_.receiver, Map.get(f, :destination_addr, "")),
      text: if(text_changed, do: after_.text, else: msg.text),
      text_changed: text_changed,
      sender_ton: after_.sender_ton,
      sender_npi: after_.sender_npi,
      dest_ton: after_.dest_ton,
      dest_npi: after_.dest_npi,
      registered_delivery: after_.registered_delivery,
      billing_type: after_.billing_type,
      fired: fired
    }

    msg = %{msg | ingress: ingress}

    if result.blocked,
      do: {:reject, :esme_rsubmitfail, :blocked_by_translation, msg},
      else: {:ok, msg}
  end

  defp digits(receiver, original) do
    case String.replace(receiver, ~r/\D/, "") do
      "" -> String.replace(original, ~r/\D/, "")
      d -> d
    end
  end

  # §6.5, §13.24, S-6.5 (product owner 2026-10-25): traffic with HLR is looked up before the resp, and is rated and
  # routed by the network the lookup names; without an answer, by the master table. A route rule's HLR action needs
  # the route first: it is decided on the master table's destination (without counting it) when a rule could ask.
  defp hlr(msg) do
    receiver = msg.ingress.route_receiver
    table = Config.destination(receiver)
    rule_id = if Hlr.actions_for?(msg.trunk.id), do: table_rule(msg, table)

    case Hlr.plan(msg.trunk.id, receiver, table, rule_id) do
      nil ->
        msg

      plan ->
        result = Hlr.lookup(plan, receiver, table)
        found = result && result.accomplished && Config.destination_of_mccmnc(result.mccmnc)
        msg |> Map.put(:hlr, result) |> Map.put(:hlr_destination, found || nil)
    end
  end

  defp table_rule(_msg, nil), do: nil

  defp table_rule(msg, table) do
    case Config.sell_rate(msg.trunk.id, table.mccmnc, msg.received_at, rate_sender(msg)) do
      nil ->
        nil

      sell ->
        case Router.route(router_input(%{msg | destination: table, sell: sell})) do
          {:ok, routed} -> routed.decision.rule_id
          {:error, _reason, decision} -> decision && decision.rule_id
        end
    end
  end

  # §6.1, §5.4, S-6.2: no destination or no rate for it → 0x0B.
  defp rate(msg) do
    case msg[:hlr_destination] || Config.destination(msg.ingress.route_receiver) do
      nil ->
        {:reject, :esme_rinvdstadr, :unknown_destination, msg}

      dest ->
        msg = %{msg | destination: dest}

        # A blocked customer line refuses the message like no rate (blocked means blocked, decided 2026-10-30).
        case Config.sell_price(msg.trunk.id, dest.mccmnc, msg.received_at, rate_sender(msg)) do
          nil -> {:reject, :esme_rinvdstadr, :no_customer_rate, msg}
          :blocked -> {:reject, :esme_rinvdstadr, :customer_rate_blocked, msg}
          sell -> {:ok, %{msg | sell: sell}}
        end
    end
  end

  # Test SMS or Repush to a chosen vendor trunk (backend step 11c): that vendor, whatever the route rules say.
  defp route_now(%{internal: %{vendor_trunk_id: vt}} = msg) when is_integer(vt) do
    case Router.forced(vt, router_input(msg)) do
      {:ok, routed} -> {:ok, %{msg | route: Map.put(route_of(routed), :measured_tps, 0.0)}}
      {:error, reason, _decision} -> {:reject, :esme_rsubmitfail, reason, msg}
    end
  end

  defp route_now(msg) do
    # Live TPS per scope (§13.8): this message counts before its own routing, against the rules too.
    input = msg |> router_input() |> Map.merge(%{count_rule_tps: true, parts: msg.parts})
    LiveTps.count(LiveTps.message_keys(msg), msg.parts)

    case Router.route(input) do
      {:ok, routed} ->
        route = route_of(routed)
        # The EDR records the customer trunk's TPS when it was routed (§13.8 Visibility).
        {:ok,
         %{msg | route: Map.put(route, :measured_tps, LiveTps.rate("ct:#{msg.trunk.id}", 5))}}

      {:error, reason, _decision} ->
        {:reject, :esme_rsubmitfail, reason, msg}
    end
  end

  @doc false
  # What the router needs, from a message after ingress translation.
  def router_input(msg) do
    %{
      customer_trunk: msg.trunk,
      sender: msg.ingress.sender,
      receiver: msg.ingress.route_receiver,
      text: msg.ingress.text || "",
      sender_ton: msg.ingress.sender_ton,
      sender_npi: msg.ingress.sender_npi,
      destination: msg.destination,
      sell: msg.sell,
      hlr_ported: msg[:hlr][:ported],
      now_ms: System.os_time(:millisecond)
    }
  end

  # Customer Sender ID rates (§6.2) match the sender as the customer sent it, the EDR's src_addr that Re-rating matches
  # too. A vendor's match the sender it receives (the router, after egress translation; EDR v_src_addr).
  defp rate_sender(msg), do: Map.get(msg.fields, :source_addr)

  @doc false
  # The parts of a routing result a message carries to the sender and its EDRs.
  def route_of(routed) do
    d = routed.decision
    after_ = routed.egress.after

    %{
      vendor_trunk_id: routed.vendor_trunk_id,
      rule_id: d.rule_id,
      route_type: d.route_type,
      level: d.vendor.level,
      decided_by: d.vendor.decided_by,
      cost: routed.cost,
      egress: %{
        sender: after_.sender,
        receiver: after_.receiver,
        text: after_.text,
        sender_ton: after_.sender_ton,
        sender_npi: after_.sender_npi,
        dest_ton: after_.dest_ton,
        dest_npi: after_.dest_npi,
        registered_delivery: after_.registered_delivery,
        fired: for(s <- routed.egress.steps, s.fired, do: s.rule_id)
      }
    }
  end

  # A Test SMS or Repush is not the customer's traffic and never charges it (backend step 11c).
  defp credit(%{internal: %{}}), do: :ok

  defp credit(msg) do
    case Credit.impl().check(msg) do
      :ok -> :ok
      {:error, status} -> {:reject, status, :credit, msg}
    end
  end

  # ---------------------------------------------------------------- stored, or refused

  # S-2.2: answered only once the bus has stored the message; if it cannot, 0x14 at once (S-2.3). A message accepted
  # over the trunk's TPS goes to the trunk's own overflow buffer, which releases it at the trunk's TPS (S-2.4,
  # `Sms.Switch.Pipeline.Buffers`); every other one straight to the sender.
  defp store(msg) do
    data = event_data(msg)

    # Queued until the sender takes it: what cancel_sm and query_sm see (S-2.15, D8). Without Redis the message still
    # goes; it just cannot be cancelled.
    ids = Map.get(msg, :ids, [msg.id])
    ent = msg.trunk.enterprise_id

    with {:error, reason} <- Store.mark_queued(ent, ids, @queued_s),
         do:
           Logger.warning(
             "message #{msg.id} not marked queued, cannot be cancelled: #{inspect(reason)}"
           )

    case publish(msg, data) do
      {:ok, _} ->
        :ok

      {:error, _} = error ->
        Store.drop_queued(ent, ids)
        error
    end
  end

  defp publish(%{buffered: true} = msg, data) do
    queue = Buffers.customer_queue(msg.trunk.id)

    with {:ok, _} = ok <- Bus.put(queue, "msg.buffered", data, id: "buffered:#{msg.id}") do
      Buffers.kick(queue)
      ok
    end
  end

  defp publish(msg, data),
    do: Bus.publish("sms.msg.accepted", "msg.accepted", data, id: "msg:#{msg.id}")

  @doc false
  # A message as the bus carries it (to the sender, or to an overflow buffer).
  @spec event_data(map()) :: map()
  def event_data(msg) do
    %{
      "id" => msg.id,
      "trunk_id" => msg.trunk.id,
      "m" => Base.encode64(:erlang.term_to_binary(msg, compressed: 1))
    }
  end

  defp refuse(msg, status, reason) do
    code = Status.code(status)
    Logger.info("message refused (#{inspect(reason)}): 0x#{Integer.to_string(code, 16)}")
    leave_buffer(msg)

    row =
      Edr.attempt_row(msg, %{
        edr_id: Edr.new_id(),
        no: 0,
        final: true,
        success: false,
        vendor: nil,
        command_status: code,
        msg_count: msg.parts
      })

    case Edr.publish_attempt(row) do
      :ok -> :ok
      {:error, error} -> Logger.error("EDR of refused message not stored: #{inspect(error)}")
    end

    {:error, status}
  end

  @doc false
  # The message carried on the bus, back to its map.
  @spec decode(map()) :: map()
  def decode(%{"m" => blob}), do: blob |> Base.decode64!() |> :erlang.binary_to_term([:safe])
end
