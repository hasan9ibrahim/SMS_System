defmodule Sms.Switch.Test.FakeAmi do
  @moduledoc """
  A fake Asterisk manager interface for tests (§8 SMS to voice; fake data, no Asterisk): listens on 127.0.0.1 (a free
  port, or `port:`), greets each connection as Asterisk does (`banner:` to greet otherwise), checks the login (`user:` / `secret:`, by default
  `fake-ami` / `fake-ami-secret`) and answers actions. Every action is reported to the owner as
  `{:ami, action, fields}` (`action` in lower case, `fields` with lower-case keys).

  Calls (`Originate`) follow the script set with `calls/2`, one entry per call, the last one for the rest:

    * `{:answer, hangup_after_ms, cause}`: `OriginateResponse` Success, then the channel's `Hangup` after that long
      with that Q.850 cause (default `{:answer, 20, "16"}`);
    * `{:fail, reason}`: `OriginateResponse` Failure with that `Reason` (`"3"` no answer, `"5"` busy, …);
    * `:refuse`: the action's own answer is an error;
    * `:silent`: queued, then nothing.

  `set/3`: `:command` (`:ok`, `{:error, message}` or `:silent`), `:ping` (`:answer` or `:silent`). `drop/1` closes every
  connection (Asterisk restarting).
  """
  use GenServer

  @defaults %{command: :ok, ping: :answer}

  def start(opts \\ []) do
    {:ok, pid} = GenServer.start(__MODULE__, Keyword.put(opts, :owner, self()))
    pid
  end

  def stop(ami), do: GenServer.stop(ami)
  def port(ami), do: GenServer.call(ami, :port)
  def calls(ami, script), do: GenServer.call(ami, {:calls, script})
  def set(ami, key, value), do: GenServer.call(ami, {:set, key, value})
  def drop(ami), do: GenServer.call(ami, :drop)

  @doc "The login the fake accepts, as `Sms.Switch.Voice.AmiClient` options."
  def client_opts(ami),
    do: [
      host: "127.0.0.1",
      port: port(ami),
      user: "fake-ami",
      secret: "fake-ami-secret",
      backoff_ms: 50
    ]

  # ---------------------------------------------------------------- server

  @impl true
  def init(opts) do
    # No Nagle delay: each answer goes at once, so call timings are what the test scripts.
    base = [
      :binary,
      active: false,
      packet: :raw,
      reuseaddr: true,
      nodelay: true,
      ip: {127, 0, 0, 1}
    ]

    {:ok, listen} = :gen_tcp.listen(Keyword.get(opts, :port, 0), base)
    {:ok, {_, port}} = :inet.sockname(listen)
    server = self()
    spawn_link(fn -> accept(server, listen) end)

    {:ok,
     %{
       owner: Keyword.fetch!(opts, :owner),
       listen: listen,
       port: port,
       user: Keyword.get(opts, :user, "fake-ami"),
       secret: Keyword.get(opts, :secret, "fake-ami-secret"),
       banner: Keyword.get(opts, :banner, "Asterisk Call Manager/9.0.0"),
       script: [{:answer, 20, "16"}],
       behaviour: @defaults,
       connections: [],
       calls: 0
     }}
  end

  @impl true
  def handle_call(:port, _from, state), do: {:reply, state.port, state}
  def handle_call({:calls, script}, _from, state), do: {:reply, :ok, %{state | script: script}}

  def handle_call({:set, key, value}, _from, state),
    do: {:reply, :ok, put_in(state.behaviour[key], value)}

  def handle_call(:drop, _from, state) do
    Enum.each(state.connections, &send(&1, :close))
    {:reply, :ok, %{state | connections: []}}
  end

  def handle_call({:connected, pid}, _from, state) do
    Process.monitor(pid)

    {:reply, {state.owner, state.user, state.secret, state.banner},
     %{state | connections: [pid | state.connections]}}
  end

  # The next call's behaviour and its number.
  def handle_call(:next_call, _from, state) do
    {behaviour, rest} =
      case state.script do
        [last] -> {last, [last]}
        [next | rest] -> {next, rest}
      end

    {:reply, {behaviour, state.calls + 1}, %{state | script: rest, calls: state.calls + 1}}
  end

  def handle_call({:behaviour, key}, _from, state), do: {:reply, state.behaviour[key], state}

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, _}, state),
    do: {:noreply, %{state | connections: List.delete(state.connections, pid)}}

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    :gen_tcp.close(state.listen)
    Enum.each(state.connections, &send(&1, :close))
  end

  defp accept(server, listen) do
    case :gen_tcp.accept(listen) do
      {:ok, socket} ->
        pid = spawn(fn -> connection(server) end)
        :ok = :gen_tcp.controlling_process(socket, pid)
        send(pid, {:socket, socket})
        accept(server, listen)

      {:error, _} ->
        :ok
    end
  end

  # ---------------------------------------------------------------- one connection

  defp connection(server) do
    receive do
      {:socket, socket} ->
        {owner, user, secret, banner} = GenServer.call(server, {:connected, self()})
        :ok = :gen_tcp.send(socket, banner <> "\r\n")
        :ok = :inet.setopts(socket, active: true)

        loop(%{
          server: server,
          owner: owner,
          user: user,
          secret: secret,
          socket: socket,
          buffer: ""
        })
    end
  end

  defp loop(c) do
    receive do
      {:tcp, _socket, data} ->
        {frames, rest} = frames(c.buffer <> data)
        Enum.each(frames, &action(&1, c))
        loop(%{c | buffer: rest})

      {:send, frame} ->
        _ = :gen_tcp.send(c.socket, frame)
        loop(c)

      :close ->
        :gen_tcp.close(c.socket)

      {:tcp_closed, _} ->
        :ok
    end
  end

  defp frames(buffer) do
    parts = String.split(buffer, "\r\n\r\n")
    {complete, [rest]} = Enum.split(parts, -1)

    {Enum.map(complete, fn frame ->
       for line <- String.split(frame, "\r\n"),
           [k, v] <- [String.split(line, ": ", parts: 2)],
           into: %{},
           do: {String.downcase(k), v}
     end), rest}
  end

  defp action(f, c) do
    name = String.downcase(f["action"] || "")
    send(c.owner, {:ami, name, f})
    answer(name, f, c)
  end

  defp answer("login", f, c) do
    if f["username"] == c.user and f["secret"] == c.secret do
      reply(c, [
        {"Response", "Success"},
        {"ActionID", f["actionid"]},
        {"Message", "Authentication accepted"}
      ])

      reply(c, [{"Event", "FullyBooted"}, {"Privilege", "system,all"}, {"Status", "Fully Booted"}])

      # What a busy Asterisk also sends, none of it about this client's actions: never mistaken for an answer.
      reply(c, [{"Response", "Success"}, {"ActionID", "someone-else"}])

      reply(c, [
        {"Event", "OriginateResponse"},
        {"ActionID", "someone-else:1"},
        {"Response", "Success"}
      ])

      reply(c, [{"Event", "OriginateResponse"}, {"Response", "Failure"}])
      reply(c, [{"Event", "Hangup"}, {"Cause", "16"}])
      reply(c, [{"Message", "a frame with neither event nor response"}])
    else
      reply(c, [
        {"Response", "Error"},
        {"ActionID", f["actionid"]},
        {"Message", "Authentication failed"}
      ])
    end
  end

  defp answer("ping", f, c) do
    if GenServer.call(c.server, {:behaviour, :ping}) == :answer,
      do: reply(c, [{"Response", "Success"}, {"ActionID", f["actionid"]}, {"Ping", "Pong"}])
  end

  defp answer("command", f, c) do
    case GenServer.call(c.server, {:behaviour, :command}) do
      :ok ->
        reply(c, [
          {"Response", "Success"},
          {"ActionID", f["actionid"]},
          {"Message", "Command output follows"},
          {"Output", "Module 'res_pjsip.so' reloaded successfully."}
        ])

      {:error, message} ->
        reply(c, [{"Response", "Error"}, {"ActionID", f["actionid"]}, {"Message", message}])

      :silent ->
        :ok
    end
  end

  defp answer("originate", f, c) do
    id = f["actionid"]
    {behaviour, n} = GenServer.call(c.server, :next_call)

    if behaviour == :refuse do
      reply(c, [{"Response", "Error"}, {"ActionID", id}, {"Message", "Originate failed"}])
    else
      reply(c, [
        {"Response", "Success"},
        {"ActionID", id},
        {"Message", "Originate successfully queued"}
      ])

      # Another channel's end, before this call's answer: never this call's.
      reply(c, [{"Event", "Hangup"}, {"Uniqueid", "other.#{n}"}, {"Cause", "17"}])
      originated(behaviour, id, "fake.#{n}", f, c)
    end
  end

  defp answer(_name, _f, _c), do: :ok

  defp originated({:answer, after_ms, cause}, id, uniqueid, f, c) do
    reply(c, response(id, f, "Success", "4", uniqueid))

    frame =
      encode([
        {"Event", "Hangup"},
        {"Uniqueid", uniqueid},
        {"Cause", cause},
        {"Cause-txt", "Fake cause"}
      ])

    Process.send_after(self(), {:send, frame}, after_ms)
  end

  defp originated({:fail, reason}, id, _uniqueid, f, c),
    do: reply(c, response(id, f, "Failure", reason, "<null>"))

  defp originated(:silent, _id, _uniqueid, _f, _c), do: :ok

  defp response(id, f, response, reason, uniqueid) do
    [
      {"Event", "OriginateResponse"},
      {"Privilege", "call,all"},
      {"ActionID", id},
      {"Response", response},
      {"Channel", f["channel"]},
      {"Context", f["context"]},
      {"Exten", f["exten"]},
      {"Reason", reason},
      {"Uniqueid", uniqueid}
    ]
  end

  defp reply(c, fields) do
    _ = :gen_tcp.send(c.socket, encode(fields))
    :ok
  end

  defp encode(fields),
    do: [Enum.map(fields, fn {k, v} -> [k, ": ", to_string(v), "\r\n"] end), "\r\n"]
end
