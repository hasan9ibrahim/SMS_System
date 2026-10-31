defmodule Sms.Switch.Vendor.Session do
  @moduledoc """
  One connection from the switch to a vendor, where the switch is the client (ESME) (spec §2, §5.5, migration 058
  bind policy, docs/SMPP_SCENARIOS.md §5). `Sms.Switch.Vendor.Manager` starts one process per connection index the
  node owns; the process lives as long as the index stays here, and reconnects on its own.

  ## Lifecycle

    * **connect** to the trunk's host and port, from its Source Host when set, over TCP or TLS at the trunk's
      version or newer (TLS 1.0 only when the trunk asks for it, decision Q9). The vendor's certificate is checked
      against the system's CAs and the host name unless `tls_verify: :none` is configured, or the trunk says "Skip
      certificate check" (`tls_skip_verify`, for a vendor with a self-signed certificate).
    * **bind** as the trunk's bind type (TX, RX or TR) with its username, password, System Type and bind address
      (TON, NPI, range), interface version 3.4, within `:bind_timeout_ms`.
    * **bound**: submits go out (TX and TR); receipts and MO come in (RX and TR) and go to
      `Sms.Switch.Vendor.Receipts`.
    * **reconnect**: a failed connect, a refused bind, a dropped connection or an `unbind` from the vendor waits the
      next value of the trunk's reconnect schedule (the last one repeating; reset once bound) and tries again. A
      refused password or system ID (0x0E, 0x0F) waits the trunk's Auth Fail Retry instead, so a wrong password
      never hammers the vendor or locks the account.
    * **Bind Down Alert**: once the connection has been down for the trunk's Bind Alert time, `bind_down` is
      published (once per outage), and `bind_up` when it binds again.

  ## Submits

    * At most Window Size submits wait for their response; a full window answers `{:error, :window_full}` at once
      and the caller tries another connection (the overflow buffer is the pipeline's, step 4).
    * Submit Interval spaces submits on this connection: requests inside the window wait their turn here.
    * A submit with no response within Submit Timeout is answered `{:error, :timeout}`: it may have been sent, and
      the pipeline re-routes it (decision D4). Its sequence number is kept for `:late_keep_ms`; a response that
      arrives later is published as `late_response` (with the caller's `:ref`) so the message can be flagged as a
      possible duplicate. A connection lost with submits written but unanswered answers them
      `{:error, :connection_lost}`, which means the same.
    * TPS is counted by the caller across both servers (`Sms.Switch.Vendor.submit/5`), not here.

  ## Keep-alive

  After the trunk's Enquire Link Interval without any PDU from the vendor, the session sends `enquire_link`; if
  nothing at all arrives within the trunk's Enquire Link Timeout after it, the connection is dropped and opened again.
  The vendor's own `enquire_link` is answered at once. While the receipts in hand fill the inbound window the session
  reads nothing, so the time it does not read never counts against the vendor.
  """
  use GenServer, restart: :temporary
  require Logger
  alias Sms.Switch.Smpp.{Command, Pdu, Status}
  alias Sms.Switch.Vendor.{Events, MessageId, Receipts, Trunk}

  @registry Sms.Switch.Vendor.Registry
  @scope :sms_vendor_sessions
  @task_supervisor Sms.Switch.Vendor.Tasks
  @max_sequence 0x7FFFFFFF
  @bind_commands %{tx: :bind_transmitter, rx: :bind_receiver, trx: :bind_transceiver}
  @bind_responses [:bind_transmitter_resp, :bind_receiver_resp, :bind_transceiver_resp]
  @submits [:submit_sm, :data_sm]
  @incoming [:deliver_sm, :data_sm]
  # A refused bind for these waits the trunk's Auth Fail Retry (migration 058).
  @auth_failures [0x0E, 0x0F]
  @tls_versions [:"tlsv1.3", :"tlsv1.2", :"tlsv1.1", :tlsv1]
  # No connection: waiting to connect, or leaving for good.
  @offline [:idle, :stopped]

  @defaults [
    connect_timeout_ms: 10_000,
    bind_timeout_ms: 10_000,
    tick_ms: 1_000,
    inbound_window: 100,
    receipt_timeout_ms: 30_000,
    unbind_timeout_ms: 5_000,
    late_keep_ms: 600_000,
    max_pdu_length: 66_000,
    tls_verify: :peer
  ]

  defstruct [
    :trunk,
    :index,
    :id,
    :settings,
    :receipts,
    :transport,
    :socket,
    :tags,
    :retry_timer,
    :interval_timer,
    :enquire,
    :stopping,
    :bound_at,
    :down_since,
    :local_port,
    :peer,
    :tls,
    :vendor_unbind,
    phase: :idle,
    attempt: 0,
    alerted: false,
    buffer: <<>>,
    armed: false,
    out: %{},
    pending: :queue.new(),
    late: %{},
    inflight: %{},
    next_seq: 1,
    last_rx: 0,
    last_submit_at: nil
  ]

  @doc "The settings with their defaults (`config :sms_switch, Sms.Switch.Vendor, session: [...]`)."
  @spec settings(keyword()) :: map()
  def settings(overrides \\ []) do
    configured =
      :sms_switch |> Application.get_env(Sms.Switch.Vendor, []) |> Keyword.get(:session, [])

    @defaults |> Keyword.merge(configured) |> Keyword.merge(overrides) |> Map.new()
  end

  @doc "Options: `:trunk`, `:index` (the connection index), `:settings` and `:receipts` (the module)."
  def start_link(opts) do
    trunk = Keyword.fetch!(opts, :trunk)
    index = Keyword.fetch!(opts, :index)
    GenServer.start_link(__MODULE__, opts, name: {:via, Registry, {@registry, {trunk.id, index}}})
  end

  @doc """
  Sends a `submit_sm` or `data_sm` with these fields and TLVs, and waits for the vendor's response.

  `{:ok, %{status: code, message_id: key, raw_message_id: id, session_id: id, peer: peer, tlvs: tlvs}}` is the
  response: a non-zero status is the vendor refusing it (the pipeline classifies it, S-5.3), `message_id` is
  normalised per the trunk's MsgID Type (`Sms.Switch.Vendor.MessageId`) and `peer` is the vendor's address as
  connected (`%{ip: ip, port: port}`, or nil). Errors, never sent: `:window_full`, `:closed`,
  `:not_transmitter`, `{:invalid_pdu, reason}`. Errors, possibly sent: `:timeout`, `:connection_lost`.

  Options: `:ref`, the caller's id for the message, returned in `late_response`.
  """
  @spec submit(pid(), :submit_sm | :data_sm, map(), list(), keyword()) ::
          {:ok, map()} | {:error, term()}
  def submit(pid, command, fields, tlvs \\ [], opts \\ []) when command in @submits do
    GenServer.call(pid, {:submit, command, fields, tlvs, Keyword.get(opts, :ref)}, :infinity)
  catch
    :exit, {:noproc, _} -> {:error, :closed}
    :exit, {{:nodedown, _}, _} -> {:error, :connection_lost}
    :exit, _ -> {:error, :connection_lost}
  end

  @doc "Applies a new version of the trunk: in place, or by unbinding and connecting again when it needs to."
  @spec update(pid(), Trunk.t()) :: :ok
  def update(pid, %Trunk{} = trunk), do: GenServer.cast(pid, {:update, trunk})

  @doc "Unbinds (waiting briefly for `unbind_resp`) and stops: the index left this node, or the trunk did."
  @spec stop(pid(), term()) :: :ok
  def stop(pid, reason), do: GenServer.cast(pid, {:stop, reason})

  @doc "The session's details: phase, trunk, index, window use (Network Status, §13.1)."
  @spec info(pid()) :: map()
  def info(pid), do: GenServer.call(pid, :info)

  # ---------------------------------------------------------------- start

  @impl true
  def init(opts) do
    Process.flag(:trap_exit, true)
    trunk = Keyword.fetch!(opts, :trunk)

    state = %__MODULE__{
      trunk: trunk,
      index: Keyword.fetch!(opts, :index),
      id: new_id(),
      settings: settings(Keyword.get(opts, :settings, [])),
      receipts: Keyword.get(opts, :receipts) || Receipts.impl(),
      down_since: now()
    }

    Logger.metadata(vendor_trunk_id: trunk.id, connection: state.index, session_id: state.id)
    Process.send_after(self(), :tick, state.settings.tick_ms)
    send(self(), :connect)
    {:ok, state}
  end

  # ---------------------------------------------------------------- connect and bind

  @impl true
  def handle_info(:connect, %{phase: :idle} = state) do
    state = %{state | retry_timer: nil}

    case open(state.trunk, state.settings) do
      {:ok, transport, socket} -> state |> send_bind(transport, socket) |> continue()
      {:error, reason} -> {:noreply, retry(state, {:connect_failed, reason}, nil)}
    end
  end

  def handle_info(:connect, state), do: {:noreply, state}

  # ---------------------------------------------------------------- socket

  def handle_info({tag, socket, data}, %{socket: socket, tags: {tag, _, _}} = state) do
    state = %{state | buffer: state.buffer <> data, armed: false, last_rx: now()}
    state |> process_buffer() |> continue()
  end

  def handle_info({tag, socket}, %{socket: socket, tags: {_, tag, _}} = state),
    do: state |> disconnected(:closed_by_vendor) |> continue()

  def handle_info({tag, socket, reason}, %{socket: socket, tags: {_, _, tag}} = state),
    do: state |> disconnected({:socket_error, reason}) |> continue()

  # Messages from a socket already closed.
  def handle_info({tag, _socket, _data}, state) when tag in [:tcp, :ssl, :tcp_error, :ssl_error],
    do: {:noreply, state}

  def handle_info({tag, _socket}, state) when tag in [:tcp_closed, :ssl_closed],
    do: {:noreply, state}

  # ---------------------------------------------------------------- receipt answers

  def handle_info({ref, reply}, state)
      when is_reference(ref) and is_map_key(state.inflight, ref) do
    Process.demonitor(ref, [:flush])
    {entry, inflight} = Map.pop!(state.inflight, ref)
    _ = Process.cancel_timer(entry.timer)
    state = %{state | inflight: inflight}
    state |> answer_receipt(entry.pdu, reply) |> after_inflight() |> continue()
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state)
      when is_map_key(state.inflight, ref) do
    {entry, inflight} = Map.pop!(state.inflight, ref)
    _ = Process.cancel_timer(entry.timer)

    Logger.error(
      "receipt handler crashed on #{entry.pdu.command} #{entry.pdu.sequence}: #{inspect(reason)}"
    )

    state = %{state | inflight: inflight}
    state |> send_pdu(Pdu.response(entry.pdu, :esme_rsyserr)) |> after_inflight() |> continue()
  end

  def handle_info({:receipt_timeout, ref}, state) when is_map_key(state.inflight, ref) do
    Process.demonitor(ref, [:flush])
    {entry, inflight} = Map.pop!(state.inflight, ref)

    Logger.error(
      "receipt handler gave no answer to #{entry.pdu.command} #{entry.pdu.sequence} in time"
    )

    state = %{state | inflight: inflight}
    state |> send_pdu(Pdu.response(entry.pdu, :esme_rsyserr)) |> after_inflight() |> continue()
  end

  # A handler answering after its timeout, or after the connection it came on was lost.
  def handle_info({ref, _late}, state) when is_reference(ref), do: {:noreply, state}
  def handle_info({:receipt_timeout, _ref}, state), do: {:noreply, state}
  def handle_info({:DOWN, _ref, :process, _pid, _reason}, state), do: {:noreply, state}

  # ---------------------------------------------------------------- timers

  def handle_info(:tick, state) do
    Process.send_after(self(), :tick, state.settings.tick_ms)
    state |> sweep_late() |> bind_alert() |> keepalive() |> continue()
  end

  def handle_info({:out_timeout, seq}, state) do
    case Map.pop(state.out, seq) do
      {nil, _} -> {:noreply, state}
      {entry, out} -> %{state | out: out} |> timed_out(seq, entry) |> continue()
    end
  end

  def handle_info(:send_pending, state),
    do: %{state | interval_timer: nil} |> flush_pending() |> continue()

  # The socket's port (linked to its owner) closing normally; the socket message says why.
  def handle_info({:EXIT, _port_or_pid, :normal}, state), do: {:noreply, state}
  def handle_info({:EXIT, _pid, reason}, state), do: {:stop, reason, state}

  def handle_info(msg, state) do
    Logger.debug("vendor session ignored #{inspect(msg)}")
    {:noreply, state}
  end

  # ---------------------------------------------------------------- calls

  @impl true
  def handle_call({:submit, command, fields, tlvs, ref}, from, state) do
    cond do
      state.phase != :bound or state.stopping != nil ->
        {:reply, {:error, :closed}, state}

      state.trunk.bind_type == :rx ->
        {:reply, {:error, :not_transmitter}, state}

      submits_waiting(state) >= state.trunk.window_size ->
        {:reply, {:error, :window_full}, state}

      true ->
        {seq, state} = next_sequence(state)

        fields =
          if st = state.trunk.service_type, do: Map.put(fields, :service_type, st), else: fields

        case Pdu.encode(Pdu.new(command, fields, sequence: seq, tlvs: tlvs)) do
          {:ok, bytes} ->
            entry = %{
              command: command,
              from: from,
              ref: ref,
              bytes: bytes,
              timer: nil,
              sent: false
            }

            state = %{
              state
              | out: Map.put(state.out, seq, entry),
                pending: :queue.in(seq, state.pending)
            }

            state |> flush_pending() |> continue()

          {:error, reason} ->
            {:reply, {:error, {:invalid_pdu, reason}}, state}
        end
    end
  end

  def handle_call(:info, _from, state) do
    info = %{
      id: state.id,
      trunk_id: state.trunk.id,
      index: state.index,
      phase: state.phase,
      bind: state.trunk.bind_type,
      node: node(),
      host: state.trunk.host,
      port: state.trunk.port,
      local_port: state.local_port,
      tls: state.tls,
      bound_at: state.bound_at,
      attempt: state.attempt,
      submits_waiting: submits_waiting(state),
      receipts_inflight: map_size(state.inflight)
    }

    {:reply, info, state}
  end

  @impl true
  def handle_cast({:update, trunk}, state) do
    old = state.trunk
    state = %{state | trunk: trunk}

    cond do
      not Trunk.reconnect_needed?(old, trunk) ->
        {:noreply, state}

      state.phase == :bound ->
        Logger.info("vendor trunk connection settings changed; unbinding to connect again")
        state |> unbind_ours(:trunk_changed) |> continue()

      state.phase == :binding ->
        state |> disconnected(:trunk_changed) |> continue()

      state.phase == :unbinding ->
        # The connection opened next uses the new settings.
        {:noreply, state}

      true ->
        # Waiting to connect: try the new settings now.
        _ = if state.retry_timer, do: Process.cancel_timer(state.retry_timer)
        send(self(), :connect)
        {:noreply, %{state | attempt: 0, retry_timer: nil}}
    end
  end

  def handle_cast({:stop, reason}, %{phase: :bound} = state) do
    Logger.info("vendor connection leaving: #{inspect(reason)}")
    %{state | stopping: reason} |> unbind_ours(reason) |> continue()
  end

  # Already unbinding: it stops instead of connecting again once the unbind is done.
  def handle_cast({:stop, reason}, %{phase: :unbinding} = state),
    do: {:noreply, %{state | stopping: reason}}

  def handle_cast({:stop, reason}, state), do: {:stop, :normal, %{state | stopping: reason}}

  @impl true
  def terminate(reason, state) do
    if state.phase == :bound and reason == :shutdown, do: unbind_on_shutdown(state)
    if state.phase in [:bound, :unbinding], do: publish_closed(state, reason)
    _ = fail_waiting(state)
    close_socket(state)
  end

  # ---------------------------------------------------------------- connecting

  defp open(trunk, settings) do
    tcp =
      [:binary, active: false, packet: :raw, nodelay: true, keepalive: true, send_timeout: 10_000] ++
        if(trunk.source_host, do: [ip: trunk.source_host], else: [])

    host = String.to_charlist(trunk.host)

    with {:ok, socket} <- :gen_tcp.connect(host, trunk.port, tcp, settings.connect_timeout_ms) do
      if trunk.tls == :none, do: {:ok, :gen_tcp, socket}, else: upgrade(socket, trunk, settings)
    end
  end

  defp upgrade(socket, trunk, settings) do
    case :ssl.connect(socket, tls_options(trunk, settings), settings.connect_timeout_ms) do
      {:ok, tls} ->
        {:ok, :ssl, tls}

      {:error, _} = error ->
        :gen_tcp.close(socket)
        error
    end
  end

  @doc false
  # The trunk's TLS version and every newer one, each with the runtime's default cipher suites for it.
  def tls_options(trunk, settings) do
    versions =
      case trunk.tls do
        :"tls1.3" -> [:"tlsv1.3"]
        :"tls1.2" -> [:"tlsv1.3", :"tlsv1.2"]
        :"tls1.0" -> @tls_versions
      end

    ciphers = versions |> Enum.flat_map(&:ssl.cipher_suites(:default, &1)) |> Enum.uniq()
    base = [versions: versions, ciphers: ciphers, active: false]

    # A vendor with a self-signed certificate: "Skip certificate check" on its trunk (Q3, product owner 2026-10-25).
    verify = if Map.get(trunk, :tls_skip_verify, false), do: :none, else: settings.tls_verify

    case verify do
      :none ->
        [verify: :verify_none] ++ base

      :peer ->
        host = String.to_charlist(trunk.host)

        # A host name is checked against the certificate; an IP address cannot be sent as SNI.
        name_opts =
          case :inet.parse_address(host) do
            {:ok, _ip} -> [server_name_indication: :disable]
            {:error, _} -> [server_name_indication: host]
          end

        [
          verify: :verify_peer,
          cacerts: :public_key.cacerts_get(),
          customize_hostname_check: [
            match_fun: :public_key.pkix_verify_hostname_match_fun(:https)
          ]
        ] ++ name_opts ++ base
    end
  end

  defp send_bind(state, transport, socket) do
    {seq, state} = next_sequence(%{state | transport: transport, socket: socket})
    trunk = state.trunk

    fields = %{
      system_id: trunk.username,
      password: trunk.password,
      system_type: trunk.system_type || "",
      interface_version: 0x34,
      addr_ton: trunk.bind_addr_ton,
      addr_npi: trunk.bind_addr_npi,
      address_range: trunk.bind_addr_range || ""
    }

    local_port =
      case sockname(transport, socket) do
        {:ok, {_, port}} -> port
        {:error, _} -> nil
      end

    state = %{
      state
      | tags: tags(transport),
        phase: :binding,
        local_port: local_port,
        peer: peer(transport, socket),
        tls: negotiated_tls(transport, socket),
        buffer: <<>>,
        armed: false,
        last_rx: now()
    }

    case Pdu.encode(Pdu.new(Map.fetch!(@bind_commands, trunk.bind_type), fields, sequence: seq)) do
      {:ok, bytes} ->
        case transport.send(socket, bytes) do
          :ok -> state |> track(seq, :bind, state.settings.bind_timeout_ms) |> arm()
          {:error, reason} -> disconnected(state, {:send_failed, reason})
        end

      # A username, password or System Type too long for SMPP 3.4: fix the trunk; until then wait like a refusal.
      {:error, reason} ->
        Logger.error("vendor trunk #{trunk.id} cannot bind: #{inspect(reason)}")
        close_socket(state)

        retry(
          %{state | phase: :idle, socket: nil, transport: nil},
          {:invalid_bind, reason},
          :auth
        )
    end
  end

  defp sockname(:gen_tcp, socket), do: :inet.sockname(socket)
  defp sockname(:ssl, socket), do: :ssl.sockname(socket)

  # The vendor's address as connected (its host name resolved), for the EDR's vendor IP and port.
  defp peer(transport, socket) do
    case peername(transport, socket) do
      {:ok, {ip, port}} -> %{ip: ip, port: port}
      {:error, _} -> nil
    end
  end

  defp peername(:gen_tcp, socket), do: :inet.peername(socket)
  defp peername(:ssl, socket), do: :ssl.peername(socket)

  defp tags(:gen_tcp), do: {:tcp, :tcp_closed, :tcp_error}
  defp tags(:ssl), do: {:ssl, :ssl_closed, :ssl_error}

  defp negotiated_tls(:ssl, socket) do
    case :ssl.connection_information(socket, [:protocol]) do
      {:ok, [protocol: version]} -> version
      _ -> nil
    end
  end

  defp negotiated_tls(_transport, _socket), do: nil

  defp bound(state, pdu) do
    trunk = state.trunk
    if trunk.bind_type in [:tx, :trx], do: :ok = :pg.join(@scope, {:tx, trunk.id}, self())

    Logger.info(
      "vendor bound: #{trunk.bind_type} trunk #{trunk.id} connection #{state.index} to #{trunk.host}:#{trunk.port}"
    )

    data =
      Map.merge(event_data(state), %{system_id: Map.get(pdu.fields, :system_id), tls: state.tls})

    Events.publish(:bound, data)
    if state.alerted, do: Events.publish(:bind_up, data)

    %{
      state
      | phase: :bound,
        attempt: 0,
        alerted: false,
        bound_at: DateTime.utc_now(),
        down_since: nil
    }
  end

  defp bind_refused(state, pdu) do
    status = pdu.status

    Logger.warning(
      "vendor refused the bind: 0x#{Integer.to_string(status, 16)} (#{inspect(Status.name(status))})"
    )

    close_socket(state)
    state = %{state | phase: :idle, socket: nil, transport: nil, out: %{}, buffer: <<>>}
    retry(state, {:bind_refused, Status.name(status)}, if(status in @auth_failures, do: :auth))
  end

  # The wait before the next attempt: the reconnect schedule, or Auth Fail Retry after a refused password.
  defp retry(state, reason, kind) do
    trunk = state.trunk

    delay =
      if kind == :auth,
        do: trunk.auth_fail_retry_min * 60_000,
        else: Trunk.reconnect_delay_ms(trunk, state.attempt)

    Logger.info(
      "vendor connection attempt failed (#{inspect(reason)}); next in #{div(delay, 1000)} s"
    )

    Events.publish(
      :bind_failed,
      Map.merge(event_data(state), %{reason: inspect(reason), retry_in_ms: delay})
    )

    _ = if state.retry_timer, do: Process.cancel_timer(state.retry_timer)

    %{
      state
      | phase: :idle,
        attempt: state.attempt + 1,
        retry_timer: Process.send_after(self(), :connect, delay),
        down_since: state.down_since || now()
    }
  end

  # The connection is gone (dropped, unbound, timed out): answer what waited on it and connect again.
  defp disconnected(state, reason) do
    was = state.phase
    close_socket(state)
    if was == :bound, do: leave_group(state)
    if was in [:bound, :unbinding], do: publish_closed(state, reason)
    state = fail_waiting(state)

    state = %{
      state
      | phase: :idle,
        socket: nil,
        transport: nil,
        buffer: <<>>,
        armed: false,
        enquire: nil,
        inflight: %{},
        bound_at: nil,
        down_since: state.down_since || now()
    }

    cond do
      state.stopping != nil ->
        # Leaving for good: `continue/1` stops the process.
        %{state | phase: :stopped}

      reason == :trunk_changed ->
        # Our own unbind for new settings: connect again at once.
        send(self(), :connect)
        %{state | attempt: 0}

      true ->
        Logger.warning("vendor connection lost: #{inspect(reason)}")
        retry(state, reason, nil)
    end
  end

  defp leave_group(state) do
    _ = :pg.leave(@scope, {:tx, state.trunk.id}, self())
    :ok
  end

  defp publish_closed(state, reason) do
    Events.publish(
      :closed,
      Map.merge(event_data(state), %{
        reason: inspect(reason),
        submits_waiting: submits_waiting(state)
      })
    )
  end

  # Answers every submit still waiting: never written → :closed (safe to send elsewhere); written → :connection_lost.
  defp fail_waiting(state) do
    for {_seq, %{from: from} = entry} <- state.out, from != nil do
      _ = if entry[:timer], do: Process.cancel_timer(entry.timer)
      GenServer.reply(from, {:error, if(entry[:sent], do: :connection_lost, else: :closed)})
    end

    _ = if state.interval_timer, do: Process.cancel_timer(state.interval_timer)
    %{state | out: %{}, pending: :queue.new(), interval_timer: nil}
  end

  defp close_socket(%{socket: nil}), do: :ok
  defp close_socket(%{transport: transport, socket: socket}), do: transport.close(socket)

  # The node is stopping: tell the vendor and give it a moment to answer.
  defp unbind_on_shutdown(state) do
    {seq, state} = next_sequence(state)
    _ = state.transport.send(state.socket, Pdu.encode!(Pdu.new(:unbind, %{}, sequence: seq)))
    _ = setopts(state, active: false)
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

  defp process_buffer(%{phase: phase} = state) when phase in @offline, do: state

  defp process_buffer(state) do
    if map_size(state.inflight) >= state.settings.inbound_window do
      state
    else
      state.buffer |> Pdu.decode(max_length: state.settings.max_pdu_length) |> decoded(state)
    end
  end

  defp decoded({:ok, pdu, rest}, state),
    do: %{state | buffer: rest} |> handle_pdu(pdu) |> process_buffer()

  defp decoded({:incomplete, _}, state), do: state

  defp decoded({:error, error, rest}, state) do
    Logger.warning("bad PDU from vendor: #{Exception.message(error)}")
    state = %{state | buffer: rest}
    state = if reply = Pdu.error_reply(error), do: send_pdu(state, reply), else: state

    # S-1.9: the stream can no longer be framed.
    if error.fatal, do: disconnected(state, :invalid_command_length), else: process_buffer(state)
  end

  defp continue(state) do
    case arm(state) do
      %{phase: :stopped} = state -> {:stop, :normal, state}
      state -> {:noreply, state}
    end
  end

  defp arm(%{phase: phase} = state) when phase in @offline, do: state
  defp arm(%{armed: true} = state), do: state

  defp arm(state) do
    if map_size(state.inflight) < state.settings.inbound_window do
      case setopts(state, active: :once) do
        :ok -> %{state | armed: true}
        {:error, reason} -> disconnected(state, {:socket_error, reason})
      end
    else
      state
    end
  end

  defp setopts(%{transport: :gen_tcp, socket: socket}, opts), do: :inet.setopts(socket, opts)
  defp setopts(%{transport: :ssl, socket: socket}, opts), do: :ssl.setopts(socket, opts)

  # ---------------------------------------------------------------- PDUs from the vendor

  defp handle_pdu(%{phase: phase} = state, _pdu) when phase in @offline, do: state

  defp handle_pdu(state, %Pdu{command: :enquire_link} = pdu),
    do: send_pdu(state, Pdu.response(pdu))

  defp handle_pdu(state, %Pdu{command: :unbind} = pdu) do
    Logger.info("vendor unbound the connection")
    if state.phase == :bound, do: leave_group(state)

    # Receipts already being handled are answered first, then unbind_resp (as S-1.7 on the customer side).
    after_inflight(%{state | phase: :unbinding, enquire: nil, vendor_unbind: pdu})
  end

  defp handle_pdu(state, %Pdu{command: command} = pdu) when command in @incoming do
    cond do
      state.phase != :bound -> send_pdu(state, Pdu.response(pdu, :esme_rinvbndsts))
      state.trunk.bind_type == :tx -> send_pdu(state, Pdu.response(pdu, :esme_rinvbndsts))
      true -> start_receipt(state, pdu)
    end
  end

  defp handle_pdu(state, %Pdu{command: :generic_nack, sequence: seq} = pdu)
       when is_map_key(state.out, seq),
       do: handle_response(state, pdu)

  defp handle_pdu(state, %Pdu{command: command} = pdu) do
    cond do
      Command.response?(command) ->
        handle_response(state, pdu)

      Command.response(command) ->
        # A request only a client sends (submit_sm, bind…), or one the switch does not take from a vendor.
        send_pdu(state, Pdu.response(pdu, :esme_rinvcmdid))

      true ->
        # outbind, alert_notification: nothing to answer.
        Logger.info("vendor sent #{command}; ignored")
        state
    end
  end

  # ---------------------------------------------------------------- responses to our requests

  defp handle_response(state, %Pdu{sequence: seq} = pdu) do
    case Map.pop(state.out, seq) do
      {nil, _} ->
        late_response(state, pdu)

      {entry, out} ->
        _ = if entry.timer, do: Process.cancel_timer(entry.timer)
        response_arrived(%{state | out: out}, entry, pdu)
    end
  end

  defp response_arrived(
         %{phase: :binding} = state,
         %{command: :bind},
         %Pdu{command: c, status: 0} = pdu
       )
       when c in @bind_responses,
       do: bound(state, pdu)

  defp response_arrived(%{phase: :binding} = state, %{command: :bind}, pdu),
    do: bind_refused(state, pdu)

  defp response_arrived(state, %{command: :enquire_link}, _pdu), do: %{state | enquire: nil}

  defp response_arrived(state, %{command: :unbind}, _pdu),
    do: disconnected(state, unbind_reason(state))

  defp response_arrived(state, %{command: command, from: from}, pdu) when command in @submits do
    message_id = if pdu.status == 0, do: Map.get(pdu.fields, :message_id)

    GenServer.reply(
      from,
      {:ok,
       %{
         status: pdu.status,
         message_id: message_id && MessageId.normalize(message_id, state.trunk.msg_id_type),
         raw_message_id: message_id,
         session_id: state.id,
         peer: state.peer,
         tlvs: pdu.tlvs
       }}
    )

    flush_pending(state)
  end

  defp response_arrived(state, entry, pdu) do
    Logger.warning("#{pdu.command} #{pdu.sequence} does not answer our #{entry.command}; ignored")
    state
  end

  defp unbind_reason(%{stopping: nil}), do: :trunk_changed
  defp unbind_reason(%{stopping: reason}), do: reason

  # A submit response after its timeout (S-5.2, D4): the message may now be sent twice; the pipeline flags it.
  defp late_response(state, %Pdu{sequence: seq} = pdu) do
    case Map.pop(state.late, seq) do
      {nil, _} ->
        Logger.warning("#{pdu.command} #{seq} answers nothing we sent; ignored")
        state

      {entry, late} ->
        message_id = if pdu.status == 0, do: Map.get(pdu.fields, :message_id)

        Logger.warning(
          "late #{pdu.command} #{seq} (status 0x#{Integer.to_string(pdu.status, 16)}) after timeout"
        )

        Events.publish(
          :late_response,
          Map.merge(event_data(state), %{
            ref: entry.ref,
            status: pdu.status,
            message_id: message_id && MessageId.normalize(message_id, state.trunk.msg_id_type),
            raw_message_id: message_id,
            late_by_ms: now() - entry.timed_out_at
          })
        )

        %{state | late: late}
    end
  end

  defp timed_out(state, seq, %{command: command} = entry) when command in @submits do
    GenServer.reply(entry.from, {:error, :timeout})
    late = %{ref: entry.ref, timed_out_at: now(), expires_at: now() + state.settings.late_keep_ms}
    flush_pending(%{state | late: Map.put(state.late, seq, late)})
  end

  defp timed_out(state, _seq, %{command: :bind}) do
    Logger.warning("no bind response within #{state.settings.bind_timeout_ms} ms")
    close_socket(state)

    retry(
      %{state | phase: :idle, socket: nil, transport: nil, out: %{}, buffer: <<>>},
      :bind_timeout,
      nil
    )
  end

  defp timed_out(state, _seq, %{command: :unbind}), do: disconnected(state, unbind_reason(state))

  defp sweep_late(state) do
    now = now()
    %{state | late: Map.reject(state.late, fn {_seq, entry} -> entry.expires_at <= now end)}
  end

  # ---------------------------------------------------------------- our unbind

  defp unbind_ours(state, reason) do
    leave_group(state)
    {seq, state} = next_sequence(state)

    case state.transport.send(state.socket, Pdu.encode!(Pdu.new(:unbind, %{}, sequence: seq))) do
      :ok ->
        state = %{state | phase: :unbinding, enquire: nil}
        track(state, seq, :unbind, state.settings.unbind_timeout_ms)

      {:error, _} ->
        disconnected(state, if(state.stopping, do: reason, else: :trunk_changed))
    end
  end

  # ---------------------------------------------------------------- receipts and MO

  defp start_receipt(state, pdu) do
    context = %{
      session_id: state.id,
      trunk: state.trunk,
      node: node(),
      received_at: DateTime.utc_now()
    }

    receipts = state.receipts
    metadata = Logger.metadata()

    task =
      Task.Supervisor.async_nolink(@task_supervisor, fn ->
        Logger.metadata(metadata)
        receipts.handle(context, pdu)
      end)

    timer =
      Process.send_after(self(), {:receipt_timeout, task.ref}, state.settings.receipt_timeout_ms)

    %{state | inflight: Map.put(state.inflight, task.ref, %{pdu: pdu, timer: timer})}
  end

  defp answer_receipt(state, req, :ok),
    do: send_pdu(state, Pdu.response(req, :esme_rok, %{message_id: ""}))

  defp answer_receipt(state, req, {:error, status}) do
    code = Status.code(status)
    if code == 0, do: raise(KeyError, key: status)
    send_pdu(state, Pdu.response(req, code))
  rescue
    KeyError ->
      Logger.error(
        "receipt handler answered #{req.command} #{req.sequence} with unknown status #{inspect(status)}"
      )

      send_pdu(state, Pdu.response(req, :esme_rsyserr))
  end

  defp answer_receipt(state, req, other) do
    Logger.error("receipt handler answered #{req.command} #{req.sequence} with #{inspect(other)}")
    send_pdu(state, Pdu.response(req, :esme_rsyserr))
  end

  # The vendor's unbind waits for the receipts it sent before it.
  defp after_inflight(
         %{phase: :unbinding, inflight: inflight, vendor_unbind: %Pdu{} = req} = state
       )
       when map_size(inflight) == 0 do
    state = send_pdu(%{state | vendor_unbind: nil}, Pdu.response(req))
    disconnected(state, :unbound_by_vendor)
  end

  defp after_inflight(state), do: process_buffer(state)

  # ---------------------------------------------------------------- submits

  defp submits_waiting(state),
    do: Enum.count(state.out, fn {_seq, e} -> e.command in @submits end)

  # Writes the waiting submits, one per Submit Interval when the trunk sets one.
  defp flush_pending(%{phase: :bound, interval_timer: nil} = state) do
    case :queue.out(state.pending) do
      {:empty, _} ->
        state

      {{:value, seq}, rest} ->
        interval = state.trunk.submit_interval_ms

        wait =
          if state.last_submit_at && interval > 0,
            do: state.last_submit_at + interval - now(),
            else: 0

        if wait > 0 do
          %{state | interval_timer: Process.send_after(self(), :send_pending, wait)}
        else
          state = %{state | pending: rest} |> write_submit(seq)
          flush_pending(state)
        end
    end
  end

  defp flush_pending(state), do: state

  defp write_submit(state, seq) do
    entry = Map.fetch!(state.out, seq)

    case state.transport.send(state.socket, entry.bytes) do
      :ok ->
        timer =
          Process.send_after(self(), {:out_timeout, seq}, state.trunk.submit_timeout_s * 1_000)

        entry = %{entry | bytes: nil, timer: timer, sent: true}
        %{state | out: Map.put(state.out, seq, entry), last_submit_at: now()}

      {:error, reason} ->
        disconnected(state, {:send_failed, reason})
    end
  end

  # ---------------------------------------------------------------- keep-alive and the bind alert

  # Reading paused by our own inbound window (receipts in hand): the vendor's answers wait unread in the socket, so it
  # counts as heard from until reading starts again.
  defp keepalive(%{phase: :bound} = state)
       when map_size(state.inflight) >= state.settings.inbound_window,
       do: %{state | last_rx: now()}

  defp keepalive(%{phase: :bound} = state) do
    now = now()
    trunk = state.trunk

    case state.enquire do
      nil when now - state.last_rx >= trunk.enquire_link_interval_s * 1_000 ->
        {seq, state} = next_sequence(state)
        state = send_pdu(state, Pdu.new(:enquire_link, %{}, sequence: seq))
        %{track(state, seq, :enquire_link, nil) | enquire: {seq, now}}

      {seq, sent_at} when now - sent_at >= trunk.enquire_link_timeout_s * 1_000 ->
        if state.last_rx > sent_at do
          # The vendor is alive (it sent something) but ignored this enquire_link: ask again later.
          %{state | enquire: nil, out: Map.delete(state.out, seq)}
        else
          disconnected(state, :enquire_link_timeout)
        end

      _ ->
        state
    end
  end

  defp keepalive(state), do: state

  defp bind_alert(%{phase: phase, alerted: false, down_since: since} = state)
       when phase != :bound and is_integer(since) do
    if now() - since >= state.trunk.bind_alert_after_min * 60_000 do
      Logger.warning("vendor connection down for #{state.trunk.bind_alert_after_min} min")
      Events.publish(:bind_down, Map.put(event_data(state), :down_for_ms, now() - since))
      %{state | alerted: true}
    else
      state
    end
  end

  defp bind_alert(state), do: state

  # ---------------------------------------------------------------- sequence numbers and writing

  defp next_sequence(%{next_seq: seq} = state) do
    following = if seq >= @max_sequence, do: 1, else: seq + 1
    state = %{state | next_seq: following}

    if Map.has_key?(state.out, seq) or Map.has_key?(state.late, seq),
      do: next_sequence(state),
      else: {seq, state}
  end

  defp track(state, seq, command, timeout) do
    timer = if timeout, do: Process.send_after(self(), {:out_timeout, seq}, timeout)
    %{state | out: Map.put(state.out, seq, %{command: command, from: nil, timer: timer})}
  end

  # Only for PDUs the switch builds itself, which always encode.
  defp send_pdu(%{phase: phase} = state, _pdu) when phase in @offline, do: state

  defp send_pdu(state, %Pdu{} = pdu) do
    case state.transport.send(state.socket, Pdu.encode!(pdu)) do
      :ok -> state
      {:error, reason} -> disconnected(state, {:send_failed, reason})
    end
  end

  defp event_data(state) do
    %{
      session_id: state.id,
      trunk_id: state.trunk.id,
      index: state.index,
      host: state.trunk.host,
      port: state.trunk.port,
      bind: state.trunk.bind_type,
      node: node()
    }
  end

  defp new_id, do: Base.encode32(:crypto.strong_rand_bytes(10), case: :lower, padding: false)
  defp now, do: System.monotonic_time(:millisecond)
end
