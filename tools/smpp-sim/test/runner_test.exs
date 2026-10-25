defmodule SmppSim.RunnerTest do
  # A whole run without a switch: the fake customers bind to the fake vendor SMSC itself, which accepts their messages
  # and sends their receipts back, so the runner's phases, checks, drain and report are exercised end to end.
  use ExUnit.Case, async: false
  alias Mix.Tasks.Sim.Run
  alias SmppSim.{Report, Runner}

  @moduletag :tmp_dir

  defp free_port do
    {:ok, s} = :gen_tcp.listen(0, [])
    {:ok, port} = :inet.port(s)
    :gen_tcp.close(s)
    port
  end

  test "a steady run measures, passes its checks, drains and writes the report", %{tmp_dir: dir} do
    port = free_port()
    config = Path.join(dir, "loadtest.json")

    File.write!(
      config,
      JSON.encode!(%{
        "customers" => [%{"system_id" => "lt1", "password" => "x"}],
        "vendor_port" => port,
        "vendor_connections" => 1,
        "customer_enterprise_id" => 1,
        "prefixes" => ["4477", "3361"]
      })
    )

    opts =
      Run.options(
        %{
          rate: 100,
          duration: 2,
          ports: "#{port}",
          trunks: 1,
          sessions: 2,
          dlr_ms: "10-30",
          drain_seconds: 5,
          warmup_seconds: 1,
          resp_p99_ms: 500.0,
          config: config,
          out: dir
        },
        "steady"
      )

    # No switch: the customers bind to the vendor SMSC itself, so there are no vendor binds to wait for.
    result = Runner.run("steady", Map.put(opts, :vendor_wait_seconds, 0))
    assert [%{name: "steady", pass: true} = phase] = result.phases
    assert phase.sent_per_s > 80
    assert result.drain.all_receipts
    assert result.capacity == %{all_phases_passed: true}
    assert length(result.timeline) == 2

    path = Report.write(result, dir)
    md = File.read!(path)
    assert md =~ "# Load test: steady"
    assert md =~ "Every phase passed"
    assert File.exists?(String.replace(path, ".md", ".json"))
  end

  test "a failover run runs its commands between phases; an unreachable ClickHouse is reported", %{tmp_dir: dir} do
    port = free_port()
    config = Path.join(dir, "loadtest.json")

    File.write!(
      config,
      JSON.encode!(%{
        "customers" => [%{"system_id" => "lt1", "password" => "x"}],
        "vendor_port" => port,
        "vendor_connections" => 1,
        "customer_enterprise_id" => 1,
        "prefixes" => ["4477"]
      })
    )

    marker = Path.join(dir, "killed")

    opts =
      %{
        rate: 50,
        ports: "#{port}",
        trunks: 1,
        sessions: 1,
        kill: "touch '#{marker}'",
        kill_after: 1,
        restore: "true",
        restore_after: 1,
        after_restore: 1,
        drain_seconds: 2,
        warmup_seconds: 0,
        resp_p99_ms: 500.0,
        clickhouse: "http://user:pw@127.0.0.1:1/?database=none",
        config: config,
        out: dir
      }
      |> Run.options("failover")
      |> Map.put(:vendor_wait_seconds, 0)

    result = Runner.run("failover", opts)
    assert ["before", "after --kill", "after --restore"] == Enum.map(result.phases, & &1.name)
    assert File.exists?(marker)
    assert %{error: _} = result.edr
    assert Report.markdown(result) =~ "EDR check failed"
  end

  test "the scenarios' phases" do
    o = Run.options(%{rate: 300, from: 100, step: 100, max: 300, kill: "k", restore: "r"}, "ramp")
    assert [%{rate: 100}, %{rate: 200}, %{rate: 300}] = Runner.phases("ramp", o)
    assert [%{name: "base"}, %{name: "spike", rate: 1_500}, %{name: "recovery"}] = Runner.phases("spike", o)
    assert [_, %{action: "k"}, %{action: "r"}] = Runner.phases("failover", o)
    assert length(Runner.phases("soak", %{o | duration: 1_200, chunk_seconds: 600})) == 2
    assert Run.options(%{resp_ms: "5"}, "soak").resp_ms == {5, 5}
  end

  test "a ramp's capacity is its highest passing phase; a failed phase is reported with its checks" do
    phase = fn name, rate, pass ->
      %{
        name: name,
        offered: rate,
        pass: pass,
        sent_per_s: rate,
        accepted_parts_per_s: rate,
        receipts_per_s: rate,
        counters: Map.new(SmppSim.Stats.counters(), &{&1, 0}),
        resp_ms: %{p50: 1, p95: 2, p99: 3, max: 4},
        machine_cpu_pct: 50.0,
        switch: %{1 => %{cpu_pct: 120.0, rss_mb_max: 300}},
        checks: %{resp_p99: pass}
      }
    end

    snap = SmppSim.Stats.diff(SmppSim.Stats.snapshot(), nil)

    md =
      Report.markdown(%{
        scenario: "ramp",
        started_at: "2026-10-25T00:00:00Z",
        options: %{rate: 1},
        machine: %{cpus: 4, memory_gb: 16, os: "unix/linux", otp: "28", elixir: "1.19"},
        phases: [phase.("100/s", 100, true), phase.("200/s", 200, false)],
        timeline:
          for(
            s <- 1..400,
            do: %{
              phase: "100/s",
              second: s,
              offered: 100,
              sent: 100,
              accepted: 100,
              errors: 0,
              receipts: 100,
              resp_p99_ms: 3.0,
              machine_cpu_pct: 50.0
            }
          ),
        totals: snap,
        drain: %{awaiting_receipts: 0},
        edr: %{
          "accepted_by_simulator" => 1,
          "customer_parts" => 1,
          "attempts" => 1,
          "reroutes" => 0,
          "outcomes" => 1,
          "customer_billable" => 1,
          "revenue" => "0.01",
          "cost" => "0.005"
        },
        capacity: %{highest_rate_passed: 100, first_failure: "200/s"}
      })

    assert md =~ "Highest rate that passed every check: 100 msg/s"
    assert md =~ "FAIL (resp_p99)"
    assert md =~ "120.0 %"
    assert md =~ "1–10"
  end

  test "machine and process readings from /proc" do
    a = SmppSim.Probe.read([System.pid() |> String.to_integer()])
    Process.sleep(50)
    b = SmppSim.Probe.read([System.pid() |> String.to_integer(), 999_999_999])
    usage = SmppSim.Probe.usage(b, a)
    assert usage.machine_cpu_pct >= 0
    assert usage.procs[999_999_999] == %{cpu_pct: 0.0, rss_mb: 0}
  end
end
