defmodule Sms.Switch.Commands.Pcap do
  @moduledoc """
  Signaling captures and the traffic recording on this switch server (spec §9.2, backend step 11c). Each server
  records its own SMPP traffic, so every command runs on both and the screen joins their files (pcapng files simply
  follow one another: Wireshark reads each as a section).

    * **Recording** (`pcap_files`): the 15-minute files `dumpcap` writes outside the switch (deploy/ansible
      `roles/pcap`), listed with each file's quarter and size, and read by the PCAP Trace screen. A finished file is
      gzipped (`.pcapng.gz`, which Wireshark and tshark read as is); after 60 days it moves to off-site storage for
      60 more (product owner 2026-10-27). Moved files stay listed from the archive job's index (`archive.index`) and
      are fetched back into the captures folder (`sms-pcap-fetch`) when read or extracted.
    * **Live capture** (`pcap_capture`, `pcap_stop`): `dumpcap` from now on, for at most the duration and size asked,
      optionally only one address or range.
    * **Recording extract** (`pcap_extract`): a past window cut from the ring with `tshark` (by address, number or
      message id) and joined with `mergecap`.
    * `pcap_status`, `pcap_read` (a file in chunks of at most 512 KB, base64), `pcap_delete`.

  Captures and extracts are written to `capture_dir` as `capture-<id>.pcapng`. Tools and folders are configured under
  `config :sms_switch, Sms.Switch.Commands` (`tools`, `ring_dir`, `capture_dir`); every tool runs with an argument list,
  never a shell.
  """
  use GenServer
  require Logger
  alias Sms.Switch.Commands

  @chunk_max 524_288
  # SMPP only: not SSH, the web and the API (deploy/ansible roles/pcap uses the same filter for the recording).
  @base_filter "tcp and not port 22 and not port 443 and not port 80"
  @ring_name ~r/^[A-Za-z0-9_-]+_\d{5}_(\d{14})\.pcapng(?:\.gz)?$/
  @capture_name ~r/^capture-(\d+)\.pcapng$/
  @safe_value ~r/^[A-Za-z0-9+_.:@-]{1,64}$/

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Runs one PCAP command."
  @spec handle(String.t(), map()) :: {:ok, map()} | {:error, term()}
  def handle("pcap_files", _data), do: {:ok, %{files: ring_files()}}
  def handle("pcap_read", data), do: read(data)
  def handle(name, data), do: GenServer.call(__MODULE__, {name, data}, 30_000)

  # ---------------------------------------------------------------- server

  @impl true
  def init(_opts), do: {:ok, %{running: %{}}}

  @impl true
  def handle_call({"pcap_capture", data}, _from, state) do
    with {:ok, id} <- id(data["id"]),
         :ok <- not_running(state, id),
         {:ok, filter} <- bpf(data["ip_filter"]),
         {:ok, seconds} <- int(data["max_duration_s"], 1..3600, "max_duration_s"),
         {:ok, bytes} <- int(data["max_bytes"], 1024..104_857_600, "max_bytes"),
         :ok <- File.mkdir_p(capture_dir()) do
      args = ["-q", "-i", "any", "-s", "0", "-f", filter, "-a", "duration:#{seconds}"]
      args = args ++ ["-a", "filesize:#{max(div(bytes, 1000), 1)}", "-w", capture_file(id)]
      start_capture(state, id, args)
    else
      {:error, _} = error -> {:reply, error, state}
    end
  end

  def handle_call({"pcap_extract", data}, _from, state) do
    with {:ok, id} <- id(data["id"]),
         :ok <- not_running(state, id),
         {:ok, from} <- time(data["from"], "from"),
         {:ok, to} <- time(data["to"], "to"),
         {:ok, filter} <- display_filter(from, to, data),
         :ok <- File.mkdir_p(capture_dir()) do
      # Names: a file moved off-site is fetched in the task, not here.
      files = covering(from, to)
      task = Task.async(fn -> safe_extract(id, files, filter) end)
      {:reply, {:ok, %{started: true, files: length(files)}}, track(state, id, {:task, task})}
    else
      {:error, _} = error -> {:reply, error, state}
    end
  end

  def handle_call({"pcap_stop", data}, _from, state) do
    case id(data["id"]) do
      {:ok, id} ->
        _ = stop(state.running[id])
        {:reply, {:ok, %{stopped: true}}, %{state | running: Map.delete(state.running, id)}}

      {:error, _} = error ->
        {:reply, error, state}
    end
  end

  def handle_call({"pcap_status", data}, _from, state) do
    case ids(data["ids"]) do
      {:ok, ids} -> {:reply, {:ok, %{captures: Enum.map(ids, &status(state, &1))}}, state}
      error -> {:reply, error, state}
    end
  end

  def handle_call({"pcap_delete", data}, _from, state) do
    case ids(data["ids"]) do
      {:ok, ids} ->
        for id <- ids, not Map.has_key?(state.running, id), do: _ = File.rm(capture_file(id))
        {:reply, {:ok, %{deleted: length(ids)}}, state}

      error ->
        {:reply, error, state}
    end
  end

  def handle_call({name, _data}, _from, state),
    do: {:reply, {:error, {:unknown_command, name}}, state}

  @impl true
  # A capture's dumpcap ended (duration or size reached, or stopped).
  def handle_info({port, {:exit_status, code}}, state) when is_port(port) do
    {done, running} = Enum.split_with(state.running, fn {_id, r} -> r == {:port, port} end)

    for {id, _} <- done,
        code != 0,
        do: Logger.warning("capture #{id}: dumpcap ended with #{code}")

    {:noreply, %{state | running: Map.new(running)}}
  end

  def handle_info({port, {:data, _}}, state) when is_port(port), do: {:noreply, state}

  # An extract finished (its result is the file).
  def handle_info({ref, result}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    if result != :ok, do: Logger.warning("recording extract failed: #{inspect(result)}")

    {:noreply,
     %{
       state
       | running: Map.reject(state.running, fn {_, r} -> match?({:task, %{ref: ^ref}}, r) end)
     }}
  end

  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    {:noreply,
     %{
       state
       | running: Map.reject(state.running, fn {_, r} -> match?({:task, %{ref: ^ref}}, r) end)
     }}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  defp start_capture(state, id, args) do
    case spawn_tool("dumpcap", args) do
      {:port, _} = port -> {:reply, {:ok, %{started: true}}, track(state, id, port)}
      {:error, reason} -> {:reply, {:error, "dumpcap could not start: #{reason}"}, state}
    end
  end

  defp stop({:port, port}), do: terminate_port(port)
  defp stop({:task, task}), do: Task.shutdown(task, :brutal_kill)
  defp stop(nil), do: :ok

  defp track(state, id, running), do: %{state | running: Map.put(state.running, id, running)}

  defp not_running(state, id),
    do:
      if(Map.has_key?(state.running, id),
        do: {:error, {:bad_input, "capture #{id} is already running"}},
        else: :ok
      )

  defp status(state, id) do
    file = capture_file(id)
    running = Map.has_key?(state.running, id)

    case File.stat(file, time: :posix) do
      {:ok, stat} ->
        %{
          id: id,
          running: running,
          exists: true,
          size: stat.size,
          packets: if(running, do: 0, else: packets(file))
        }

      {:error, _} ->
        %{id: id, running: running, exists: false, size: 0, packets: 0}
    end
  end

  # ---------------------------------------------------------------- the recording

  @doc false
  # The recording's files, oldest first: name, the quarter it starts at (the server's clock is UTC) and size; those
  # here and those moved off-site.
  @spec ring_files() :: [map()]
  def ring_files do
    local =
      case File.ls(ring_dir()) do
        {:ok, names} -> Enum.flat_map(names, &ring_file/1)
        {:error, _} -> []
      end

    here = MapSet.new(local, &plain(&1.name))

    (local ++ Enum.reject(archived_files(), &MapSet.member?(here, plain(&1.name))))
    |> Enum.sort_by(& &1.started_at)
  end

  defp plain(name), do: String.replace_suffix(name, ".gz", "")

  @doc false
  # Files moved off-site, from the index the archive job writes (deploy/ansible roles/pcap, sms-pcap-archive): a name
  # and its size per line, a tab between.
  @spec archived_files() :: [map()]
  def archived_files do
    case File.read(Path.join(ring_dir(), "archive.index")) do
      {:ok, text} ->
        for line <- String.split(text, "\n", trim: true),
            [name, size] <- [String.split(line, "\t")],
            [_, stamp] <- [Regex.run(@ring_name, name)],
            {:ok, started} <- [stamp_time(stamp)],
            {bytes, ""} <- [Integer.parse(size)] do
          at = DateTime.to_iso8601(started)
          %{name: name, started_at: at, size: bytes, modified_at: at}
        end

      {:error, _} ->
        []
    end
  end

  defp ring_file(name) do
    with [_, stamp] <- Regex.run(@ring_name, name),
         {:ok, started} <- stamp_time(stamp),
         {:ok, stat} <- File.stat(Path.join(ring_dir(), name), time: :posix) do
      [
        %{
          name: name,
          started_at: DateTime.to_iso8601(started),
          size: stat.size,
          modified_at: iso(stat.mtime)
        }
      ]
    else
      _ -> []
    end
  end

  defp stamp_time(
         <<y::binary-4, mo::binary-2, d::binary-2, h::binary-2, mi::binary-2, s::binary-2>>
       ) do
    with {:ok, naive} <- NaiveDateTime.from_iso8601("#{y}-#{mo}-#{d}T#{h}:#{mi}:#{s}"),
         do: DateTime.from_naive(naive, "Etc/UTC")
  end

  defp iso(posix), do: posix |> DateTime.from_unix!() |> DateTime.to_iso8601()

  # The ring files that may hold packets of [from, to]: those starting before `to` whose next file starts after `from`.
  defp covering(from, to) do
    files = ring_files()
    starts = Enum.map(files, &elem(DateTime.from_iso8601(&1.started_at), 1))

    files
    |> Enum.zip(Enum.drop(starts, 1) ++ [nil])
    |> Enum.zip(starts)
    |> Enum.filter(fn {{_f, next}, start} ->
      DateTime.compare(start, to) == :lt and (next == nil or DateTime.compare(next, from) == :gt)
    end)
    |> Enum.map(fn {{f, _}, _} -> f.name end)
  end

  # A recording file on this server: in the recording folder (gzipped since it was listed, maybe), or fetched back
  # from off-site storage into the captures folder, where the archive job removes it after a day.
  defp recording_path(name) do
    local = Path.join(ring_dir(), name)
    cached = Path.join([capture_dir(), "archive", name])

    cond do
      File.exists?(local) -> {:ok, local}
      File.exists?(local <> ".gz") -> {:ok, local <> ".gz"}
      File.exists?(cached) -> {:ok, cached}
      Enum.any?(archived_files(), &(&1.name == name)) -> fetch(name, cached)
      true -> {:error, {:not_found, "the file is not on #{Commands.node_id()}"}}
    end
  end

  # Under another name until complete, so a fetch that fails never leaves half a file to read.
  defp fetch(name, dest) do
    part = dest <> ".part"
    File.mkdir_p!(Path.dirname(dest))

    case run_tool("sms-pcap-fetch", [name, part]) do
      {_, 0} ->
        File.rename!(part, dest)
        {:ok, dest}

      {out, code} ->
        _ = File.rm(part)

        {:error,
         "could not fetch #{name} from off-site storage (#{code}): #{String.slice(out, 0, 200)}"}
    end
  end

  # An extract that fails leaves no file and never takes the server down with it.
  defp safe_extract(id, files, filter) do
    extract(id, files, filter)
  rescue
    e -> {:error, Exception.message(e)}
  end

  defp extract(id, [], _filter), do: write_empty(capture_file(id))

  defp extract(id, files, filter) do
    tmp = Path.join(capture_dir(), "extract-#{id}")
    File.mkdir_p!(tmp)

    try do
      parts =
        for {name, i} <- Enum.with_index(files) do
          file =
            case recording_path(name) do
              {:ok, path} -> path
              {:error, {_, reason}} -> raise reason
              {:error, reason} -> raise reason
            end

          out = Path.join(tmp, "#{i}.pcapng")
          ok!(run_tool("tshark", ["-r", file, "-Y", filter, "-w", out]), "tshark")
          out
        end

      ok!(run_tool("mergecap", ["-w", capture_file(id) | parts]), "mergecap")
      :ok
    after
      File.rm_rf(tmp)
    end
  end

  defp ok!({_out, 0}, _tool), do: :ok

  defp ok!({out, code}, tool),
    do: raise("#{tool} ended with #{code}: #{String.slice(out, 0, 300)}")

  # An extract with no recording in its window: an empty file, so the screen says so instead of failing.
  defp write_empty(file) do
    File.write!(file, "")
    :ok
  end

  # ---------------------------------------------------------------- files

  defp read(data) do
    with {:ok, path} <- readable(data["file"]),
         {:ok, offset} <- int(data["offset"] || 0, 0..1_000_000_000_000, "offset"),
         {:ok, length} <- int(data["length"] || @chunk_max, 1..@chunk_max, "length"),
         {:ok, stat} <- stat(path),
         {:ok, bytes} <- chunk(path, offset, length) do
      {:ok,
       %{data: Base.encode64(bytes), size: stat.size, eof: offset + byte_size(bytes) >= stat.size}}
    end
  end

  # A capture or extract (`capture-<id>.pcapng`) or a recording file; nothing else, never a path.
  defp readable(name) when is_binary(name) do
    cond do
      Regex.match?(@capture_name, name) -> {:ok, Path.join(capture_dir(), name)}
      Regex.match?(@ring_name, name) -> recording_path(name)
      true -> {:error, {:bad_input, "no such capture or recording file"}}
    end
  end

  defp readable(_), do: {:error, {:bad_input, "no such capture or recording file"}}

  defp stat(path) do
    case File.stat(path) do
      {:ok, stat} ->
        {:ok, stat}

      {:error, :enoent} ->
        {:error, {:not_found, "the file is not on #{Commands.node_id()}"}}

      {:error, reason} ->
        {:error, "cannot read the file: #{reason}"}
    end
  end

  defp chunk(path, offset, length) do
    File.open(path, [:read, :binary], fn io ->
      case :file.pread(io, offset, length) do
        {:ok, bytes} -> bytes
        :eof -> <<>>
        {:error, reason} -> raise "read failed: #{inspect(reason)}"
      end
    end)
  end

  defp packets(file) do
    case run_tool("capinfos", ["-c", "-M", "-T", "-r", file]) do
      {out, 0} ->
        out
        |> String.split(["\t", "\n"], trim: true)
        |> List.last()
        |> to_string()
        |> Integer.parse()
        |> elem_or_zero()

      _ ->
        0
    end
  end

  defp elem_or_zero({n, _}), do: n
  defp elem_or_zero(_), do: 0

  # ---------------------------------------------------------------- filters

  @doc false
  # The capture filter (BPF) for a live capture: SMPP traffic, optionally only one address or range.
  @spec bpf(term()) :: {:ok, String.t()} | {:error, term()}
  def bpf(nil), do: {:ok, @base_filter}
  def bpf(""), do: {:ok, @base_filter}

  def bpf(text) when is_binary(text) do
    case address(String.trim(text)) do
      {:host, ip} -> {:ok, "#{@base_filter} and host #{ip}"}
      {:net, net} -> {:ok, "#{@base_filter} and net #{net}"}
      :error -> {:error, {:bad_input, "ip_filter must be an IPv4 / IPv6 address or range"}}
    end
  end

  def bpf(_), do: {:error, {:bad_input, "ip_filter must be an IPv4 / IPv6 address or range"}}

  defp address(text) do
    case String.split(text, "/") do
      [ip] -> if ip?(ip), do: {:host, ip}, else: :error
      [ip, bits] -> net(ip, Integer.parse(bits))
      _ -> :error
    end
  end

  defp net(ip, {n, ""}) when n >= 0 do
    max = if String.contains?(ip, ":"), do: 128, else: 32
    if n <= max and ip?(ip), do: {:net, "#{ip}/#{n}"}, else: :error
  end

  defp net(_ip, _bits), do: :error

  defp ip?(text), do: match?({:ok, _}, :inet.parse_strict_address(String.to_charlist(text)))

  @doc false
  # The display filter (tshark -Y) for a recording extract: the window, and every criterion given (AND).
  @spec display_filter(DateTime.t(), DateTime.t(), map()) :: {:ok, String.t()} | {:error, term()}
  def display_filter(from, to, data) do
    window =
      "frame.time_epoch >= #{DateTime.to_unix(from)} && frame.time_epoch < #{DateTime.to_unix(to)}"

    with true <-
           DateTime.compare(to, from) == :gt || {:error, {:bad_input, "to must be after from"}},
         {:ok, addrs} <- addresses(data["ip_filters"] || []),
         {:ok, number} <- safe(data["number"], "number"),
         {:ok, msg_id} <- safe(data["message_id"], "message_id") do
      parts =
        [
          window,
          addrs,
          number && ~s(smpp.source_addr == "#{number}" || smpp.destination_addr == "#{number}"),
          msg_id &&
            ~s(smpp.message_id == "#{msg_id}" || smpp.receipted_message_id == "#{msg_id}" || frame contains "id:#{msg_id}")
        ]
        |> Enum.reject(&(&1 in [nil, ""]))

      {:ok, Enum.map_join(parts, " && ", &"(#{&1})")}
    end
  end

  defp addresses(list) when is_list(list) and length(list) <= 50 do
    Enum.reduce_while(list, {:ok, []}, fn text, {:ok, acc} ->
      case is_binary(text) && address(String.trim(text)) do
        {:host, ip} -> {:cont, {:ok, [field(ip) <> " == " <> ip | acc]}}
        {:net, net} -> {:cont, {:ok, [field(net) <> " == " <> net | acc]}}
        _ -> {:halt, {:error, {:bad_input, "ip_filters must be IPv4 / IPv6 addresses or ranges"}}}
      end
    end)
    |> case do
      {:ok, []} -> {:ok, nil}
      {:ok, terms} -> {:ok, terms |> Enum.reverse() |> Enum.join(" || ")}
      error -> error
    end
  end

  defp addresses(_),
    do: {:error, {:bad_input, "ip_filters must be a list of at most 50 addresses"}}

  defp field(addr), do: if(String.contains?(addr, ":"), do: "ipv6.addr", else: "ip.addr")

  defp safe(nil, _name), do: {:ok, nil}
  defp safe("", _name), do: {:ok, nil}

  defp safe(text, name) when is_binary(text) do
    text = String.trim(text)

    if Regex.match?(@safe_value, text),
      do: {:ok, text},
      else: {:error, {:bad_input, "#{name} may hold letters, digits and + _ . : @ - only"}}
  end

  defp safe(_, name), do: {:error, {:bad_input, "#{name} must be text"}}

  # ---------------------------------------------------------------- helpers

  defp id(n) when is_integer(n) and n > 0, do: {:ok, n}
  defp id(_), do: {:error, {:bad_input, "id must be a positive integer"}}

  defp ids(list) when is_list(list) and length(list) <= 1000 do
    if Enum.all?(list, &(is_integer(&1) and &1 > 0)),
      do: {:ok, list},
      else: {:error, {:bad_input, "ids must be positive integers"}}
  end

  defp ids(_), do: {:error, {:bad_input, "ids must list at most 1000 capture ids"}}

  defp int(n, first..last//_, _name) when is_integer(n) and n >= first and n <= last, do: {:ok, n}

  defp int(_, first..last//_, name),
    do: {:error, {:bad_input, "#{name} must be #{first} to #{last}"}}

  defp time(text, name) when is_binary(text) do
    case DateTime.from_iso8601(text) do
      {:ok, t, _} -> {:ok, t}
      _ -> {:error, {:bad_input, "#{name} must be an ISO 8601 time"}}
    end
  end

  defp time(_, name), do: {:error, {:bad_input, "#{name} must be an ISO 8601 time"}}

  defp capture_file(id), do: Path.join(capture_dir(), "capture-#{id}.pcapng")

  defp spawn_tool(name, args) do
    {:port,
     Port.open({:spawn_executable, executable(name)}, [
       :binary,
       :exit_status,
       :stderr_to_stdout,
       args: args
     ])}
  rescue
    e -> {:error, Exception.message(e)}
  end

  defp terminate_port(port) do
    case Port.info(port, :os_pid) do
      {:os_pid, pid} -> System.cmd("kill", ["-TERM", "#{pid}"])
      nil -> :ok
    end
  end

  defp run_tool(name, args), do: System.cmd(executable(name), args, stderr_to_stdout: true)

  defp executable(name) do
    path = config() |> Keyword.get(:tools, %{}) |> Map.get(name, name)
    System.find_executable(path) || path
  end

  defp ring_dir, do: Keyword.get(config(), :ring_dir, "/var/lib/sms-pcap")
  defp capture_dir, do: Keyword.get(config(), :capture_dir, "/var/lib/sms-pcap/captures")
  defp config, do: Application.get_env(:sms_switch, Sms.Switch.Commands, [])
end
