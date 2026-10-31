defmodule Sms.Switch.Customer.Session do
  @moduledoc """
  One customer SMPP connection, from accept to close (spec §2, §13.1, docs/SMPP_SCENARIOS.md §1). The switch is
  the SMSC here. One process per TCP connection, started by the listener (`Sms.Switch.Customer.Listener`).

  ## Lifecycle

    * **open**: only a bind is accepted, within `:bind_timeout_ms`. Every other request is answered 0x04
      (incorrect bind status, S-1.11), `enquire_link` excepted.
    * **bind** checks, in this order (S-1.1–S-1.3, S-1.17): IP not banned by the Firewall (§8), known
      `system_id` (0x0F), client IP allowed (0x0D), password (0x0E), trunk active (0x0D), a TLS trunk on a TLS
      connection at its version or newer (0x0D), `system_type` when the trunk sets one (0x53), bind type
      allowed (0x0D), fewer than Max Connections across every server (0x0D). A refused bind is answered, audited
      and the connection is closed; no session exists. A second bind on a bound session gets 0x05.
    * **bound**: message requests go to `Sms.Switch.Customer.Intake`, each in its own process; the answer goes back
      on this connection with the request's sequence number and never anywhere else (§13.1 rule 1).
    * **unbind** from the client: the answers already being decided are sent first, then `unbind_resp` (S-1.7).
      An `unbind` from us (trunk deactivated, deleted or changed, node stopping) waits briefly for `unbind_resp`.

  ## Flow control

    * At most `:inbound_window` requests are processed at once; past that the session stops reading the socket,
      so TCP pushes back on the client instead of the switch buffering without limit (S-1.18).
    * `submit_sm` and `data_sm` count against the trunk's and the company's TPS (`Sms.Switch.Throttle`);
      over the limit they get 0x58 (S-2.4). While the node drains, they get 0x58 too (S-1.16).
    * Our own requests to the client (`deliver_sm` receipts, `enquire_link`) use sequence numbers 1–0x7FFFFFFF,
      wrapping and never reusing one still waiting (S-1.14). At most `:outbound_window` `deliver_sm` wait for their
      response; a full window answers `{:error, :window_full}` at once and the caller keeps the receipt (never this
      process's memory). After a `deliver_sm` the client did not answer in time, the session takes no new one for
      `:deliver_timeout_ms` (`{:error, :slow}`) unless the client answers one meanwhile, so a slow reader never
      keeps the switch's receipt workers waiting (S-1.18, S-5.14).

  ## Keep-alive

  After `:enquire_link_interval_ms` without any PDU from the client, the session sends `enquire_link`. If nothing
  at all arrives within `:enquire_link_timeout_ms` after it, the client is gone (S-1.5, also a half-open TCP
  connection, S-1.6) and the session closes. TCP keepalive is on as a second net.
  """
  use GenServer
  require Logger
  alias Sms.Switch.Customer
  alias Sms.Switch.Customer.{Events, Firewall, Intake, Sessions, Trunk, TrunkStore}
  alias Sms.Switch.Smpp.{Command, Pdu}
  alias Sms.Switch.Throttle

  @task_supervisor Sms.Switch.Customer.Tasks
  @max_sequence 0x7FFFFFFF
  @binds %{bind_transmitter: :tx, bind_receiver: :rx, bind_transceiver: :trx}
  @message_requests [:submit_sm, :data_sm, :query_sm, :cancel_sm]
  @counted [:submit_sm, :data_sm]
  # SMPP 3.4 optional features the switch declines (decision D8): answered with 0x03 (invalid command).
  @unsupported [:replace_sm, :submit_multi]
  # Requests only an SMSC sends; a client sending them gets 0x03.
  @not_from_client [:deliver_sm, :outbind, :alert_notification]
  @park_ms 1_000
  @our_responses [:enquire_link_resp, :deliver_sm_resp, :unbind_resp, :generic_nack]

  @defaults [
    system_id: "SMSC",
    bind_timeout_ms: 30_000,
    enquire_link_interval_ms: 30_000,
    enquire_link_timeout_ms: 10_000,
    tick_ms: 1_000,
    inbound_window: 100,
    outbound_window: 10,
    deliver_timeout_ms: 30_000,
    intake_timeout_ms: 120_000,
    # A Delayed Submit trunk's resp waits for the vendor (S-2.18, D11): the pipeline answers within its own 10 minutes.
    delayed_intake_timeout_ms: 660_000,
    unbind_timeout_ms: 5_000,
    max_pdu_length: 66_000,
    proxy_header_timeout_ms: 5_000
  ]

  defstruct [
    :ref,
    :transport,
    :socket,
    :tags,
    :id,
    :ip,
    :port,
    :local_port,
    :tls,
    :settings,
    :intake,
    :trunk,
    :bind,
    :interface_version,
    :bound_at,
    :bind_timer,
    :unbind_request,
    :unbind_timer,
    :enquire,
    :stop_reason,
    :slow_until,
    phase: :open,
    buffer: <<>>,
    armed: false,
    inflight: %{},
    parked: [],
    out: %{},
    next_seq: 1,
    last_rx: 0
  ]

  @doc "The settings with their defaults (`config :sms_switch, Sms.Switch.Customer, session: [...]`)."
  @spec settings(keyword()) :: map()
  def settings(overrides \\ []) do
    configured = :sms_switch |> Application.get_env(Customer, []) |> Keyword.get(:session, [])
    @defaults |> Keyword.merge(configured) |> Keyword.merge(overrides) |> Map.new()
  end

  @doc """
  Sends a `deliver_sm` (a receipt or MO) to the client on this session and waits for its response:
  `{:ok, %{status: code, message_id: id}}` (a non-zero status is the client refusing it), or `{:error, reason}`:
  `:window_full`, `:slow` (it did not answer the last one in time), `:not_receiver` (a TX bind), `:closed` (try
  another session or hold), `:timeout` (the client may have it; retry on this session, S-5.14), `{:invalid_pdu,
  reason}`.
  """
  @spec deliver(pid(), map(), list()) :: {:ok, map()} | {:error, term()}
  def deliver(pid, fields, tlvs \\ []) do
    GenServer.call(pid, {:deliver, fields, tlvs}, settings().deliver_timeout_ms + 5_000)
  catch
    :exit, _ -> {:error, :closed}
  end

  @doc "Unbinds the session from our side (it waits briefly for the client's `unbind_resp`, then closes)."
  @spec stop(pid(), term()) :: :ok
  def stop(pid, reason) do
    send(pid, {:unbind_ours, reason})
    :ok
  end

  @doc "The session's details: phase, bind, client, in-flight counts."
  @spec info(pid()) :: map()
  def info(pid), do: GenServer.call(pid, :info)

  # ---------------------------------------------------------------- ranch

  @doc false
  def start_link(ref, transport, opts) do
    {:ok, :proc_lib.spawn_link(__MODULE__, :connection_init, [ref, transport, opts])}
  end

  @doc false
  def connection_init(ref, transport, opts) do
    case setup(ref, transport, opts) do
      {:ok, state} -> :gen_server.enter_loop(__MODULE__, [], state)
      # The TLS handshake or the PROXY header failed, or the client left before we started: nothing to clean up.
      {:error, reason} -> Logger.info("customer connection not started: #{inspect(reason)}")
    end
  end

  defp setup(ref, transport, opts) do
    settings = settings(Keyword.get(opts, :session, []))
    proxy = if Keyword.get(opts, :proxy_protocol, false), do: proxy_peer(ref, settings), else: nil
    {:ok, socket} = :ranch.handshake(ref)
    Process.flag(:trap_exit, true)
    {:ok, {peer_ip, peer_port}} = transport.peername(socket)
    {:ok, {_, local_port}} = transport.sockname(socket)
    {ip, port, local_port} = proxy || {peer_ip, peer_port, local_port}

    state = %__MODULE__{
      ref: ref,
      transport: transport,
      socket: socket,
      tags: transport.messages(),
      id: new_id(),
      ip: Customer.IpRange.unmap(ip),
      port: port,
      local_port: local_port,
      tls: negotiated_tls(transport, socket),
      settings: settings,
      intake: Keyword.get(opts, :intake, Intake.impl()),
      last_rx: now()
    }

    Logger.metadata(session_id: state.id, peer: "#{:inet.ntoa(state.ip)}:#{state.port}")

    state =
      %{state | bind_timer: Process.send_after(self(), :bind_timeout, settings.bind_timeout_ms)}
      |> arm()

    Process.send_after(self(), :tick, settings.tick_ms)
    {:ok, state}
  catch
    kind, reason -> {:error, {kind, reason}}
  end

  # S-1.15, §13.1 rule 7: behind a load balancer the real client address, and the port it connected to, come from
  # the PROXY header.
  defp proxy_peer(ref, settings) do
    case :ranch.recv_proxy_header(ref, settings.proxy_header_timeout_ms) do
      {:ok, %{command: :proxy, src_address: ip, src_port: port, dest_port: local}} ->
        {ip, port, local}

      {:ok, %{command: :local}} ->
        nil

      {:ok, header} ->
        throw({:proxy_header_unusable, header})

      {:error, reason} ->
        throw({:proxy_header, reason})
    end
  end

  defp negotiated_tls(:ranch_ssl, socket) do
    case :ssl.connection_information(socket, [:protocol]) do
      {:ok, [protocol: version]} -> version
      _ -> throw(:tls_version_unknown)
    end
  end

  defp negotiated_tls(_transport, _socket), do: nil

  @impl true
  def init(_args), do: {:stop, :started_by_ranch_only}

  # ---------------------------------------------------------------- socket

  @impl true
  def handle_info({tag, socket, data}, %{socket: socket, tags: {tag, _, _, _}} = state) do
    state = %{state | buffer: state.buffer <> data, armed: false, last_rx: now()}
    state |> process_buffer() |> continue()
  end

  def handle_info({tag, socket}, %{socket: socket, tags: {_, tag, _, _}} = state),
    do: {:stop, {:shutdown, :closed_by_client}, state}

  def handle_info({tag, socket, reason}, %{socket: socket, tags: {_, _, tag, _}} = state),
    do: {:stop, {:shutdown, {:socket_error, reason}}, state}

  # ---------------------------------------------------------------- intake answers

  def handle_info({ref, reply}, state)
      when is_reference(ref) and is_map_key(state.inflight, ref) do
    Process.demonitor(ref, [:flush])
    {entry, inflight} = Map.pop!(state.inflight, ref)
    _ = Process.cancel_timer(entry.timer)
    state = answer(%{state | inflight: inflight}, entry.pdu, reply)
    state |> unpark(ref) |> after_inflight() |> continue()
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state)
      when is_map_key(state.inflight, ref) do
    {entry, inflight} = Map.pop!(state.inflight, ref)
    _ = Process.cancel_timer(entry.timer)

    Logger.error(
      "intake crashed on #{entry.pdu.command} #{entry.pdu.sequence}: #{inspect(reason)}"
    )

    state = send_pdu(%{state | inflight: inflight}, Pdu.response(entry.pdu, :esme_rsyserr))
    state |> unpark(ref) |> after_inflight() |> continue()
  end

  def handle_info({:intake_timeout, ref}, state) when is_map_key(state.inflight, ref) do
    Process.demonitor(ref, [:flush])
    {entry, inflight} = Map.pop!(state.inflight, ref)

    Logger.error(
      "intake gave no answer to #{entry.pdu.command} #{entry.pdu.sequence} within #{state.settings.intake_timeout_ms} ms"
    )

    state = send_pdu(%{state | inflight: inflight}, Pdu.response(entry.pdu, :esme_rsyserr))
    state |> unpark(ref) |> after_inflight() |> continue()
  end

  def handle_info(:release_parked, state) do
    oldest = System.monotonic_time(:millisecond) - @park_ms
    {:noreply, release(state, &(&1.at <= oldest))}
  end

  # A late answer to a request already answered 0x08 after the intake timeout.
  def handle_info({ref, _late}, state) when is_reference(ref), do: {:noreply, state}
  def handle_info({:intake_timeout, _ref}, state), do: {:noreply, state}

  # ---------------------------------------------------------------- timers

  def handle_info(:bind_timeout, %{phase: :open} = state) do
    Logger.info("no bind within #{state.settings.bind_timeout_ms} ms; closing")
    {:stop, {:shutdown, :bind_timeout}, state}
  end

  def handle_info(:bind_timeout, state), do: {:noreply, state}

  def handle_info(:tick, state) do
    Process.send_after(self(), :tick, state.settings.tick_ms)
    keepalive(state)
  end

  def handle_info({:out_timeout, seq}, state) do
    case Map.pop(state.out, seq) do
      {nil, _} ->
        {:noreply, state}

      {entry, out} ->
        if entry.from, do: GenServer.reply(entry.from, {:error, :timeout})
        state = %{state | out: out}

        case entry.command do
          :unbind ->
            {:stop, {:shutdown, state.unbind_request || :unbind_timeout}, state}

          # A slow reader: no new receipt for a while (S-1.18).
          :deliver_sm ->
            {:noreply, %{state | slow_until: now() + state.settings.deliver_timeout_ms}}

          _ ->
            {:noreply, state}
        end
    end
  end

  def handle_info(:unbind_timeout, %{phase: :unbinding, unbind_request: %Pdu{} = req} = state) do
    Logger.warning(
      "unbind: #{map_size(state.inflight)} answers still pending after the timeout; unbinding anyway"
    )

    state = send_pdu(state, Pdu.response(req))
    {:stop, {:shutdown, :unbind}, state}
  end

  def handle_info(:unbind_timeout, state), do: {:noreply, state}

  # ---------------------------------------------------------------- trunk changes and our unbind

  def handle_info(:revalidate, %{phase: :bound} = state) do
    case revalidate(state) do
      {:ok, trunk} -> {:noreply, %{state | trunk: trunk}}
      {:drop, reason} -> unbind_ours(state, reason)
    end
  end

  def handle_info(:revalidate, state), do: {:noreply, state}

  def handle_info({:unbind_ours, reason}, %{phase: :bound} = state),
    do: unbind_ours(state, reason)

  def handle_info({:unbind_ours, reason}, %{phase: :open} = state),
    do: {:stop, {:shutdown, reason}, state}

  def handle_info({:unbind_ours, _reason}, state), do: {:noreply, state}

  # The socket's port (linked to its owner) closing normally; the socket message says why.
  def handle_info({:EXIT, _port_or_pid, :normal}, state), do: {:noreply, state}
  def handle_info({:EXIT, _pid, reason}, state), do: {:stop, reason, state}

  def handle_info(msg, state) do
    Logger.debug("customer session ignored #{inspect(msg)}")
    {:noreply, state}
  end

  @impl true
  # A receipt waits for the requests in flight when it came (one of them may be its own submit): the client always
  # gets the submit_sm_resp before the receipt of that message (SMPP 3.4 §4.4, S-5.5).
  # It never waits longer than @park_ms (a slow intake does not hold receipts back).
  def handle_call({:deliver, fields, tlvs}, from, state)
      when state.phase == :bound and state.bind != :tx and map_size(state.inflight) > 0 do
    waits = MapSet.new(Map.keys(state.inflight))

    entry = %{
      waits: waits,
      fields: fields,
      tlvs: tlvs,
      from: from,
      at: System.monotonic_time(:millisecond)
    }

    Process.send_after(self(), :release_parked, @park_ms)
    {:noreply, %{state | parked: state.parked ++ [entry]}}
  end

  def handle_call({:deliver, fields, tlvs}, from, state),
    do: deliver_now(state, fields, tlvs, from)

  def handle_call(:info, _from, state) do
    info = %{
      id: state.id,
      phase: state.phase,
      bind: state.bind,
      trunk_id: state.trunk && state.trunk.id,
      ip: state.ip,
      port: state.port,
      local_port: state.local_port,
      tls: state.tls,
      bound_at: state.bound_at,
      inflight: map_size(state.inflight),
      deliver_pending: Enum.count(state.out, fn {_, e} -> e.command == :deliver_sm end)
    }

    {:reply, info, state}
  end

  @impl true
  def terminate(reason, state) do
    for {_seq, %{from: from}} <- state.out,
        from != nil,
        do: GenServer.reply(from, {:error, :closed})

    for %{from: from} <- state.parked, do: GenServer.reply(from, {:error, :closed})

    if state.phase == :bound and node_stopping?(reason), do: unbind_on_shutdown(state)

    if state.trunk do
      Logger.info("customer session closed: #{inspect(reason)}")

      Events.publish(:closed, %{
        session_id: state.id,
        trunk_id: state.trunk.id,
        ip: ip_text(state.ip),
        port: state.port,
        bind: state.bind,
        node: node(),
        reason: inspect(reason),
        inflight: map_size(state.inflight)
      })
    end

    state.transport.close(state.socket)
  end

  defp node_stopping?(:shutdown), do: true
  defp node_stopping?(_), do: false

  # The node is stopping: tell the client, and give it a moment to answer, so it reconnects to the other server.
  defp unbind_on_shutdown(state) do
    {seq, state} = next_sequence(state)
    write(state, Pdu.encode!(Pdu.new(:unbind, %{}, sequence: seq)))
    _ = state.transport.setopts(state.socket, active: false)
    deadline = now() + min(state.settings.unbind_timeout_ms, 2_000)
    await_unbind_resp(state, seq, state.buffer, deadline)
  catch
    _, _ -> :ok
  end

  defp await_unbind_resp(state, seq, buffer, deadline) do
    case Pdu.decode(buffer) do
      {:ok, %Pdu{command: :unbind_resp, sequence: ^seq}, _rest} ->
        :ok

      {:ok, _other, rest} ->
        await_unbind_resp(state, seq, rest, deadline)

      {:incomplete, _} ->
        case state.transport.recv(state.socket, 0, max(deadline - now(), 0)) do
          {:ok, data} -> await_unbind_resp(state, seq, buffer <> data, deadline)
          {:error, _} -> :ok
        end

      {:error, _error, _rest} ->
        :ok
    end
  end

  # ---------------------------------------------------------------- framing

  # Decodes and handles complete PDUs while the window has room (S-1.8: strictly by command_length).
  defp process_buffer(%{stop_reason: reason} = state) when reason != nil, do: state

  defp process_buffer(state) do
    if map_size(state.inflight) >= state.settings.inbound_window do
      state
    else
      state.buffer
      |> Pdu.decode(max_length: state.settings.max_pdu_length)
      |> decoded(state)
    end
  end

  defp decoded({:ok, pdu, rest}, state),
    do: %{state | buffer: rest} |> handle_pdu(pdu) |> process_buffer()

  defp decoded({:incomplete, _}, state), do: state

  defp decoded({:error, error, rest}, state) do
    Logger.warning("bad PDU from client: #{Exception.message(error)}")
    state = %{state | buffer: rest}
    state = if reply = Pdu.error_reply(error), do: send_pdu(state, reply), else: state

    # S-1.9: the stream can no longer be framed.
    if error.fatal,
      do: %{state | stop_reason: :invalid_command_length, buffer: <<>>},
      else: process_buffer(state)
  end

  defp continue(%{stop_reason: nil} = state), do: {:noreply, arm(state)}
  defp continue(%{stop_reason: reason} = state), do: {:stop, {:shutdown, reason}, state}

  defp arm(%{armed: true} = state), do: state

  defp arm(state) do
    if map_size(state.inflight) < state.settings.inbound_window do
      case state.transport.setopts(state.socket, active: :once) do
        :ok -> %{state | armed: true}
        {:error, reason} -> exit({:shutdown, {:socket_error, reason}})
      end
    else
      state
    end
  end

  # ---------------------------------------------------------------- PDUs

  defp handle_pdu(state, %Pdu{command: :enquire_link} = pdu),
    do: send_pdu(state, Pdu.response(pdu))

  defp handle_pdu(state, %Pdu{command: command} = pdu) when command in @our_responses,
    do: handle_response(state, pdu)

  defp handle_pdu(state, %Pdu{command: command} = pdu) when is_map_key(@binds, command),
    do: handle_bind(state, pdu, Map.fetch!(@binds, command))

  defp handle_pdu(state, %Pdu{command: :unbind} = pdu), do: handle_unbind(state, pdu)

  defp handle_pdu(state, %Pdu{command: command} = pdu) when command in @message_requests,
    do: handle_request(state, pdu)

  defp handle_pdu(%{phase: :bound} = state, %Pdu{command: command} = pdu)
       when command in @unsupported,
       do: send_pdu(state, Pdu.response(pdu, :esme_rinvcmdid))

  defp handle_pdu(state, %Pdu{command: command} = pdu) when command in @unsupported,
    do: send_pdu(state, Pdu.response(pdu, :esme_rinvbndsts))

  defp handle_pdu(state, %Pdu{command: command} = pdu) when command in @not_from_client do
    reply =
      if Command.response(command),
        do: Pdu.response(pdu, :esme_rinvcmdid),
        else: Pdu.generic_nack(pdu.sequence, :esme_rinvcmdid)

    send_pdu(state, reply)
  end

  # Any other response (bind_resp, submit_sm_resp…) answers nothing we sent.
  defp handle_pdu(state, %Pdu{} = pdu) do
    Logger.warning("unexpected #{pdu.command} #{pdu.sequence} from client; ignored")
    state
  end

  # ---------------------------------------------------------------- bind

  defp handle_bind(%{phase: :open} = state, pdu, kind) do
    case check_bind(state, pdu.fields, kind) do
      {:ok, trunk} -> bound(state, pdu, kind, trunk)
      {:error, status, reason, trunk} -> refuse_bind(state, pdu, status, reason, trunk)
    end
  end

  defp handle_bind(state, pdu, _kind), do: send_pdu(state, Pdu.response(pdu, :esme_ralybnd))

  defp check_bind(state, fields, kind) do
    system_id = fields.system_id

    with :ok <- check(not Firewall.blocked?(state.ip), :esme_rbindfail, :ip_banned, nil),
         :ok <- check(TrunkStore.ready?(), :esme_rsyserr, :trunks_not_loaded, nil),
         {:ok, trunk} <- lookup(system_id),
         :ok <- check(Trunk.ip_allowed?(trunk, state.ip), :esme_rbindfail, :ip_not_allowed, trunk),
         :ok <-
           check(
             Trunk.password_ok?(trunk, fields.password),
             :esme_rinvpaswd,
             :invalid_password,
             trunk
           ),
         :ok <- check(trunk.status == :active, :esme_rbindfail, :trunk_inactive, trunk),
         :ok <-
           check(
             Trunk.transport_allowed?(trunk, state.tls),
             :esme_rbindfail,
             :tls_required,
             trunk
           ),
         :ok <-
           check(
             system_type_ok?(trunk, fields.system_type),
             :esme_rinvsystyp,
             :system_type_mismatch,
             trunk
           ),
         :ok <-
           check(Trunk.bind_allowed?(trunk, kind), :esme_rbindfail, :bind_type_not_allowed, trunk),
         :ok <- check(not Customer.draining?(), :esme_rbindfail, :node_draining, trunk) do
      register(state, trunk, kind)
    end
  end

  defp check(true, _status, _reason, _trunk), do: :ok
  defp check(false, status, reason, trunk), do: {:error, status, reason, trunk}

  defp lookup(system_id) do
    case TrunkStore.lookup(system_id) do
      {:ok, trunk} -> {:ok, trunk}
      :error -> {:error, :esme_rinvsysid, :unknown_system_id, nil}
    end
  end

  defp system_type_ok?(%Trunk{system_type: nil}, _given), do: true
  defp system_type_ok?(%Trunk{system_type: expected}, given), do: expected == given

  defp register(state, trunk, kind) do
    meta = %{
      id: state.id,
      trunk_id: trunk.id,
      system_id: trunk.username,
      ip: state.ip,
      port: state.port,
      bind: kind,
      node: node(),
      bound_at: DateTime.utc_now(),
      tls: state.tls
    }

    case Sessions.register(trunk, meta) do
      :ok -> {:ok, trunk}
      {:error, :max_connections} -> {:error, :esme_rbindfail, :max_connections, trunk}
      {:error, :lock_failed} -> {:error, :esme_rsyserr, :lock_failed, trunk}
    end
  end

  defp bound(state, pdu, kind, trunk) do
    Firewall.success(state.ip)
    _ = Process.cancel_timer(state.bind_timer)
    version = pdu.fields.interface_version
    # S-1.4: sc_interface_version only to a client that speaks 3.4 (TLVs did not exist before).
    tlvs = if version >= 0x34, do: [sc_interface_version: 0x34], else: []

    state =
      send_pdu(state, Pdu.response(pdu, :esme_rok, %{system_id: state.settings.system_id}, tlvs))

    Logger.metadata(trunk_id: trunk.id)

    Logger.info(
      "customer bound: #{kind} trunk #{trunk.id} (#{trunk.username}), interface 0x#{Integer.to_string(version, 16)}"
    )

    Events.publish(:bound, %{
      session_id: state.id,
      trunk_id: trunk.id,
      system_id: trunk.username,
      ip: ip_text(state.ip),
      port: state.port,
      local_port: state.local_port,
      bind: kind,
      tls: state.tls,
      interface_version: version,
      node: node()
    })

    %{
      state
      | phase: :bound,
        trunk: trunk,
        bind: kind,
        interface_version: version,
        bound_at: DateTime.utc_now()
    }
  end

  @counted_failures [:unknown_system_id, :ip_not_allowed, :invalid_password]

  defp refuse_bind(state, pdu, status, reason, trunk) do
    # Counted by the Firewall filters (spec §8), which ban the IP past their threshold.
    if reason in @counted_failures, do: Firewall.failure(state.ip)

    Logger.warning("bind refused (#{reason}) for system_id #{inspect(pdu.fields.system_id)}")

    Events.publish(:bind_failed, %{
      system_id: pdu.fields.system_id,
      trunk_id: trunk && trunk.id,
      ip: ip_text(state.ip),
      port: state.port,
      local_port: state.local_port,
      bind: Map.fetch!(@binds, pdu.command),
      reason: reason,
      status: status,
      node: node()
    })

    state = send_pdu(state, Pdu.response(pdu, status))
    # No session for a refused bind (S-1.1): the connection closes once the answer is written.
    %{state | stop_reason: {:bind_refused, reason}}
  end

  # ---------------------------------------------------------------- unbind

  defp handle_unbind(%{phase: :bound} = state, pdu) do
    state = %{state | phase: :unbinding, unbind_request: pdu}

    if map_size(state.inflight) == 0 do
      finish_unbind(state)
    else
      %{
        state
        | unbind_timer:
            Process.send_after(self(), :unbind_timeout, state.settings.unbind_timeout_ms)
      }
    end
  end

  defp handle_unbind(%{phase: :open} = state, pdu),
    do: %{send_pdu(state, Pdu.response(pdu)) | stop_reason: :unbind}

  defp handle_unbind(state, pdu), do: send_pdu(state, Pdu.response(pdu, :esme_rinvbndsts))

  defp finish_unbind(state) do
    _ = if state.unbind_timer, do: Process.cancel_timer(state.unbind_timer)
    %{send_pdu(state, Pdu.response(state.unbind_request)) | stop_reason: :unbind}
  end

  defp after_inflight(%{phase: :unbinding, inflight: inflight} = state)
       when map_size(inflight) == 0,
       do: finish_unbind(state)

  defp after_inflight(state), do: process_buffer(state)

  defp unbind_ours(state, reason) do
    Logger.info("unbinding customer session: #{inspect(reason)}")
    {seq, state} = next_sequence(state)
    state = send_pdu(state, Pdu.new(:unbind, %{}, sequence: seq))
    state = track(state, seq, :unbind, nil, state.settings.unbind_timeout_ms)
    {:noreply, %{state | phase: :closing, unbind_request: reason}}
  end

  defp revalidate(%{trunk: old} = state) do
    case TrunkStore.get(old.id) do
      :error -> {:drop, :trunk_removed}
      {:ok, trunk} -> still_allowed(state, old, trunk)
    end
  end

  # The first rule the changed trunk breaks drops the session; otherwise it carries on with the new settings.
  defp still_allowed(state, old, trunk) do
    rules = [
      trunk_inactive: fn -> trunk.status == :active end,
      credentials_changed: fn ->
        trunk.username == old.username and trunk.password == old.password
      end,
      ip_not_allowed: fn -> Trunk.ip_allowed?(trunk, state.ip) end,
      tls_required: fn -> Trunk.transport_allowed?(trunk, state.tls) end,
      bind_type_not_allowed: fn -> Trunk.bind_allowed?(trunk, state.bind) end
    ]

    case Enum.find(rules, fn {_reason, ok?} -> not ok?.() end) do
      nil -> {:ok, trunk}
      {reason, _} -> {:drop, reason}
    end
  end

  # ---------------------------------------------------------------- message requests

  defp handle_request(state, pdu) do
    case refusal(state, pdu) do
      nil -> start_intake(state, pdu, false)
      :buffered -> start_intake(state, pdu, true)
      status -> send_pdu(state, Pdu.response(pdu, status))
    end
  end

  # Why a message request is answered at once instead of going to the intake, or nil.
  defp refusal(%{phase: :closing}, %Pdu{command: command}) when command in @counted,
    do: :esme_rthrottled

  defp refusal(%{phase: phase}, _pdu) when phase != :bound, do: :esme_rinvbndsts
  defp refusal(%{bind: :rx}, _pdu), do: :esme_rinvbndsts
  defp refusal(state, %Pdu{command: command}) when command in @counted, do: throttled(state)
  defp refusal(_state, _pdu), do: nil

  # Over the TPS limit, a trunk with an overflow buffer has the message accepted and queued while the buffer has room
  # (S-2.4); the pipeline sends it when the trunk's TPS allows.
  defp throttled(state) do
    cond do
      Customer.draining?() ->
        :esme_rthrottled

      Throttle.acquire(Trunk.tps_counters(state.trunk)) == :ok ->
        nil

      Throttle.buffer_take(Trunk.buffer_key(state.trunk), state.trunk.overflow_buffer) ->
        :buffered

      true ->
        :esme_rthrottled
    end
  end

  defp start_intake(state, pdu, buffered) do
    # S-1.13: a sequence number the client reuses while the first is open is still answered on its own.
    if Enum.any?(state.inflight, fn {_, e} -> e.pdu.sequence == pdu.sequence end) do
      Logger.warning("client reused sequence #{pdu.sequence} while it was still open")
    end

    context = %{
      origin: %{session_id: state.id, trunk_id: state.trunk.id, ip: state.ip, bind: state.bind},
      trunk: state.trunk,
      port: state.port,
      node: node(),
      received_at: DateTime.utc_now(),
      buffered: buffered
    }

    session = self()
    intake = state.intake
    metadata = Logger.metadata()

    task =
      Task.Supervisor.async_nolink(@task_supervisor, fn ->
        run_intake(session, intake, context, pdu, metadata)
      end)

    timeout =
      if state.trunk.delayed_submit and pdu.command in [:submit_sm, :data_sm],
        do: state.settings.delayed_intake_timeout_ms,
        else: state.settings.intake_timeout_ms

    timer = Process.send_after(self(), {:intake_timeout, task.ref}, timeout)

    %{state | inflight: Map.put(state.inflight, task.ref, %{pdu: pdu, timer: timer})}
  end

  @doc false
  def run_intake(session, intake, context, pdu, metadata) do
    Logger.metadata(metadata)
    reply = intake.handle(context, pdu)

    # §13.1 rule 1: the answer belongs to that session only; the message itself carries on (S-2.6).
    unless Process.alive?(session) do
      Logger.warning(
        "session lost before response: #{pdu.command} #{pdu.sequence} answered #{inspect(reply)}"
      )
    end

    reply
  end

  defp answer(state, req, {:ok, fields, tlvs}) when is_map(fields) and is_list(tlvs) do
    resp = Pdu.response(req, :esme_rok, fields, tlvs)

    case Pdu.encode(resp) do
      {:ok, bytes} ->
        write(state, bytes)
        state

      {:error, reason} ->
        Logger.error(
          "intake answer to #{req.command} #{req.sequence} cannot be encoded: #{inspect(reason)}"
        )

        send_pdu(state, Pdu.response(req, :esme_rsyserr))
    end
  end

  defp answer(state, req, {:error, status})
       when (is_atom(status) and status != :esme_rok) or
              (is_integer(status) and status in 1..0xFFFFFFFF) do
    send_pdu(state, Pdu.response(req, status))
  rescue
    KeyError ->
      Logger.error(
        "intake answered #{req.command} #{req.sequence} with unknown status #{inspect(status)}"
      )

      send_pdu(state, Pdu.response(req, :esme_rsyserr))
  end

  defp answer(state, req, other) do
    Logger.error("intake answered #{req.command} #{req.sequence} with #{inspect(other)}")
    send_pdu(state, Pdu.response(req, :esme_rsyserr))
  end

  defp deliver_now(state, fields, tlvs, from) do
    cond do
      state.phase != :bound ->
        {:reply, {:error, :closed}, state}

      state.bind == :tx ->
        {:reply, {:error, :not_receiver}, state}

      Enum.count(state.out, fn {_, e} -> e.command == :deliver_sm end) >=
          state.settings.outbound_window ->
        {:reply, {:error, :window_full}, state}

      state.slow_until != nil and now() < state.slow_until ->
        {:reply, {:error, :slow}, state}

      true ->
        {seq, state} = next_sequence(state)
        pdu = Pdu.new(:deliver_sm, fields, sequence: seq, tlvs: tlvs)

        case Pdu.encode(pdu) do
          {:ok, bytes} ->
            write(state, bytes)
            {:noreply, track(state, seq, :deliver_sm, from, state.settings.deliver_timeout_ms)}

          {:error, reason} ->
            {:reply, {:error, {:invalid_pdu, reason}}, state}
        end
    end
  end

  # Receipts parked behind request `ref` (answered, crashed or timed out) go out once nothing they wait for is open.
  defp unpark(state, ref) do
    parked = Enum.map(state.parked, &%{&1 | waits: MapSet.delete(&1.waits, ref)})
    release(%{state | parked: parked}, &(MapSet.size(&1.waits) == 0))
  end

  defp release(state, ready?) do
    {go, stay} = Enum.split_with(state.parked, ready?)

    Enum.reduce(go, %{state | parked: stay}, fn entry, state ->
      case deliver_now(state, entry.fields, entry.tlvs, entry.from) do
        {:reply, reply, state} ->
          GenServer.reply(entry.from, reply)
          state

        {:noreply, state} ->
          state
      end
    end)
  end

  # ---------------------------------------------------------------- our requests and their responses

  defp handle_response(state, %Pdu{sequence: seq} = pdu) do
    # Any answer to a receipt, even a late one, shows a slow reader reading again.
    state = if pdu.command == :deliver_sm_resp, do: %{state | slow_until: nil}, else: state

    case Map.pop(state.out, seq) do
      {nil, _} ->
        Logger.warning("#{pdu.command} #{seq} answers nothing we sent; ignored")
        state

      {entry, out} ->
        _ = if entry.timer, do: Process.cancel_timer(entry.timer)
        state = %{state | out: out}
        state = if entry.command == :enquire_link, do: %{state | enquire: nil}, else: state
        response_arrived(state, entry, pdu)
    end
  end

  defp response_arrived(state, %{command: :unbind}, _pdu),
    do: %{state | stop_reason: state.unbind_request}

  defp response_arrived(state, %{from: nil}, _pdu), do: state

  defp response_arrived(state, %{from: from}, pdu) do
    GenServer.reply(
      from,
      {:ok,
       %{status: pdu.status, message_id: Map.get(pdu.fields, :message_id), session_id: state.id}}
    )

    state
  end

  defp keepalive(state) do
    s = state.settings
    now = now()

    case state.enquire do
      nil
      when state.phase in [:bound, :open] and now - state.last_rx >= s.enquire_link_interval_ms ->
        {seq, state} = next_sequence(state)
        state = send_pdu(state, Pdu.new(:enquire_link, %{}, sequence: seq))
        {:noreply, %{track(state, seq, :enquire_link, nil, nil) | enquire: {seq, now}}}

      {seq, sent_at} when now - sent_at >= s.enquire_link_timeout_ms ->
        if state.last_rx > sent_at do
          # The client is alive (it sent something) but ignored this enquire_link: forget it and ask again later.
          {:noreply, %{state | enquire: nil, out: Map.delete(state.out, seq)}}
        else
          Logger.warning(
            "no answer to enquire_link within #{s.enquire_link_timeout_ms} ms; closing"
          )

          {:stop, {:shutdown, :enquire_link_timeout}, state}
        end

      _ ->
        {:noreply, state}
    end
  end

  defp next_sequence(%{next_seq: seq} = state) do
    following = if seq >= @max_sequence, do: 1, else: seq + 1
    state = %{state | next_seq: following}
    if Map.has_key?(state.out, seq), do: next_sequence(state), else: {seq, state}
  end

  defp track(state, seq, command, from, timeout) do
    timer = if timeout, do: Process.send_after(self(), {:out_timeout, seq}, timeout)
    %{state | out: Map.put(state.out, seq, %{command: command, from: from, timer: timer})}
  end

  # ---------------------------------------------------------------- writing

  # Only for PDUs the switch builds itself, which always encode.
  defp send_pdu(state, %Pdu{} = pdu) do
    write(state, Pdu.encode!(pdu))
    state
  end

  defp write(state, bytes) do
    case state.transport.send(state.socket, bytes) do
      :ok -> :ok
      {:error, reason} -> exit({:shutdown, {:send_failed, reason}})
    end
  end

  defp new_id, do: Base.encode32(:crypto.strong_rand_bytes(10), case: :lower, padding: false)
  defp now, do: System.monotonic_time(:millisecond)
  defp ip_text(ip), do: ip |> :inet.ntoa() |> to_string()
end
