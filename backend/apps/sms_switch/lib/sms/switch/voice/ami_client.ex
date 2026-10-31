defmodule Sms.Switch.Voice.AmiClient do
  @moduledoc """
  The switch's connection to its own server's Asterisk (§8 SMS to voice, docs/SMS_TO_VOICE.md): AMI over TCP, at
  `SMS_ASTERISK_AMI_HOST` / `_PORT` with `SMS_ASTERISK_AMI_USER` / `_SECRET` (127.0.0.1:5038 on the servers).

    * **Connection:** reads Asterisk's greeting, logs in (call events only) and keeps the connection checked with a
      `Ping` every `:ping_ms`; a refused login, a lost connection or a ping not answered closes it and connects again
      after a growing pause (1 s, doubled up to 30 s; back to 1 s once logged in). `ready?/0` says whether calls can
      be placed now.
    * **Calls** (`originate/2`): `Originate` with `Async: true` and the caller's `ActionID`, answered by Asterisk's
      `OriginateResponse` with the same id: answered (`Response: Success`, with the channel's `Uniqueid`) or not (its
      `Reason`, `Sms.Switch.Voice.Ami.reason_cause/1`). An answered call is followed to its `Hangup` event, which
      gives the cause; the duration is measured here from answer to hangup. A call without an answer in time, or
      whose connection is lost before the answer, counts as not answered; one lost after the answer as answered,
      ended then (cause `UNKNOWN`).
    * **Commands** (`command/2`): `Action: Command`, e.g. `module reload res_pjsip.so` after the gateways change.

  Each caller waits in its own process; this process never blocks on a call.
  """
  use GenServer
  require Logger
  alias Sms.Switch.Voice.Ami

  @ready {__MODULE__, :ready}
  @connect_timeout_ms 5_000

  @typedoc "A call to place (`Sms.Switch.Voice.Calls` builds it)."
  @type originate :: %{
          required(:action_id) => String.t(),
          required(:channel) => String.t(),
          required(:timeout_ms) => pos_integer(),
          optional(:caller_id) => String.t() | nil,
          optional(:context) => String.t(),
          optional(:exten) => String.t(),
          optional(:priority) => pos_integer(),
          optional(:variables) => [{String.t(), String.t()}]
        }

  @typedoc "How a call ended: times in Unix ms; duration from answer to hangup."
  @type result :: %{
          answered: boolean(),
          cause: String.t(),
          placed_at: integer(),
          answered_at: integer() | nil,
          ended_at: integer(),
          duration_ms: non_neg_integer()
        }

  @doc """
  Options (else `config :sms_switch, Sms.Switch.Voice`): `:host`, `:port`, `:user`, `:secret`; `:backoff_ms` (first
  pause, 1 s), `:max_backoff_ms` (30 s), `:ping_ms` (30 s), `:response_timeout_ms` (10 s for an answer to an action),
  `:max_call_ms` (how long an answered call is followed, 15 minutes).
  """
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Whether Asterisk is connected and logged in on this server."
  @spec ready?() :: boolean()
  def ready?, do: :persistent_term.get(@ready, false) and Process.whereis(__MODULE__) != nil

  @doc """
  Places a call and waits for how it ended: `{:ok, result}`, or `{:error, :not_connected}` when no call was placed
  (Asterisk not connected now).
  """
  @spec originate(originate(), pos_integer()) :: {:ok, result()} | {:error, :not_connected}
  def originate(call, max_call_ms \\ 900_000) do
    GenServer.call(__MODULE__, {:originate, call}, call.timeout_ms + max_call_ms + 60_000)
  catch
    :exit, _ -> {:error, :not_connected}
  end

  @doc "Runs an Asterisk CLI command through AMI: its output, or why not."
  @spec command(String.t(), timeout()) :: {:ok, String.t()} | {:error, term()}
  def command(command, timeout \\ 15_000) do
    GenServer.call(__MODULE__, {:command, command}, timeout)
  catch
    :exit, _ -> {:error, :not_connected}
  end

  # ---------------------------------------------------------------- server

  @impl true
  def init(opts) do
    # So `terminate/2` runs when its supervisor stops it: not ready from then on.
    Process.flag(:trap_exit, true)
    config = Keyword.merge(Application.get_env(:sms_switch, Sms.Switch.Voice, []), opts)
    set_ready(false)

    state = %{
      host: Keyword.get(config, :host, config[:ami_host]),
      port: Keyword.get(config, :port, config[:ami_port] || 5038),
      user: Keyword.get(config, :user, config[:ami_user] || ""),
      secret: Keyword.get(config, :secret, config[:ami_secret] || ""),
      first_backoff_ms: Keyword.get(config, :backoff_ms, 1_000),
      max_backoff_ms: Keyword.get(config, :max_backoff_ms, 30_000),
      ping_ms: Keyword.get(config, :ping_ms, 30_000),
      response_timeout_ms: Keyword.get(config, :response_timeout_ms, 10_000),
      max_call_ms: Keyword.get(config, :max_call_ms, 900_000),
      backoff_ms: Keyword.get(config, :backoff_ms, 1_000),
      socket: nil,
      phase: :disconnected,
      buffer: "",
      pending: %{},
      calls: %{},
      seq: 0,
      down_logged: false
    }

    send(self(), :connect)
    {:ok, state}
  end

  @impl true
  def terminate(_reason, _state), do: set_ready(false)

  @impl true
  def handle_call({:originate, _call}, _from, %{phase: phase} = state) when phase != :ready,
    do: {:reply, {:error, :not_connected}, state}

  def handle_call({:originate, call}, from, state) do
    id = call.action_id

    fields =
      [
        {"Action", "Originate"},
        {"ActionID", id},
        {"Channel", call.channel},
        {"Context", Map.get(call, :context, "sms-voice")},
        {"Exten", Map.get(call, :exten, "s")},
        {"Priority", Map.get(call, :priority, 1)}
      ] ++
        caller_id(call[:caller_id]) ++
        [
          {"Timeout", call.timeout_ms},
          {"Async", "true"}
        ] ++ variables(call[:variables] || [])

    entry = %{
      kind: :originate,
      from: from,
      placed_at: now(),
      started: mono(),
      answered_at: nil,
      answered_mono: nil,
      uniqueid: nil,
      # No OriginateResponse within the ring timeout and a margin: not answered.
      timer: timer({:no_response, id}, call.timeout_ms + state.response_timeout_ms)
    }

    state |> send_frame(fields) |> put_pending(id, entry) |> noreply()
  end

  def handle_call({:command, _command}, _from, %{phase: phase} = state) when phase != :ready,
    do: {:reply, {:error, :not_connected}, state}

  def handle_call({:command, command}, from, state) do
    {id, state} = next_id(state, "cmd")

    entry = %{
      kind: :command,
      from: from,
      timer: timer({:no_response, id}, state.response_timeout_ms)
    }

    state
    |> send_frame([{"Action", "Command"}, {"ActionID", id}, {"Command", command}])
    |> put_pending(id, entry)
    |> noreply()
  end

  defp caller_id(value) when value in [nil, ""], do: []
  defp caller_id(value), do: [{"CallerID", value}]

  defp variables([]), do: []

  defp variables(vars),
    do: [{"Variable", Enum.map_join(vars, ",", fn {k, v} -> "#{k}=#{v}" end)}]

  @impl true
  def handle_info(:connect, state) do
    host = String.to_charlist(to_string(state.host))
    opts = [:binary, active: :once, packet: :raw, keepalive: true, nodelay: true]

    case :gen_tcp.connect(host, state.port, opts, @connect_timeout_ms) do
      {:ok, socket} ->
        {:noreply, %{state | socket: socket, phase: :banner, buffer: ""}}

      {:error, reason} ->
        {:noreply,
         retry(state, "connection to #{state.host}:#{state.port} failed: #{inspect(reason)}")}
    end
  end

  def handle_info({:tcp, socket, data}, %{socket: socket} = state) do
    :ok = :inet.setopts(socket, active: :once)
    {:noreply, read(%{state | buffer: state.buffer <> data})}
  end

  def handle_info({closed, socket}, %{socket: socket} = state) when closed in [:tcp_closed],
    do: {:noreply, drop(state, "connection closed by Asterisk")}

  def handle_info({:tcp_error, socket, reason}, %{socket: socket} = state),
    do: {:noreply, drop(state, "connection error: #{inspect(reason)}")}

  def handle_info(:ping, %{phase: :ready} = state) do
    {id, state} = next_id(state, "ping")
    entry = %{kind: :ping, from: nil, timer: timer({:no_response, id}, state.response_timeout_ms)}

    state
    |> send_frame([{"Action", "Ping"}, {"ActionID", id}])
    |> put_pending(id, entry)
    |> noreply()
  end

  def handle_info({:no_response, id}, state) do
    case Map.pop(state.pending, id) do
      {nil, _} -> {:noreply, state}
      {entry, pending} -> {:noreply, no_response(entry, id, %{state | pending: pending})}
    end
  end

  def handle_info({:max_call, id}, state) do
    case Map.pop(state.pending, id) do
      {nil, _} -> {:noreply, state}
      {entry, pending} -> {:noreply, ended(%{state | pending: pending}, id, entry, "UNKNOWN")}
    end
  end

  def handle_info(_other, state), do: {:noreply, state}

  # ---------------------------------------------------------------- reading

  defp read(%{phase: :banner} = state) do
    case Ami.banner(state.buffer) do
      {:ok, line, rest} ->
        unless String.starts_with?(line, "Asterisk Call Manager"),
          do: Logger.warning("AMI greeting not recognised: #{inspect(line)}")

        login = [
          {"Action", "Login"},
          {"ActionID", "login"},
          {"Username", state.user},
          {"Secret", state.secret},
          {"Events", "call"}
        ]

        entry = %{
          kind: :login,
          from: nil,
          timer: timer({:no_response, "login"}, state.response_timeout_ms)
        }

        read(
          %{send_frame(state, login) | phase: :login, buffer: rest}
          |> put_pending("login", entry)
        )

      :more ->
        state
    end
  end

  defp read(%{socket: nil} = state), do: state

  defp read(state) do
    {frames, rest} = Ami.decode(state.buffer)
    Enum.reduce(frames, %{state | buffer: rest}, &frame/2)
  end

  # A connection dropped while handling earlier frames of the same read.
  defp frame(_frame, %{socket: nil} = state), do: state
  defp frame(%{"event" => "OriginateResponse"} = f, state), do: originate_response(f, state)
  defp frame(%{"event" => "Hangup"} = f, state), do: hangup(f, state)
  defp frame(%{"event" => _}, state), do: state

  defp frame(%{"response" => response, "actionid" => id} = f, state) do
    case Map.get(state.pending, id) do
      nil -> state
      entry -> response(entry, id, response, f, state)
    end
  end

  defp frame(_frame, state), do: state

  defp response(%{kind: :login} = entry, id, "Success", _f, state) do
    cancel(entry)

    Logger.info("AMI logged in to Asterisk at #{state.host}:#{state.port}")
    set_ready(true)
    schedule_ping(state)

    %{state | phase: :ready, backoff_ms: state.first_backoff_ms, down_logged: false}
    |> Map.update!(:pending, &Map.delete(&1, id))
  end

  defp response(%{kind: :login}, _id, _response, f, state),
    do: drop(state, "login refused: #{f["message"] || "no reason given"}")

  defp response(%{kind: :command} = entry, id, response, f, state) do
    cancel(entry)

    reply =
      if response in ["Success", "Follows"],
        do: {:ok, f["output"] || ""},
        else: {:error, f["message"] || response}

    GenServer.reply(entry.from, reply)
    %{state | pending: Map.delete(state.pending, id)}
  end

  defp response(%{kind: :ping} = entry, id, _response, _f, state) do
    cancel(entry)
    schedule_ping(state)
    %{state | pending: Map.delete(state.pending, id)}
  end

  # An originate queued: its OriginateResponse follows. Refused at once: not placed, so not answered.
  defp response(%{kind: :originate}, _id, "Success", _f, state), do: state

  defp response(%{kind: :originate} = entry, id, _response, f, state) do
    Logger.warning("call #{id} refused by Asterisk: #{f["message"] || "no reason given"}")
    not_answered(%{state | pending: Map.delete(state.pending, id)}, entry, "FAILURE")
  end

  defp originate_response(%{"actionid" => id} = f, state) do
    case Map.get(state.pending, id) do
      %{kind: :originate, answered_at: nil} = entry ->
        cancel(entry)

        if f["response"] == "Success" do
          uniqueid = f["uniqueid"]

          entry = %{
            entry
            | answered_at: now(),
              answered_mono: mono(),
              uniqueid: uniqueid,
              timer: timer({:max_call, id}, state.max_call_ms)
          }

          %{
            state
            | pending: Map.put(state.pending, id, entry),
              calls: Map.put(state.calls, uniqueid, id)
          }
        else
          not_answered(
            %{state | pending: Map.delete(state.pending, id)},
            entry,
            Ami.reason_cause(f["reason"])
          )
        end

      _ ->
        state
    end
  end

  defp originate_response(_f, state), do: state

  defp hangup(%{"uniqueid" => uniqueid} = f, state) do
    with {id, calls} when is_binary(id) <- Map.pop(state.calls, uniqueid),
         {%{} = entry, pending} <- Map.pop(state.pending, id) do
      cancel(entry)
      ended(%{state | calls: calls, pending: pending}, id, entry, Ami.hangup_cause(f))
    else
      _ -> state
    end
  end

  defp hangup(_f, state), do: state

  # ---------------------------------------------------------------- outcomes

  defp not_answered(state, entry, cause) do
    GenServer.reply(
      entry.from,
      {:ok,
       %{
         answered: false,
         cause: cause,
         placed_at: entry.placed_at,
         answered_at: nil,
         ended_at: now(),
         duration_ms: 0
       }}
    )

    state
  end

  defp ended(state, _id, entry, cause) do
    GenServer.reply(
      entry.from,
      {:ok,
       %{
         answered: true,
         cause: cause,
         placed_at: entry.placed_at,
         answered_at: entry.answered_at,
         ended_at: now(),
         duration_ms: max(0, mono() - entry.answered_mono)
       }}
    )

    %{state | calls: Map.delete(state.calls, entry.uniqueid)}
  end

  defp no_response(%{kind: :originate} = entry, id, state) do
    Logger.warning("call #{id}: no answer from Asterisk in time, counted as not answered")
    not_answered(state, entry, "NO_RESPONSE")
  end

  defp no_response(%{kind: :command} = entry, _id, state) do
    GenServer.reply(entry.from, {:error, :timeout})
    state
  end

  # A ping or the login not answered: the connection is not working.
  defp no_response(%{kind: kind}, _id, state), do: drop(state, "no answer to #{kind}")

  # ---------------------------------------------------------------- connection

  defp drop(state, why) do
    if state.socket, do: :gen_tcp.close(state.socket)
    set_ready(false)
    state = finish_pending(%{state | socket: nil, phase: :disconnected, buffer: ""})
    retry(state, why)
  end

  # Every waiting caller gets its answer: a call not answered yet as not answered, an answered one as ended now.
  defp finish_pending(state) do
    Enum.each(state.pending, fn {_id, entry} ->
      cancel(entry)

      case entry do
        %{kind: :originate, answered_at: nil} -> not_answered(state, entry, "AMI_DISCONNECTED")
        %{kind: :originate} -> ended(state, nil, entry, "UNKNOWN")
        %{kind: :command} -> GenServer.reply(entry.from, {:error, :not_connected})
        _ -> :ok
      end
    end)

    %{state | pending: %{}, calls: %{}}
  end

  defp retry(state, why) do
    if state.down_logged,
      do: Logger.debug("AMI: #{why}; trying again in #{state.backoff_ms} ms"),
      else:
        Logger.warning(
          "AMI: #{why}; calls wait until Asterisk is back (trying again in #{state.backoff_ms} ms)"
        )

    Process.send_after(self(), :connect, state.backoff_ms)
    %{state | backoff_ms: min(state.backoff_ms * 2, state.max_backoff_ms), down_logged: true}
  end

  defp send_frame(%{socket: socket} = state, fields) do
    case :gen_tcp.send(socket, Ami.encode(fields)) do
      :ok -> state
      # The closed message follows and drops the connection; the caller is answered then.
      {:error, _reason} -> state
    end
  end

  defp put_pending(state, id, entry), do: %{state | pending: Map.put(state.pending, id, entry)}

  defp next_id(state, prefix), do: {"#{prefix}-#{state.seq + 1}", %{state | seq: state.seq + 1}}

  defp schedule_ping(state), do: Process.send_after(self(), :ping, state.ping_ms)

  defp timer(message, ms), do: Process.send_after(self(), message, ms)

  defp cancel(%{timer: timer}) when is_reference(timer) do
    _ = Process.cancel_timer(timer)
    :ok
  end

  defp cancel(_entry), do: :ok

  defp set_ready(ready) do
    if :persistent_term.get(@ready, nil) != ready, do: :persistent_term.put(@ready, ready)
    :ok
  end

  defp noreply(state), do: {:noreply, state}

  defp now, do: System.os_time(:millisecond)
  defp mono, do: System.monotonic_time(:millisecond)
end
