defmodule Sms.Switch.CommandsTest do
  # Commands from the screens over NATS request/reply (backend step 11c): the answer shape, bind reloads and Network
  # Diagnosis. The subscription itself runs only on the NATS bus (production), so these call the handler directly.
  use ExUnit.Case, async: false
  alias Sms.Switch.Commands
  alias Sms.Switch.Commands.Diagnose

  setup do
    previous = Application.get_env(:sms_switch, Commands)
    on_exit(fn -> restore(previous) end)
    :ok
  end

  defp restore(nil), do: Application.delete_env(:sms_switch, Commands)
  defp restore(value), do: Application.put_env(:sms_switch, Commands, value)

  defp ask(name, data), do: Commands.answer(name, Jason.encode!(data))

  test "the command is the subject's last part; answers carry the node id" do
    assert Commands.command("smscmd.any.diagnose") == "diagnose"
    assert Commands.command("smscmd.node.sms_10_0_0_2.pcap_read") == "pcap_read"
    assert Commands.node_id() =~ ~r/^[A-Za-z0-9_-]+$/

    assert %{ok: true, node: node, data: %{version: _}} = ask("ping", %{})
    assert node == Commands.node_id()
    assert %{ok: true, data: %{version: _}} = Commands.answer("ping", "")
  end

  test "bad requests answer with an error, not a crash" do
    assert %{ok: false, error: "unknown command \"nope\""} = ask("nope", %{})
    assert %{ok: false, error: "the request is not JSON"} = Commands.answer("ping", "{")

    assert %{ok: false, error: "the request must be a JSON object"} =
             Commands.answer("ping", "[1]")

    assert %{ok: false, error: "side must be customer or vendor"} = ask("bind", %{"side" => "x"})
  end

  test "the Gnat server replies with the JSON answer; a crash replies with an error" do
    assert {:reply, json} =
             Commands.request(%{topic: "smscmd.all.ping", body: "{}", reply_to: "_INBOX.1"})

    assert %{"ok" => true, "data" => %{"version" => _}} = Jason.decode!(json)
    assert {:reply, json} = Commands.error(%{topic: "smscmd.all.ping", body: "{}"}, :boom)
    assert %{"ok" => false, "error" => "the command failed on " <> _} = Jason.decode!(json)
  end

  test "bind reloads the side's trunks (nothing to reload where the side is not running)" do
    assert %{ok: true, data: %{reloaded: "customer"}} =
             ask("bind", %{"side" => "customer", "trunk_id" => 1})

    assert %{ok: true, data: %{reloaded: "vendor"}} =
             ask("bind", %{"side" => "vendor", "trunk_id" => 1})
  end

  describe "Network Diagnosis" do
    test "checks its input" do
      assert {:error, {:bad_input, "tool must be" <> _}} =
               Diagnose.run(%{"tool" => "rm", "destination" => "x"})

      assert {:error, {:bad_input, "destination must be" <> _}} =
               Diagnose.run(%{"tool" => "ping", "destination" => "a b; rm -rf /"})

      assert {:error, {:bad_input, "destination must be" <> _}} =
               Diagnose.run(%{"tool" => "ping"})

      assert {:error, {:bad_input, "source must be" <> _}} =
               Diagnose.run(%{
                 "tool" => "ping",
                 "destination" => "example.com",
                 "source" => "nope"
               })

      assert {:error, {:bad_input, "count must be" <> _}} =
               Diagnose.run(%{"tool" => "ping", "destination" => "example.com", "count" => 50})

      assert {:error, {:bad_input, "telnet needs a port" <> _}} =
               Diagnose.run(%{"tool" => "telnet", "destination" => "example.com"})
    end

    test "a source address this server does not have is left to the server that has it" do
      assert {:ok, :skip} =
               Diagnose.run(%{
                 "tool" => "ping",
                 "destination" => "192.0.2.1",
                 "source" => "192.0.2.77"
               })

      assert Diagnose.local?("127.0.0.1")
    end

    test "runs the tool with an argument list and returns its output and exit code" do
      Application.put_env(:sms_switch, Commands, tools: %{"ping" => "echo", "mtr" => "false"})

      assert {:ok, result} =
               Diagnose.run(%{
                 "tool" => "ping",
                 "destination" => "192.0.2.1",
                 "count" => 2,
                 "source" => "127.0.0.1"
               })

      assert result.command == "ping -n -c 2 -W 2 -I 127.0.0.1 192.0.2.1"
      # The stub is echo, which takes the -n itself and prints the rest.
      assert result.lines == ["-c 2 -W 2 -I 127.0.0.1 192.0.2.1"]
      assert result.exit_code == 0 and is_integer(result.duration_ms)

      assert {:ok, %{exit_code: 1, command: "mtr --report --no-dns -c 4 example.com"}} =
               Diagnose.run(%{"tool" => "mtr", "destination" => "example.com"})
    end

    test "a tool not installed answers with exit code 127" do
      Application.put_env(:sms_switch, Commands, tools: %{"timeout" => "/nonexistent/timeout"})

      assert {:ok, %{exit_code: 127, lines: ["traceroute is not installed" <> _]}} =
               Diagnose.run(%{"tool" => "traceroute", "destination" => "192.0.2.1"})
    end

    test "telnet is a TCP connect: open and refused ports" do
      {:ok, listen} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
      {:ok, port} = :inet.port(listen)

      assert {:ok,
              %{exit_code: 0, lines: ["Trying 127.0.0.1...", "Connected to 127.0.0.1.", _]} = open} =
               Diagnose.run(%{
                 "tool" => "telnet",
                 "destination" => "127.0.0.1",
                 "port" => port,
                 "source" => "127.0.0.1"
               })

      assert open.command == "telnet -b 127.0.0.1 127.0.0.1 #{port}"
      :gen_tcp.close(listen)

      assert {:ok,
              %{exit_code: 1, lines: [_, "Unable to connect to remote host: Connection refused"]}} =
               Diagnose.run(%{"tool" => "telnet", "destination" => "127.0.0.1", "port" => port})
    end
  end
end
