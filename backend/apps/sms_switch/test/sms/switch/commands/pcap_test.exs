defmodule Sms.Switch.Commands.PcapTest do
  # Signaling captures and the traffic recording on a switch server (backend step 11c, §9.2), with stand-ins for
  # dumpcap, tshark, mergecap and capinfos that write what a real run would and record their arguments.
  use ExUnit.Case, async: false
  alias Sms.Switch.Commands
  alias Sms.Switch.Commands.Pcap

  @moduletag :tmp_dir

  setup %{tmp_dir: tmp} do
    ring = Path.join(tmp, "ring")
    captures = Path.join(tmp, "captures")
    bin = Path.join(tmp, "bin")
    File.mkdir_p!(ring)
    File.mkdir_p!(bin)
    log = Path.join(tmp, "args.log")

    stub = fn name, body ->
      path = Path.join(bin, name)
      File.write!(path, ~s(#!/bin/bash\necho "#{name} $*" >> "#{log}"\n) <> body)
      File.chmod!(path, 0o755)
      path
    end

    tools = %{
      # Writes the file named after -w, then runs for the duration asked (-a duration:N).
      "dumpcap" =>
        stub.("dumpcap", """
        out=""; dur=1; prev=""
        for a in "$@"; do
          [ "$prev" = "-w" ] && out="$a"
          case "$a" in duration:*) dur="${a#duration:}";; esac
          prev="$a"
        done
        printf 'PCAPNG' > "$out"
        sleep "$dur"
        """),
      # Copies -r to -w (every packet matches).
      "tshark" =>
        stub.("tshark", """
        in=""; out=""; prev=""
        for a in "$@"; do
          [ "$prev" = "-r" ] && in="$a"; [ "$prev" = "-w" ] && out="$a"; prev="$a"
        done
        cp "$in" "$out"
        """),
      # mergecap -w out in...: the inputs one after another.
      "mergecap" => stub.("mergecap", "out=\"$2\"; shift 2; cat \"$@\" > \"$out\"\n"),
      "capinfos" => stub.("capinfos", "echo -e \"file\\t42\"\n")
    }

    previous = Application.get_env(:sms_switch, Commands)

    Application.put_env(:sms_switch, Commands,
      tools: tools,
      ring_dir: ring,
      capture_dir: captures
    )

    on_exit(fn ->
      if previous,
        do: Application.put_env(:sms_switch, Commands, previous),
        else: Application.delete_env(:sms_switch, Commands)
    end)

    start_supervised!(Pcap)
    %{ring: ring, captures: captures, log: log}
  end

  defp ask(name, data), do: Commands.answer(name, Jason.encode!(data))

  defp ring_file(ring, n, stamp, body) do
    name = "smpp_#{String.pad_leading("#{n}", 5, "0")}_#{stamp}.pcapng"
    File.write!(Path.join(ring, name), body)
    name
  end

  defp read_all(name), do: read_all(name, 0, "")

  defp read_all(name, offset, acc) do
    %{ok: true, data: %{data: data, eof: eof}} =
      ask("pcap_read", %{"file" => name, "offset" => offset, "length" => 4})

    bytes = Base.decode64!(data)
    if eof, do: acc <> bytes, else: read_all(name, offset + byte_size(bytes), acc <> bytes)
  end

  test "the recording's files with their quarter and size, oldest first; read in chunks", %{
    ring: ring
  } do
    b = ring_file(ring, 2, "20261025121500", "second-quarter")
    a = ring_file(ring, 1, "20261025120000", "first")
    File.write!(Path.join(ring, "notes.txt"), "not a recording file")

    assert %{ok: true, data: %{files: [first, second]}} = ask("pcap_files", %{})
    assert first.name == a and first.started_at == "2026-10-25T12:00:00Z" and first.size == 5
    assert second.name == b and second.started_at == "2026-10-25T12:15:00Z"
    assert read_all(b) == "second-quarter"
  end

  test "reads only capture and recording files, never a path" do
    for file <- ["../etc/passwd", "/etc/passwd", "capture-1.pcap", nil] do
      assert %{ok: false, error: "no such capture or recording file"} =
               ask("pcap_read", %{"file" => file})
    end

    assert %{ok: false, error: "the file is not on " <> _} =
             ask("pcap_read", %{"file" => "capture-404.pcapng"})
  end

  test "a live capture runs dumpcap with the filter and limits, then reports its file", %{
    log: log
  } do
    assert %{ok: true, data: %{started: true}} =
             ask("pcap_capture", %{
               "id" => 7,
               "ip_filter" => "192.0.2.0/24",
               "max_duration_s" => 1,
               "max_bytes" => 2_000_000
             })

    assert %{ok: false, error: "capture 7 is already running"} =
             ask("pcap_capture", %{
               "id" => 7,
               "ip_filter" => nil,
               "max_duration_s" => 1,
               "max_bytes" => 2048
             })

    assert %{data: %{captures: [%{id: 7, running: true}]}} = ask("pcap_status", %{"ids" => [7]})
    Process.sleep(1_600)

    assert %{data: %{captures: [%{id: 7, running: false, exists: true, size: 6, packets: 42}]}} =
             ask("pcap_status", %{"ids" => [7]})

    args = File.read!(log)
    assert args =~ "-f tcp and not port 22 and not port 443 and not port 80 and net 192.0.2.0/24"
    assert args =~ "-a duration:1 -a filesize:2000"
    assert read_all("capture-7.pcapng") == "PCAPNG"

    assert %{data: %{deleted: 1}} = ask("pcap_delete", %{"ids" => [7]})
    assert %{data: %{captures: [%{exists: false}]}} = ask("pcap_status", %{"ids" => [7]})
  end

  test "a live capture can be stopped" do
    assert %{ok: true} =
             ask("pcap_capture", %{"id" => 8, "max_duration_s" => 30, "max_bytes" => 4096})

    Process.sleep(200)
    assert %{ok: true, data: %{stopped: true}} = ask("pcap_stop", %{"id" => 8})
    assert %{data: %{captures: [%{running: false}]}} = ask("pcap_status", %{"ids" => [8]})
  end

  test "capture input is checked" do
    assert %{ok: false, error: "ip_filter must be" <> _} =
             ask("pcap_capture", %{
               "id" => 9,
               "ip_filter" => "1.2.3.4; rm -rf /",
               "max_duration_s" => 1,
               "max_bytes" => 2048
             })

    assert %{ok: false, error: "max_duration_s must be 1 to 3600"} =
             ask("pcap_capture", %{"id" => 9, "max_duration_s" => 0, "max_bytes" => 2048})

    assert %{ok: false, error: "id must be a positive integer"} = ask("pcap_stop", %{"id" => "x"})

    assert %{ok: false, error: "ids must be positive integers"} =
             ask("pcap_status", %{"ids" => ["x"]})
  end

  test "an extract cuts the window's files with the criteria and joins them", %{
    ring: ring,
    log: log
  } do
    ring_file(ring, 1, "20261025114500", "before|")
    ring_file(ring, 2, "20261025120000", "q1|")
    ring_file(ring, 3, "20261025121500", "q2|")
    ring_file(ring, 4, "20261025123000", "after|")

    assert %{ok: true, data: %{started: true, files: 2}} =
             ask("pcap_extract", %{
               "id" => 11,
               "from" => "2026-10-25T12:05:00Z",
               "to" => "2026-10-25T12:20:00Z",
               "ip_filters" => ["192.0.2.10", "2001:db8::/32"],
               "number" => "4915112345678",
               "message_id" => "abc123"
             })

    wait = fn wait ->
      case ask("pcap_status", %{"ids" => [11]}) do
        %{data: %{captures: [%{running: false, exists: true}]}} -> :ok
        _ -> Process.sleep(50) && wait.(wait)
      end
    end

    wait.(wait)
    assert read_all("capture-11.pcapng") == "q1|q2|"
    args = File.read!(log)
    from = DateTime.to_unix(~U[2026-10-25 12:05:00Z])
    to = DateTime.to_unix(~U[2026-10-25 12:20:00Z])
    assert args =~ "(frame.time_epoch >= #{from} && frame.time_epoch < #{to})"
    assert args =~ "(ip.addr == 192.0.2.10 || ipv6.addr == 2001:db8::/32)"

    assert args =~
             ~s{(smpp.source_addr == "4915112345678" || smpp.destination_addr == "4915112345678")}

    assert args =~ ~s{frame contains "id:abc123"}
  end

  test "an extract with no recording in its window gives an empty file" do
    assert %{ok: true, data: %{files: 0}} =
             ask("pcap_extract", %{
               "id" => 12,
               "from" => "2020-01-01T00:00:00Z",
               "to" => "2020-01-01T01:00:00Z"
             })

    Process.sleep(200)
    assert %{data: %{captures: [%{exists: true, size: 0}]}} = ask("pcap_status", %{"ids" => [12]})
  end

  test "extract criteria are checked so nothing can be slipped into the filter" do
    base = %{"id" => 13, "from" => "2026-10-25T12:00:00Z", "to" => "2026-10-25T13:00:00Z"}

    assert %{ok: false, error: "number may hold" <> _} =
             ask("pcap_extract", Map.put(base, "number", ~s{1" || 1==1 || "}))

    assert %{ok: false, error: "ip_filters must be" <> _} =
             ask("pcap_extract", Map.put(base, "ip_filters", ["x"]))

    assert %{ok: false, error: "to must be after from"} =
             ask("pcap_extract", Map.put(base, "to", "2026-10-25T11:00:00Z"))

    assert %{ok: false, error: "from must be an ISO 8601 time"} =
             ask("pcap_extract", Map.put(base, "from", "yesterday"))
  end
end
