defmodule Sms.Switch.MetricsTest do
  # The switch's metrics for monitoring (backend step 8).
  use ExUnit.Case, async: false
  alias Sms.Switch.Metrics

  defp value(metrics, name, labels \\ %{}) do
    {^name, _type, _help, samples} = List.keyfind(metrics, name, 0)
    samples |> Map.new() |> Map.get(labels)
  end

  test "submits are counted by result" do
    before = Metrics.metrics()

    :ok = Metrics.submit({:ok, %{}, []})
    :ok = Metrics.submit({:error, :esme_rthrottled})
    :ok = Metrics.submit({:error, :esme_rsubmitfail})
    :ok = Metrics.submit({:error, :esme_rsubmitfail})

    now = Metrics.metrics()

    for {result, n} <- [accepted: 1, throttled: 1, refused: 2] do
      labels = %{result: result}

      assert value(now, "sms_submits_total", labels) - value(before, "sms_submits_total", labels) ==
               n
    end
  end

  test "without the switch's parts running only the always-present gauges are reported" do
    metrics = Metrics.metrics()

    assert Enum.map(metrics, &elem(&1, 0)) == [
             "sms_submits_total",
             "sms_overload",
             "sms_config_loaded",
             "sms_fenced"
           ]

    assert value(metrics, "sms_fenced") == false
    assert value(metrics, "sms_config_loaded") == false
  end

  test "renders as Prometheus text" do
    text = IO.iodata_to_binary(Sms.Core.Metrics.render([Metrics]))
    assert text =~ "# TYPE sms_submits_total counter"
    assert text =~ ~s(sms_submits_total{result="accepted"})
  end
end
