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
      {Backlog, Keyword.merge([max: 100, interval_ms: 3_600_000, reader: reader], opts)}
    )
  end

  test "over the limit: refused until the backlog is under 80 % of it; a failed read keeps the state" do
    start([{:ok, 50}, {:ok, 101}, {:ok, 90}, {:error, :down}, {:ok, 79}])
    Backlog.check()
    refute Backlog.over?()

    assert capture_log(fn -> Backlog.check() end) =~ "refused with 0x58"
    assert Backlog.over?()
    assert {:error, :esme_rthrottled} = Intake.handle(%{}, Pdu.new(:submit_sm, %{}))

    # 90 is under the limit but over 80 % of it: still refused.
    Backlog.check()
    assert Backlog.over?()
    Backlog.check()
    assert Backlog.over?()

    assert capture_log([level: :warning], fn -> Backlog.check() end) =~
             "taking new messages again"

    refute Backlog.over?()
  end

  test "max 0 turns it off" do
    start([{:ok, 1_000_000}], max: 0)
    Backlog.check()
    refute Backlog.over?()
  end

  test "the backlog of a consumer comes from the bus" do
    assert {:ok, 0} = Local.backlog("pipeline-sender")
  end
end
