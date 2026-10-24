defmodule Sms.Core.Bus.NatsUnitTest do
  use ExUnit.Case, async: true
  alias Sms.Core.Bus.Nats

  test "NATS_HOSTS becomes one connection setting per server, with credentials when given" do
    assert Nats.connection_settings(hosts: "a:4222, b:4223,c") == [
             %{host: "a", port: 4222},
             %{host: "b", port: 4223},
             %{host: "c", port: 4222}
           ]

    assert [%{host: "a", username: "u", password: "p"}] =
             Nats.connection_settings(hosts: "a:1", username: "u", password: "p")
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
end
