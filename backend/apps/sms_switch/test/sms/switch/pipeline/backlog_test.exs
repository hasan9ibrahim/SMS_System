defmodule Sms.Switch.Pipeline.BacklogTest do
  # Overload protection: new messages refused (0x58) while the sender is too far behind (backend step 7).
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog
  alias Sms.Core.Bus.Local
  alias Sms.Switch.Pipeline.{Backlog, Intake}
  alias Sms.Switch.Smpp.Pdu

  defp start(backlogs, opts \\ []) do
    {:ok, agent} = Agent.start_link(fn -> backlogs end)

    reader = fn ->
      Agent.get_and_update(agent, fn
        [only] -> {only, [only]}
        [next | rest] -> {next, rest}
      end)
    end

    start_supervised!(
      {Backlog,
       Keyword.merge(
         [max: 100, max_wait_ms: 10_000, interval_ms: 3_600_000, reader: reader],
         opts
       )}
    )
  end

  defp waited(ms), do: Backlog.observe(DateTime.add(DateTime.utc_now(), -ms, :millisecond))

  test "messages waiting over max_wait_ms: refused until the wait is under 80 % of it" do
    start([{:ok, 0}])
    waited(2_000)
    Backlog.check()
    refute Backlog.over?()

    # The shortest wait of the second counts: one old redelivered message alone does not trip it.
    waited(60_000)
    waited(3_000)
    Backlog.check()
    refute Backlog.over?()

    waited(11_000)
    waited(12_000)
    assert capture_log(fn -> Backlog.check() end) =~ "messages wait over 10000 ms"
    assert Backlog.over?()
    assert {:error, :esme_rthrottled} = Intake.handle(%{}, Pdu.new(:submit_sm, %{}))

    # Nothing taken in a second: the state is kept. 9 s is over 80 % of the limit: still refused.
    Backlog.check()
    assert Backlog.over?()
    waited(9_000)
    Backlog.check()
    assert Backlog.over?()

    waited(1_000)

    assert capture_log([level: :warning], fn -> Backlog.check() end) =~
             "taking new messages again"

    refute Backlog.over?()
  end

  test "safety cap on the messages unfinished: refused until under 80 % of it; a failed read keeps the state" do
    start([{:ok, 50}, {:ok, 101}, {:ok, 90}, {:error, :down}, {:ok, 79}])
    Backlog.check()
    refute Backlog.over?()

    assert capture_log(fn -> Backlog.check() end) =~ "over 100 waiting"
    assert Backlog.over?()

    Backlog.check()
    assert Backlog.over?()
    Backlog.check()
    assert Backlog.over?()
    Backlog.check()
    refute Backlog.over?()
  end

  test "0 turns each measure off; without the guard running, observe does nothing" do
    assert :ok = waited(1)
    start([{:ok, 1_000_000}], max: 0, max_wait_ms: 0)
    waited(60_000)
    Backlog.check()
    refute Backlog.over?()
  end

  test "the backlog of a consumer comes from the bus" do
    assert {:ok, 0} = Local.backlog("pipeline-sender")
  end
end
