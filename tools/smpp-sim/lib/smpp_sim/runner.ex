defmodule SmppSim.Runner do
  @moduledoc """
  Runs a load-test scenario against the switch (backend step 7) and returns what it measured.

  A run: start the fake vendor SMSC and wait until the switch's vendor connections are bound; bind the fake
  customers; warm up; then each **phase** at its rate for its time, measured separately and checked against the pass
  criteria; then **drain** (stop sending, wait for every answer and receipt) and, when a ClickHouse URL is given,
  check the EDRs the switch wrote for the run.

  Scenarios (`phases/2`):

    * `steady`: one rate (`:rate`) for `:duration` seconds;
    * `ramp`: from `:from` up by `:step` every `:step_seconds` until a phase fails or `:max` is reached; the highest
      rate that passed is the switch's capacity on that machine;
    * `spike`: `:base` for 30 s, `:peak` for `:spike_seconds`, `:base` for 60 s (does it absorb a burst and recover?);
    * `soak`: `:rate` for `:duration` seconds in phases of `:chunk_seconds`, to see a trend (latency, memory) over hours;
    * `failover`: `:rate` steady; `:kill` (a shell command, e.g. `scripts/switch.sh kill b`, or
      `scripts/partition.sh cut 9202` to cut the link between two nodes) runs after `:kill_after` seconds, and
      `:restore` (e.g. `scripts/switch.sh start b …` or `scripts/partition.sh heal 9202`) `:restore_after` seconds
      later, measured for `:after_restore` seconds (60).

  A phase **passes** when the customers could send at least 98 % of the offered rate (the window was not full),
  at most 0.1 % of the submits were refused, throttled or unanswered, the submit_sm_resp p99 is within
  `:resp_p99_ms` (default 50 ms, the target of Q32), and receipts came back for at least 90 % of the parts accepted
  (the pipeline behind the resp keeps up).
  """
  require Logger
  alias SmppSim.{Load, Probe, Smsc, Stats}
  alias SmppSim.Smsc.Dlr

  @warmup_s 10

  @doc "The phases of a scenario: `%{name, rate, seconds}`, plus `:action` (a shell command run as it starts)."
  @spec phases(String.t(), map()) :: [map()]
  def phases("steady", o), do: [%{name: "steady", rate: o.rate, seconds: o.duration}]

  def phases("ramp", o) do
    for rate <- Range.new(o.from, o.max, o.step),
        do: %{name: "#{rate}/s", rate: rate, seconds: o.step_seconds, ramp: true}
  end

  def phases("spike", o) do
    [
      %{name: "base", rate: o.base, seconds: 30},
      %{name: "spike", rate: o.peak, seconds: o.spike_seconds},
      %{name: "recovery", rate: o.base, seconds: 60}
    ]
  end

  def phases("soak", o) do
    chunks = max(div(o.duration, o.chunk_seconds), 1)

    for i <- 1..chunks,
        do: %{name: "hour #{Float.round(i * o.chunk_seconds / 3600, 2)}", rate: o.rate, seconds: o.chunk_seconds}
  end

  def phases("failover", o) do
    [%{name: "before", rate: o.rate, seconds: o.kill_after}] ++
      [%{name: "after --kill", rate: o.rate, seconds: o.restore_after, action: o.kill}] ++
      if(o[:restore],
        do: [%{name: "after --restore", rate: o.rate, seconds: Map.get(o, :after_restore, 60), action: o.restore}],
        else: []
      )
  end

  @doc "Runs a scenario. `opts` is a map (see `Mix.Tasks.Sim.Run` for every option)."
  @spec run(String.t(), map()) :: map()
  def run(scenario, opts) do
    config = opts.config_file |> File.read!() |> JSON.decode!()
    Stats.reset()
    Dlr.clear()
    Smsc.reset_config()
    Smsc.configure(Map.take(opts, [:resp_ms, :dlr_ms, :error_pct]))

    smsc =
      if opts.smsc do
        {:ok, pid} = Smsc.start_link(port: config["vendor_port"])
        pid
      end

    info("waiting for the switch's #{config["vendor_connections"]} vendor connections")
    wait_ms = Map.get(opts, :vendor_wait_seconds, 90) * 1_000
    vendors_bound = Load.wait_until(fn -> Stats.get(:smsc_binds) >= config["vendor_connections"] end, wait_ms)
    unless vendors_bound, do: info("only #{Stats.get(:smsc_binds)} vendor connections bound; going on")

    trunks =
      config["customers"]
      |> Enum.take(opts.trunks)
      |> Enum.map(&%{system_id: &1["system_id"], password: &1["password"]})

    prefixes = List.to_tuple(config["prefixes"])
    hosts = Enum.map(opts.ports, &{opts.host, &1})
    info("binding #{length(trunks) * opts.sessions} customer sessions to #{inspect(hosts)}")

    case Load.start(
           trunks: trunks,
           sessions: opts.sessions,
           hosts: hosts,
           prefixes: prefixes,
           window: opts.window,
           multipart_pct: opts.multipart_pct
         ) do
      {:ok, _} -> :ok
      {:error, :not_bound} -> raise "the customer sessions could not all bind to the switch"
    end

    warmup = Map.get(opts, :warmup_seconds, @warmup_s)
    info("warming up for #{warmup} s")
    Load.set_rate(min(Enum.at(phases(scenario, opts), 0).rate, 200))
    Process.sleep(warmup * 1_000)

    started_at = DateTime.utc_now()
    start_snapshot = Stats.snapshot()
    {results, timeline} = run_phases(phases(scenario, opts), opts)
    info("draining: waiting for the last answers and receipts")
    drain = drain(opts.drain_seconds)
    final = Stats.diff(Stats.snapshot(), start_snapshot)
    Load.stop()
    if smsc, do: GenServer.stop(smsc)

    %{
      scenario: scenario,
      options: Map.drop(opts, [:config_file]),
      started_at: DateTime.to_iso8601(started_at),
      machine: machine(),
      phases: results,
      timeline: timeline,
      totals: final,
      drain: drain,
      edr: if(opts[:clickhouse], do: edr_check(opts, config, started_at, final)),
      capacity: capacity(scenario, results)
    }
  end

  defp run_phases(phases, opts) do
    Enum.reduce_while(phases, {[], []}, fn phase, {results, timeline} ->
      if phase[:action], do: action(phase.action)
      info("#{phase.name}: #{phase.rate} msg/s for #{phase.seconds} s")
      {result, seconds} = measure(phase, opts)
      info(summary_line(result))
      results = results ++ [result]
      timeline = timeline ++ seconds
      if phase[:ramp] == true and not result.pass, do: {:halt, {results, timeline}}, else: {:cont, {results, timeline}}
    end)
  end

  defp action(command) do
    info("running: #{command}")
    {out, status} = System.cmd("sh", ["-c", command], stderr_to_stdout: true)
    info("  exit #{status}: #{String.trim(out)}")
  end

  # One phase: a reading every second (rates and the switch's CPU and memory), the whole phase as one diff.
  defp measure(phase, opts) do
    Load.set_rate(phase.rate)
    first = Stats.snapshot()
    probe0 = Probe.read(opts.switch_pids)

    {seconds, _, _, usages} =
      Enum.reduce(1..phase.seconds, {[], first, probe0, []}, fn s, {acc, prev, pprev, usages} ->
        Process.sleep(1_000)
        snap = Stats.snapshot()
        probe = Probe.read(opts.switch_pids)
        usage = Probe.usage(probe, pprev)
        d = Stats.diff(snap, prev)
        if opts.soak_forget, do: forget(s)
        {[second(phase, s, d, usage) | acc], snap, probe, [usage | usages]}
      end)

    d = Stats.diff(Stats.snapshot(), first)
    {result(phase, d, usages, opts), Enum.reverse(seconds)}
  end

  # A soak keeps memory flat: messages done for two minutes are forgotten, and the vendors' duplicate check starts
  # again every 10 minutes.
  defp forget(s) do
    Stats.forget_done(System.monotonic_time(:microsecond) - 120_000_000)
    if rem(s, 600) == 0, do: :ets.delete_all_objects(:sim_smsc_seen)
  end

  defp second(phase, s, d, usage) do
    c = d.counters

    %{
      phase: phase.name,
      second: s,
      offered: phase.rate,
      sent: c.submitted,
      accepted: c.resp_ok,
      errors: c.resp_rejected + c.resp_throttled + c.resp_timeout,
      receipts: c.receipts,
      resp_p99_ms: ms(d.latency.resp.percentiles[99]),
      machine_cpu_pct: usage.machine_cpu_pct,
      switch: usage.procs |> Map.values()
    }
  end

  defp result(phase, d, usages, opts) do
    c = d.counters
    secs = max(d.seconds, 0.001)
    parts = max(c.parts_submitted, 1)
    errors = c.resp_rejected + c.resp_throttled + c.resp_timeout + c.lost_inflight
    resp = d.latency.resp

    checks =
      %{
        sent: c.submitted / secs >= 0.98 * phase.rate,
        errors: errors <= 0.001 * parts,
        resp_p99: ms(resp.percentiles[99]) <= opts.resp_p99_ms
      }
      # Receipts keep up with what was accepted: a fast submit_sm_resp can hide messages piling up behind it.
      |> Map.merge(if opts.receipts, do: %{delivered: c.receipts >= 0.9 * c.resp_ok}, else: %{})

    %{
      name: phase.name,
      offered: phase.rate,
      seconds: Float.round(secs, 1),
      sent_per_s: Float.round(c.submitted / secs, 1),
      accepted_parts_per_s: Float.round(c.resp_ok / secs, 1),
      receipts_per_s: Float.round(c.receipts / secs, 1),
      counters: c,
      statuses: d.statuses,
      resp_ms: latency_ms(resp),
      e2e_ms: latency_ms(d.latency.e2e),
      machine_cpu_pct: avg(usages, & &1.machine_cpu_pct),
      switch: switch_usage(usages),
      checks: checks,
      pass: Enum.all?(Map.values(checks))
    }
  end

  defp switch_usage(usages) do
    usages
    |> Enum.flat_map(&Map.to_list(&1.procs))
    |> Enum.group_by(&elem(&1, 0), &elem(&1, 1))
    |> Map.new(fn {pid, list} ->
      {pid, %{cpu_pct: avg(list, & &1.cpu_pct), rss_mb_max: list |> Enum.map(& &1.rss_mb) |> Enum.max(fn -> 0 end)}}
    end)
  end

  defp avg([], _f), do: 0.0
  defp avg(list, f), do: Float.round(Enum.sum(Enum.map(list, f)) / length(list), 1)

  defp latency_ms(%{count: n, mean: mean, max: max, percentiles: p}) do
    %{
      count: n,
      mean: Float.round(mean / 1_000, 2),
      p50: ms(p[50]),
      p90: ms(p[90]),
      p95: ms(p[95]),
      p99: ms(p[99]),
      p999: ms(p[99.9]),
      max: ms(max)
    }
  end

  defp ms(nil), do: 0.0
  defp ms(us), do: Float.round(us / 1_000, 2)

  defp summary_line(r) do
    "  #{if r.pass, do: "PASS", else: "FAIL"} sent #{r.sent_per_s}/s, accepted #{r.accepted_parts_per_s} parts/s, " <>
      "receipts #{r.receipts_per_s}/s, " <>
      "resp p50 #{r.resp_ms.p50} ms p99 #{r.resp_ms.p99} ms, errors #{r.counters.resp_rejected + r.counters.resp_throttled + r.counters.resp_timeout}, " <>
      "machine CPU #{r.machine_cpu_pct} %"
  end

  defp drain(seconds) do
    Load.set_rate(0)
    answered = Load.wait_until(fn -> Load.info().inflight == 0 end, 30_000)
    receipts = Load.wait_until(fn -> Stats.awaiting_receipts() == 0 and Dlr.pending() == 0 end, seconds * 1_000)

    %{
      all_answered: answered,
      all_receipts: receipts,
      awaiting_receipts: Stats.awaiting_receipts(),
      receipts_pending_at_vendor: Dlr.pending()
    }
  end

  # The switch's own records of the run: every accepted message must have an EDR, with its money (step 6).
  defp edr_check(opts, config, started_at, final) do
    info("checking the EDRs in ClickHouse (after the writer's flush)")
    Process.sleep(10_000)

    since =
      started_at
      |> DateTime.add(-Map.get(opts, :warmup_seconds, @warmup_s) - 5)
      |> Calendar.strftime("%Y-%m-%d %H:%M:%S")

    ent = config["customer_enterprise_id"]

    # A multipart message is one attempt row naming each part's message id (`c_message_ids`).
    query = """
    SELECT uniqExact(edr_id) AS attempts,
           (SELECT uniqExact(id) FROM (SELECT arrayJoin(if(empty(c_message_ids), [c_message_id], c_message_ids)) AS id
              FROM edr WHERE c_enterprise_id = #{ent} AND start_time >= '#{since}')) AS customer_parts,
           countIf(is_final_attempt = 1) AS final_attempts,
           countIf(attempt_no > 1) AS reroutes
      FROM edr WHERE c_enterprise_id = #{ent} AND start_time >= '#{since}'
    FORMAT JSONEachRow
    """

    outcome = """
    SELECT uniqExact(edr_id) AS outcomes, countIf(is_customer_billable = 1) AS customer_billable,
           toString(sum(revenue)) AS revenue, toString(sum(cost)) AS cost
      FROM edr_receipt WHERE c_enterprise_id = #{ent} AND kind = 'outcome' AND start_time >= '#{since}'
    FORMAT JSONEachRow
    """

    with {:ok, edr} <- clickhouse(opts.clickhouse, query),
         {:ok, out} <- clickhouse(opts.clickhouse, outcome) do
      # Since the stats were reset at the start of the run: the warm-up too, as the EDR query's window.
      edr
      |> Map.merge(out)
      |> Map.put("accepted_by_simulator", Stats.get(:resp_ok))
      |> Map.put("measured_phases_accepted", final.counters.resp_ok)
    else
      {:error, reason} -> %{error: inspect(reason)}
    end
  end

  defp clickhouse(url, query) do
    uri = URI.parse(url)

    headers =
      if uri.userinfo,
        do: [{~c"authorization", ~c"Basic " ++ String.to_charlist(Base.encode64(uri.userinfo))}],
        else: []

    clean = URI.to_string(%{uri | userinfo: nil})

    case :httpc.request(:post, {String.to_charlist(clean), headers, ~c"text/plain", query}, [timeout: 60_000], []) do
      {:ok, {{_, 200, _}, _, body}} -> {:ok, body |> to_string() |> String.trim() |> JSON.decode!()}
      {:ok, {{_, status, _}, _, body}} -> {:error, {status, to_string(body)}}
      {:error, reason} -> {:error, reason}
    end
  end

  # The highest rate that passed (a ramp), or the offered rate when everything passed.
  defp capacity("ramp", results) do
    passed = results |> Enum.filter(& &1.pass) |> Enum.map(& &1.offered)

    %{
      highest_rate_passed: Enum.max(passed, fn -> 0 end),
      first_failure: Enum.find(results, &(not &1.pass)) |> then(&(&1 && &1.name))
    }
  end

  defp capacity(_scenario, results), do: %{all_phases_passed: Enum.all?(results, & &1.pass)}

  defp machine do
    cpus = System.schedulers_online()

    mem =
      with {:ok, s} <- File.read("/proc/meminfo"),
           [_, kb] <- Regex.run(~r/MemTotal:\s+(\d+)/, s),
           do: div(String.to_integer(kb), 1024 * 1024)

    %{
      cpus: cpus,
      memory_gb: mem,
      os: :os.type() |> Tuple.to_list() |> Enum.join("/"),
      otp: System.otp_release(),
      elixir: System.version()
    }
  end

  defp info(text), do: IO.puts("[#{Calendar.strftime(DateTime.utc_now(), "%H:%M:%S")}] #{text}")
end
