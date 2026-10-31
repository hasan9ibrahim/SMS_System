defmodule Sms.Core.Bus.NatsUnitTest do
  use ExUnit.Case, async: false
  alias Sms.Core.Bus.Nats

  test "NATS_HOSTS becomes one connection setting per server (no Nagle delay), with credentials when given" do
    tcp = [:binary, nodelay: true]

    assert Nats.connection_settings(hosts: "a:4222, b:4223,c") == [
             %{host: "a", port: 4222, tcp_opts: tcp},
             %{host: "b", port: 4223, tcp_opts: tcp},
             %{host: "c", port: 4222, tcp_opts: tcp}
           ]

    assert [%{host: "a", username: "u", password: "p"}] =
             Nats.connection_settings(hosts: "a:1", username: "u", password: "p")
  end

  test "a pool of connections: the first is the main one, any index wraps onto the pool" do
    previous = Application.get_env(:sms_core, Sms.Core.Bus)
    Application.put_env(:sms_core, Sms.Core.Bus, Keyword.put(previous, :connections, 4))
    on_exit(fn -> Application.put_env(:sms_core, Sms.Core.Bus, previous) end)

    assert Nats.connection(0) == Nats.connection()
    assert Nats.connection(4) == Nats.connection()
    assert Nats.connection(1) == :sms_bus_nats_2
    assert Nats.connection(-3) == :sms_bus_nats_4
  end

  test "the stream is file-backed, replicated as configured, with the duplicate window in nanoseconds" do
    stream =
      Nats.stream_config(
        stream: "S",
        subjects: ["sms.>"],
        replicas: 3,
        max_age_days: 7,
        duplicate_window_ms: 120_000
      )

    assert stream.storage == :file
    assert stream.num_replicas == 3
    assert stream.duplicate_window == 120_000_000_000
    assert stream.max_age == 7 * 24 * 3_600_000_000_000
  end

  test "JetStream publish answers: stored, refused, or unexpected" do
    assert Nats.parse_ack(~s({"stream":"SMS","seq":7})) == :ok
    assert Nats.parse_ack(~s({"error":{"code":503}})) == {:error, {:jetstream, %{"code" => 503}}}
    assert Nats.parse_ack("nope") == {:error, {:unexpected_ack, "nope"}}
  end

  test "retry gives up after the last attempt and survives exits" do
    assert Nats.retry(fn -> exit(:boom) end, 1) == {:error, {:exit, :boom}}
    assert Nats.retry(fn -> {:ok, 1} end, 1) == {:ok, 1}
  end

  test "retry waits and tries again while the connection is coming up" do
    {:ok, calls} = Agent.start_link(fn -> 0 end)

    fun = fn ->
      case Agent.get_and_update(calls, &{&1 + 1, &1 + 1}) do
        1 -> {:error, :not_yet}
        n -> {:ok, n}
      end
    end

    assert Nats.retry(fun, 2) == {:ok, 2}
  end

  test "the delivery count comes from the JetStream reply subject" do
    assert Nats.deliveries(%{reply_to: "$JS.ACK.SMS.test-msg.3.10.4.1700000000.0"}) == 3
    assert Nats.deliveries(%{reply_to: "$JS.ACK.short"}) == 1
    assert Nats.deliveries(%{reply_to: nil}) == 1
    assert Nats.deliveries(%{}) == 1
  end

  test "the stream sequence comes from the reply subject, the same on every delivery (S-7.3)" do
    assert Nats.stream_seq(%{reply_to: "$JS.ACK.SMS.test-msg.3.10.4.1700000000.0"}) == 10
    assert Nats.stream_seq(%{reply_to: "$JS.ACK.SMS.test-msg.1.10.9.1700000000.0"}) == 10

    assert Nats.stream_seq(%{reply_to: "$JS.ACK.hub.ACC1.SMS.test-msg.2.77.5.1700000000.0.tok"}) ==
             77

    assert Nats.stream_seq(%{reply_to: "$JS.ACK.SMS.test-msg.1.x.4.1700000000.0"}) == nil
    assert Nats.stream_seq(%{reply_to: "$JS.ACK.short"}) == nil
    assert Nats.stream_seq(%{}) == nil
  end
end
