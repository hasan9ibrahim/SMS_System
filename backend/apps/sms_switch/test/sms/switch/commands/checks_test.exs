defmodule Sms.Switch.Commands.ChecksTest do
  # What the switch commands refuse and how they word it (backend step 11c, §9.1, §9.2): every input is checked before
  # anything runs, and the screen shows the reason as written here.
  use ExUnit.Case, async: false
  alias Sms.Switch.Commands
  alias Sms.Switch.Commands.{Inject, Pcap}

  defp ask(name, data), do: Commands.answer(name, Jason.encode!(data))

  describe "Network Diagnosis" do
    test "a source address this server does not have is left to the server that has it" do
      assert %{ok: true, skip: true} =
               ask("diagnose", %{
                 "tool" => "ping",
                 "destination" => "192.0.2.1",
                 "source" => "203.0.113.250"
               })
    end

    test "the source, count and port are checked" do
      base = %{"tool" => "ping", "destination" => "192.0.2.1"}

      assert %{ok: false, error: "source must be an IP address" <> _} =
               ask("diagnose", Map.put(base, "source", "srv-a"))

      assert %{ok: false, error: "source must be an IP address" <> _} =
               ask("diagnose", Map.put(base, "source", 7))

      assert %{ok: false, error: "count must be 1 to 20"} =
               ask("diagnose", Map.put(base, "count", 50))

      assert %{ok: false, error: "telnet needs a port 1 to 65535"} =
               ask("diagnose", %{base | "tool" => "telnet"})

      assert %{ok: false, error: "destination must be" <> _} =
               ask("diagnose", %{base | "destination" => "bad host!"})
    end
  end

  test "telnet from a local source address; an unknown host is said so" do
    {:ok, listen} = :gen_tcp.listen(0, ip: {127, 0, 0, 1})
    {:ok, port} = :inet.port(listen)

    assert %{ok: true, data: %{exit_code: 0, command: "telnet -b 127.0.0.1 127.0.0.1 " <> _}} =
             ask("diagnose", %{
               "tool" => "telnet",
               "destination" => "127.0.0.1",
               "source" => "127.0.0.1",
               "port" => port
             })

    :gen_tcp.close(listen)

    assert %{ok: true, data: %{exit_code: 1, lines: [_, "Unable to connect" <> _]}} =
             ask("diagnose", %{"tool" => "telnet", "destination" => "host.invalid", "port" => 25})
  end

  describe "Repush" do
    test "the request is checked before the EDR store is read" do
      assert %{ok: false, error: "request_id" <> _} =
               ask("repush", %{"vendor_trunk_id" => 1, "edr_ids" => []})

      assert %{ok: false, error: "vendor_trunk_id" <> _} =
               ask("repush", %{"request_id" => 1, "edr_ids" => []})
    end

    test "every routing refusal has a reason the screen can show" do
      for reason <- [
            :no_customer_rate,
            :customer_rate_blocked,
            :vendor_rate_blocked,
            :no_rule,
            :blocked,
            :no_vendor,
            :not_ready,
            :multipart
          ] do
        assert reason |> Inject.reason_text() |> String.length() > 5
      end

      assert Inject.reason_text({:bad_input, "receiver must be digits"}) ==
               "receiver must be digits"

      assert Inject.reason_text({:submit_failed, :no_vendor}) ==
               "no vendor qualifies (submit_failed)"

      assert Inject.reason_text({"other", 1}) == ~s({"other", 1})
      assert is_binary(Inject.reason_text(:some_new_reason))
    end
  end

  describe "capture filters" do
    test "a live capture's filter takes one address or range, nothing else" do
      assert {:ok, base} = Pcap.bpf(nil)
      assert {:ok, ^base} = Pcap.bpf("")
      assert {:ok, f} = Pcap.bpf(" 192.0.2.7 ")
      assert f == base <> " and host 192.0.2.7"
      assert {:ok, f6} = Pcap.bpf("2001:db8::/32")
      assert f6 == base <> " and net 2001:db8::/32"

      for bad <- ["192.0.2.0/33", "192.0.2.0/x", "1/2/3", "host x", 42] do
        assert {:error, {:bad_input, _}} = Pcap.bpf(bad)
      end
    end

    test "an extract's criteria must be lists of addresses and plain text" do
      from = ~U[2026-10-25 12:00:00Z]
      to = ~U[2026-10-25 12:15:00Z]

      assert {:ok, "(frame.time_epoch" <> _} =
               Pcap.display_filter(from, to, %{"number" => "", "message_id" => nil})

      assert {:error, {:bad_input, "ip_filters must be a list" <> _}} =
               Pcap.display_filter(from, to, %{"ip_filters" => "192.0.2.1"})

      assert {:error, {:bad_input, "number must be text"}} =
               Pcap.display_filter(from, to, %{"number" => 491_511})
    end
  end

  describe "the capture agent" do
    setup do
      start_supervised!(Pcap)
      :ok
    end

    test "refuses unknown commands and bad ids" do
      assert %{ok: false, error: "unknown command \"pcap_nope\""} = ask("pcap_nope", %{})

      assert %{ok: false, error: "ids must list at most 1000 capture ids"} =
               ask("pcap_status", %{"ids" => "all"})

      assert %{ok: false, error: "from must be an ISO 8601 time"} =
               ask("pcap_extract", %{"id" => 5, "from" => 1, "to" => "2026-10-25T12:00:00Z"})

      # Stopping a capture that is not running is not an error (the other server may have it).
      assert %{ok: true, data: %{stopped: true}} = ask("pcap_stop", %{"id" => 404})
    end
  end
end
