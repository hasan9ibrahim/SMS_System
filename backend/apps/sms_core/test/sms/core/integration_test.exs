defmodule Sms.Core.IntegrationTest do
  # Against the real stores and NATS (INTEGRATION=1): the same bus contract as bus_test.exs, plus the health check.
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog
  alias Gnat.Jetstream.API.{Consumer, Stream}
  alias Sms.Core.{Bus, Health}
  alias Sms.Core.Bus.{Event, Nats}
  alias Sms.Core.Test.{AllConsumer, MsgConsumer, Recorder}

  @moduletag :integration
  @stream "SMS_TEST"

  setup do
    previous = Application.fetch_env!(:sms_core, Bus)
    Application.put_env(:sms_core, Bus, Keyword.merge(previous, adapter: Nats, stream: @stream))

    on_exit(fn ->
      Application.put_env(:sms_core, Bus, previous)
    end)

    start_supervised!(Bus)
    on_exit(fn -> cleanup_stream() end)
    :ok
  end

  defp cleanup_stream do
    {:ok, conn} =
      Gnat.start_link(hd(Nats.connection_settings(Application.fetch_env!(:sms_core, Nats))))

    _ = Stream.delete(conn, @stream)
    Gnat.stop(conn)
  end

  test "the stream exists with the configured settings after start" do
    assert {:ok, %{config: config}} = Stream.info(Nats.connection(), @stream)
    assert config.subjects == ["sms.>"]
    assert config.storage == :file
    assert Bus.health() == :ok
  end

  test "publish is acknowledged by JetStream; a durable consumer gets it; a repeat id is stored once" do
    start_supervised!({Recorder, self()})
    start_supervised!(AllConsumer)
    start_supervised!(MsgConsumer)

    {:ok, %Event{id: id}} =
      Bus.publish("sms.msg.accepted", "msg.accepted", %{"n" => 1}, id: "int-1")

    {:ok, _} = Bus.publish("sms.msg.accepted", "msg.accepted", %{"n" => 1}, id: "int-1")
    assert_receive {:delivered, :all, %Event{id: ^id, data: %{"n" => 1}}, 1}, 5_000
    assert_receive {:delivered, :msg, %Event{id: ^id}, 1}, 5_000
    {:ok, %{state: state}} = Stream.info(Nats.connection(), @stream)
    assert state.messages == 1
  end

  test "a failed event comes back after ack_wait; a discarded or unreadable one never does" do
    start_supervised!({Recorder, self()})
    start_supervised!(MsgConsumer)

    capture_log(fn ->
      {:ok, %Event{id: id}} = Bus.publish("sms.msg.retry", "t", %{"fail_times" => 1})
      assert_receive {:delivered, :msg, %Event{id: ^id}, 1}, 5_000
      assert_receive {:delivered, :msg, %Event{id: ^id}, 2}, 5_000

      {:ok, %Event{id: d}} = Bus.publish("sms.msg.discard", "t", %{"discard" => true})
      assert_receive {:delivered, :msg, %Event{id: ^d}, 1}, 5_000

      {:ok, _} = Gnat.request(Nats.connection(), "sms.msg.junk", "not json")
      refute_receive {:delivered, :msg, %Event{id: ^d}, 2}, 2_500
    end)
  end

  test "a consumer restarted later continues where it left off" do
    start_supervised!({Recorder, self()})
    {:ok, %Event{id: a}} = Bus.publish("sms.msg.one", "t", %{})
    start_supervised!(MsgConsumer)
    assert_receive {:delivered, :msg, %Event{id: ^a}, 1}, 5_000
    :ok = stop_supervised(MsgConsumer)
    {:ok, %Event{id: b}} = Bus.publish("sms.msg.two", "t", %{})
    start_supervised!(MsgConsumer)
    assert_receive {:delivered, :msg, %Event{id: ^b}, 1}, 5_000
    refute_receive {:delivered, :msg, %Event{id: ^a}, _}, 1_500
  end

  test "an event that keeps failing is given up after max_deliver deliveries" do
    start_supervised!({Recorder, self()})
    start_supervised!(MsgConsumer)

    log =
      capture_log(fn ->
        {:ok, %Event{id: id}} = Bus.publish("sms.msg.never", "t", %{"fail_times" => 99})
        for n <- 1..3, do: assert_receive({:delivered, :msg, %Event{id: ^id}, ^n}, 5_000)
        refute_receive {:delivered, :msg, %Event{id: ^id}, 4}, 2_500
      end)

    assert log =~ "given up"
  end

  test "a consumer name taken by another filter is refused, not silently reused" do
    {:ok, _} =
      Consumer.create(Nats.connection(), %Consumer{
        stream_name: @stream,
        durable_name: "test-msg",
        filter_subject: "sms.other.>"
      })

    with_attempts(1, fn ->
      capture_log(fn -> assert {:error, _} = start_supervised(MsgConsumer) end)
    end)
  end

  test "the node refuses to start the bus when NATS cannot be reached" do
    :ok = stop_supervised(Bus)
    nats = Application.fetch_env!(:sms_core, Nats)
    Application.put_env(:sms_core, Nats, Keyword.put(nats, :hosts, "127.0.0.1:1"))
    on_exit(fn -> Application.put_env(:sms_core, Nats, nats) end)

    with_attempts(1, fn ->
      capture_log(fn -> assert {:error, _} = start_supervised(Bus) end)
    end)

    assert Bus.health() == {:error, :not_connected}
    assert Nats.publish("sms.x", "{}", "id", 100) == {:error, :not_connected}
  end

  defp with_attempts(n, fun) do
    config = Application.fetch_env!(:sms_core, Bus)
    Application.put_env(:sms_core, Bus, Keyword.put(config, :setup_attempts, n))

    try do
      fun.()
    after
      Application.put_env(:sms_core, Bus, config)
    end
  end

  test "health: every store answers" do
    for s <- [Sms.Core.Repo, Sms.Core.Redis, Sms.Core.ClickHouse], do: start_supervised!(s)
    assert %{overall: :ok, services: services} = Health.check([:repo, :redis, :clickhouse, :bus])
    assert services == %{repo: :ok, redis: :ok, clickhouse: :ok, bus: :ok}
  end
end
