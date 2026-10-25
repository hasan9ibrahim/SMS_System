defmodule Mix.Tasks.Sim.Run do
  @shortdoc "Runs a load-test scenario against the switch"
  @moduledoc """
  Runs a load-test scenario (backend step 7) against switch nodes started with `scripts/switch.sh`, on the
  environment `scripts/setup.sh` prepared. See `SmppSim.Runner` for the scenarios and the pass criteria.

      mix sim.run steady --rate 1000 --duration 300
      mix sim.run ramp --from 500 --step 500 --step-seconds 60 --max 20000
      mix sim.run spike --base 1000 --peak 5000 --spike-seconds 20
      mix sim.run soak --rate 580 --duration 86400
      mix sim.run failover --rate 1000 --ports 2775,2785 --kill "scripts/switch.sh kill b" \\
        --restore "scripts/switch.sh start b 2785 2 a"

  Options:

    * `--ports` (2775): the switch nodes' customer ports, comma-separated; sessions are spread over them;
    * `--host` (127.0.0.1);
    * `--trunks` (10) customer trunks and `--sessions` (4) connections per trunk; `--window` (100) answers
      waiting per connection; `--multipart` (5) percent of messages sent as 2 parts;
    * `--resp-ms` (0-0) the fake vendors' answer time, `--dlr-ms` (200-1000) their receipt delay, `--vendor-errors`
      (0) percent of vendor submits refused with 0x58;
    * `--resp-p99-ms` (50) the pass threshold; `--drain-seconds` (60); `--warmup-seconds` (10, not measured);
    * `--switch-pids`: the switch nodes' OS pids, for CPU and memory (`scripts/switch.sh pid a`);
    * `--clickhouse`: `http://user:password@host:8123/?database=sms_load_edr` to check the EDRs written;
    * `--no-smsc`: the fake vendor SMSC runs elsewhere (`mix sim.smsc`); `--no-receipts`: submits ask for no receipt;
    * `--config` (run/loadtest.json), `--out` (results).
  """
  use Mix.Task

  @switches [
    rate: :integer,
    duration: :integer,
    from: :integer,
    step: :integer,
    step_seconds: :integer,
    max: :integer,
    base: :integer,
    peak: :integer,
    spike_seconds: :integer,
    chunk_seconds: :integer,
    kill: :string,
    kill_after: :integer,
    restore: :string,
    restore_after: :integer,
    after_restore: :integer,
    ports: :string,
    host: :string,
    trunks: :integer,
    sessions: :integer,
    window: :integer,
    multipart: :float,
    resp_ms: :string,
    dlr_ms: :string,
    vendor_errors: :float,
    resp_p99_ms: :float,
    drain_seconds: :integer,
    warmup_seconds: :integer,
    switch_pids: :string,
    clickhouse: :string,
    smsc: :boolean,
    receipts: :boolean,
    config: :string,
    out: :string
  ]

  @impl true
  def run(args) do
    {opts, rest, invalid} = OptionParser.parse(args, strict: @switches)
    if invalid != [], do: Mix.raise("unknown options: #{inspect(invalid)}")

    scenario =
      case rest do
        [s] when s in ~w(steady ramp spike soak failover) -> s
        _ -> Mix.raise("usage: mix sim.run steady|ramp|spike|soak|failover [options]; see mix help sim.run")
      end

    Mix.Task.run("app.start")
    options = options(Map.new(opts), scenario)
    result = SmppSim.Runner.run(scenario, options)
    path = SmppSim.Report.write(result, options.out)
    Mix.shell().info("\nReport: #{path}")
  end

  @doc false
  def options(o, scenario) do
    rate = o[:rate] || 1_000

    %{
      rate: rate,
      duration: o[:duration] || if(scenario == "soak", do: 86_400, else: 300),
      from: o[:from] || 500,
      step: o[:step] || 500,
      step_seconds: o[:step_seconds] || 60,
      max: o[:max] || 20_000,
      base: o[:base] || rate,
      peak: o[:peak] || rate * 5,
      spike_seconds: o[:spike_seconds] || 20,
      chunk_seconds: o[:chunk_seconds] || 600,
      kill: o[:kill],
      kill_after: o[:kill_after] || 60,
      restore: o[:restore],
      restore_after: o[:restore_after] || 90,
      after_restore: o[:after_restore] || 60,
      ports: o |> Map.get(:ports, "2775") |> ints(),
      host: o[:host] || "127.0.0.1",
      trunks: o[:trunks] || 10,
      sessions: o[:sessions] || 4,
      window: o[:window] || 100,
      multipart_pct: o[:multipart] || 5.0,
      resp_ms: range(o[:resp_ms] || "0-0"),
      dlr_ms: range(o[:dlr_ms] || "200-1000"),
      error_pct: o[:vendor_errors] || 0.0,
      resp_p99_ms: o[:resp_p99_ms] || 50.0,
      drain_seconds: o[:drain_seconds] || 60,
      warmup_seconds: o[:warmup_seconds] || 10,
      switch_pids: o |> Map.get(:switch_pids, "") |> ints(),
      clickhouse: o[:clickhouse],
      smsc: Map.get(o, :smsc, true),
      receipts: Map.get(o, :receipts, true),
      soak_forget: scenario == "soak",
      config_file: o[:config] || "run/loadtest.json",
      out: o[:out] || "results"
    }
  end

  defp ints(s), do: s |> String.split(",", trim: true) |> Enum.map(&String.to_integer(String.trim(&1)))

  defp range(s) do
    case String.split(s, "-") do
      [a, b] -> {String.to_integer(a), String.to_integer(b)}
      [a] -> {String.to_integer(a), String.to_integer(a)}
    end
  end
end
