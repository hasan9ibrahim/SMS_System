defmodule Sms.Switch.Pipeline.Intake do
  @moduledoc """
  The message pipeline's front: a customer's `submit_sm` / `data_sm` from the moment it arrives to its
  `submit_sm_resp` (spec §2, §6, docs/BACKEND_PLAN.md §3.3). In memory, in this order:

    1. **checks**: the message body (short_message or message_payload, not both, S-2.8), the multipart header (UDH
       or SAR, S-3.6), an empty message (0x01, D10), the addresses and their TON / NPI (0x0A / 0x0B / 0x48–0x51,
       S-2.10), priority_flag, registered_delivery and esm_class, the scheduled time and validity period (0x61 /
       0x62, S-2.12, S-2.13);
    2. **ingress translation**: the customer trunk's translation rules in their order (§6.4, §13.2); a block refuses
       the message (0x45);
    3. **destination and rate**: the longest dial code of the receiver (§6.1) and the customer's rate (§5.4); none →
       0x0B (S-6.2);
    4. **routing**: the route rules and the egress-block skip (`Sms.Switch.Pipeline.Router`); no rule, a blocking rule
       or no vendor → 0x45 (decided Q15);
    5. **credit**: `Sms.Switch.Pipeline.Credit`: checked and the message's cost held in one step until it is
       charged or its outcome releases it (§7, S-6.3);
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
  import Bitwise, only: [band: 2]
  alias Sms.Core.Bus
  alias Sms.Switch.Customer.Intake.NotReady
  alias Sms.Switch.Customer.Trunk
  alias Sms.Switch.Message.{Address, Concat, Text}
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
    Scheduled,
    Store
  }

  alias Sms.Switch.Rules.Translation
  alias Sms.Switch.Smpp.{Pdu, Status}
  alias Sms.Switch.Smpp.Time, as: SmppTime
  alias Sms.Switch.Throttle

  # How long a queued mark lasts (a buffered message can wait for its TPS) and a cancelled one is remembered.
  @queued_s 86_400
  # How long a copy waits for the first message's decision, and how often it looks (D6).
  @pending_wait_ms 2_000
  @pending_poll_ms 25

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
         {:ok, msg} <- addresses(msg),
         {:ok, msg} <- times(msg) do
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
         {:ok, msg} <- rate(msg) do
      if scheduled?(msg), do: schedule(msg), else: send_now(msg)
    end
  end

  defp send_now(msg) do
    with {:ok, msg} <- route_now(msg),
         :ok <- credit(msg),
         do: stored_or_unreserved(msg)
  end

  # S-2.12 (decided 2026-10-31): a message scheduled ahead is checked as if it went now (a route, the credit without a
  # hold, its TPS not counted) and held until its time (`Sms.Switch.Pipeline.Scheduled`); rated, routed and its credit
  # held again when it goes (`release/1`). A Test SMS or Repush always goes at once.
  defp scheduled?(msg), do: Map.get(msg, :scheduled, false) and not is_map(msg[:internal])

  defp schedule(msg) do
    with {:ok, _route} <- route_check(msg),
         :ok <- credit_check(msg),
         do: Scheduled.hold(msg)
  end

  defp route_check(msg) do
    case Router.route(router_input(msg)) do
      {:ok, routed} -> {:ok, routed}
      {:error, reason, _decision} -> {:reject, :esme_rsubmitfail, reason, msg}
    end
  end

  defp credit_check(msg) do
    case Credit.impl().check(msg) do
      :ok -> :ok
      {:error, status} -> {:reject, status, :credit, msg}
    end
  end

  @doc false
  # S-2.12: a scheduled message at its time, as the sender takes it: rated, routed (its TPS counted) and its credit held
  # now, on the customer trunk as it is now (prices and routes valid when it goes). The ingress translation and HLR
  # answer stay those of its intake.
  @spec release(map()) :: {:ok, map()} | {:reject, atom(), term(), map()}
  def release(msg) do
    case Config.ready?() && Config.customer_trunk(msg.trunk.id) do
      %{} = trunk ->
        msg = msg |> Map.put(:trunk, trunk) |> Map.put(:rated_at, System.os_time(:millisecond))

        with {:ok, msg} <- rate(msg),
             {:ok, msg} <- route_now(msg),
             :ok <- credit(msg),
             do: {:ok, Map.put(msg, :credit_held, true)}

      _ ->
        {:reject, :esme_rsubmitfail, :unknown_trunk, msg}
    end
  end

  # A message the bus could not take was never accepted: its credit hold goes back at once (§7).
  defp stored_or_unreserved(msg) do
    with {:error, _} = error <- store(msg) do
      _ = if credit_held?(msg), do: Credit.impl().unreserve(msg)
      error
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

      :undecided ->
        Logger.info("copy of a message still being decided on trunk #{msg.trunk.id}: 0x58 (D6)")
        unread(msg, :esme_rthrottled)

      {:error, reason} ->
        Logger.error("duplicate filter unavailable, message taken: #{inspect(reason)}")
        go(kind, msg, nil)
    end
  end

  # A part is answered once held; one not held gives its fingerprint back, so its resend is held.
  defp go(:part, msg, fingerprint) do
    case Reassembly.hold(msg) do
      {:ok, _, _} = ok ->
        confirm_fingerprint(msg, fingerprint)
        ok

      error ->
        forget_fingerprint(msg, fingerprint)
        error
    end
  end

  defp go(:ok, msg, fingerprint) do
    reply =
      if Delayed.delayed?(msg),
        do: delayed(msg, fingerprint),
        else: answer(msg, stored(msg, fingerprint))

    case reply do
      {:ok, _, _} = ok ->
        ok

      error ->
        forget_fingerprint(msg, fingerprint)
        error
    end
  end

  # Decided and stored: from now on its copies get its id (D6).
  defp stored(msg, fingerprint) do
    with :ok <- process(msg), do: confirm_fingerprint(msg, fingerprint)
  end

  # S-2.18, D11: stored as usual, then the resp waits for the vendor's outcome.
  defp delayed(msg, fingerprint) do
    :ok = Delayed.join(msg.id)

    case stored(msg, fingerprint) do
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

  # Only a trunk with a duplicate window claimed the fingerprint.
  defp confirm_fingerprint(_msg, nil), do: :ok

  defp confirm_fingerprint(msg, fingerprint) do
    _ =
      case msg.trunk[:duplicate_window_s] || 0 do
        0 -> :ok
        window -> Store.confirm_fingerprint(msg.trunk.id, fingerprint, msg.id, window)
      end

    :ok
  end

  defp duplicate(msg, fingerprint) do
    case msg.trunk[:duplicate_window_s] || 0 do
      0 -> :new
      window -> claim(msg, fingerprint, window, now_ms() + @pending_wait_ms)
    end
  end

  # D6: a copy that comes while the first is still being decided (rated, routed, its credit or HLR checked) waits for
  # the decision: the first's id once it was taken, a new message if it was refused. Still undecided after
  # `@pending_wait_ms`: 0x58, and the client sends it again later.
  defp claim(msg, fingerprint, window, deadline) do
    case Store.claim_fingerprint(msg.trunk.id, fingerprint, msg.id, window) do
      {:pending, _first} ->
        if now_ms() < deadline do
          Process.sleep(@pending_poll_ms)
          claim(msg, fingerprint, window, deadline)
        else
          :undecided
        end

      other ->
        other
    end
  end

  defp now_ms, do: System.monotonic_time(:millisecond)

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

    # A single message's other UDH elements (ports, a language shift table) go with it and take room (D9).
    parts =
      if concat,
        do: 1,
        else: max(1, Text.part_count(data, alphabet, byte_size(Concat.other_elements(udh))))

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

  # S-2.10: a receiver must be a number (an optional + then digits) with a TON and NPI SMPP defines; a sender must be
  # there, with a TON and NPI SMPP defines, a numeric one at most 20 digits and an alphanumeric one (or TON 5) at most
  # 11 characters (`Sms.Switch.Message.Address`). Then the flags (`flags/1`).
  defp addresses(msg) do
    f = msg.fields
    dest = Map.get(f, :destination_addr, "")

    cond do
      not Regex.match?(~r/\A\+?[0-9]{1,20}\z/, dest) ->
        {:reject, :esme_rinvdstadr, :invalid_destination, msg}

      not Address.ton?(f[:dest_addr_ton] || 0) ->
        {:reject, :esme_rinvdstton, :invalid_destination_ton, msg}

      not Address.npi?(f[:dest_addr_npi] || 0) ->
        {:reject, :esme_rinvdstnpi, :invalid_destination_npi, msg}

      status = Address.source_problem(f[:source_addr], f[:source_addr_ton], f[:source_addr_npi]) ->
        {:reject, status, :invalid_source, msg}

      true ->
        flags(msg)
    end
  end

  # SMPP 3.4 §5.2.12–§5.2.17: priority_flag 0–3; registered_delivery without its reserved bits (7–5) or the reserved
  # receipt value 3; esm_class with a message type a submit can have (default, delivery or manual / user
  # acknowledgement; the mode bits and UDHI / reply path are free).
  defp flags(msg) do
    f = msg.fields

    cond do
      (f[:priority_flag] || 0) > 3 ->
        {:reject, :esme_rinvprtflg, :invalid_priority_flag, msg}

      band(f[:registered_delivery] || 0, 0xE0) != 0 or
          band(f[:registered_delivery] || 0, 0x03) == 3 ->
        {:reject, :esme_rinvregdlvflg, :invalid_registered_delivery, msg}

      band(Map.get(f, :esm_class, 0), 0x3C) not in [0x00, 0x08, 0x10] ->
        {:reject, :esme_rinvesmclass, :invalid_esm_class, msg}

      true ->
        {:ok, msg}
    end
  end

  # S-2.12, S-2.13: the scheduled time and the end of the validity period as moments (`Sms.Switch.Smpp.Time`); a field
  # that does not read is refused (0x61, 0x62), as is a schedule more than `:max_schedule_s` ahead (0x61, 7 days) and a
  # validity period that ends before the message could go. A time still ahead holds the message (`scheduled`).
  defp times(msg) do
    f = msg.fields

    with {:sched, {:ok, scheduled}} <-
           {:sched, SmppTime.parse(f[:schedule_delivery_time], msg.received_at)},
         {:sched, true} <-
           {:sched, scheduled == nil or scheduled - msg.received_at <= Scheduled.max_ahead_ms()},
         {:expiry, {:ok, expires}} <-
           {:expiry, SmppTime.parse(f[:validity_period], msg.received_at)},
         {:expiry, true} <-
           {:expiry, expires == nil or expires > max(scheduled || 0, msg.received_at)} do
      held = is_integer(scheduled) and scheduled > msg.received_at
      {:ok, Map.merge(msg, %{scheduled_at: scheduled, expires_at: expires, scheduled: held})}
    else
      {:sched, _} -> {:reject, :esme_rinvsched, :invalid_schedule_delivery_time, msg}
      {:expiry, _} -> {:reject, :esme_rinvexpiry, :invalid_validity_period, msg}
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

    cond do
      result.blocked ->
        {:reject, :esme_rsubmitfail, :blocked_by_translation, msg}

      # S-4.7: a translation that leaves the sender unfit to send (too long, a TON or NPI SMPP does not define) fails
      # the message here, never at the vendor. (No trunk setting asks for TON / NPI to be fixed automatically yet.)
      status = Address.source_problem(ingress.sender, ingress.sender_ton, ingress.sender_npi) ->
        {:reject, status, :invalid_sender_after_translation, msg}

      true ->
        {:ok, msg}
    end
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
        case Config.sell_price(msg.trunk.id, dest.mccmnc, rated_at(msg), rate_sender(msg)) do
          nil -> {:reject, :esme_rinvdstadr, :no_customer_rate, msg}
          :blocked -> {:reject, :esme_rinvdstadr, :customer_rate_blocked, msg}
          sell -> {:ok, %{msg | sell: sell}}
        end
    end
  end

  # The rates in force when the message was received (S-6.1), or when a scheduled one is released (S-2.12).
  defp rated_at(msg), do: Map.get(msg, :rated_at, msg.received_at)

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
    f = msg.fields

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
      now_ms: System.os_time(:millisecond),
      # What a vendor's capability filter and Deny Multipart look at (§5.5, §6.3, S-3.9, S-4.4).
      parts: msg.parts,
      message: Map.take(msg, [:body, :alphabet, :data_coding, :text]),
      dest_ton: first_set([msg.ingress[:dest_ton], f[:dest_addr_ton]]),
      dest_npi: first_set([msg.ingress[:dest_npi], f[:dest_addr_npi]])
    }
  end

  defp first_set(values), do: Enum.find(values, &(&1 != nil))

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

  # The check and the hold of the message's cost in one step (§7, S-6.3, decision 2026-10-31). A Test SMS or Repush is
  # not the customer's traffic and never charges it (backend step 11c).
  defp credit(msg) do
    if credit_held?(msg) do
      case Credit.impl().reserve(msg) do
        :ok -> :ok
        {:error, status} -> {:reject, status, :credit, msg}
      end
    else
      :ok
    end
  end

  defp credit_held?(msg), do: not is_map(msg[:internal])

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
