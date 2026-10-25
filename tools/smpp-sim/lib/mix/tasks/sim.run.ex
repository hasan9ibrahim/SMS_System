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

  # Options taken as given, with their defaults.
  @defaults %{
    from: 500,
    step: 500,
    step_seconds: 60,
    max: 20_000,
    spike_seconds: 20,
    chunk_seconds: 600,
    kill: nil,
    kill_after: 60,
    restore: nil,
    restore_after: 90,
    after_restore: 60,
    host: "127.0.0.1",
    trunks: 10,
    sessions: 4,
    window: 100,
    resp_p99_ms: 50.0,
    drain_seconds: 60,
    warmup_seconds: 10,
    clickhouse: nil,
    smsc: true,
    receipts: true,
    out: "results"
  }

  @doc false
  def options(o, scenario) do
    rate = o[:rate] || 1_000

    %{
      rate: rate,
      duration: if(scenario == "soak", do: 86_400, else: 300),
      base: rate,
      peak: rate * 5
    }
    |> Map.merge(@defaults)
    |> Map.merge(Map.take(o, [:duration, :base, :peak | Map.keys(@defaults)]))
    |> Map.merge(%{
      ports: o |> Map.get(:ports, "2775") |> ints(),
      switch_pids: o |> Map.get(:switch_pids, "") |> ints(),
      multipart_pct: Map.get(o, :multipart, 5.0),
      resp_ms: range(Map.get(o, :resp_ms, "0-0")),
      dlr_ms: range(Map.get(o, :dlr_ms, "200-1000")),
      error_pct: Map.get(o, :vendor_errors, 0.0),
      soak_forget: scenario == "soak",
      config_file: Map.get(o, :config, "run/loadtest.json")
    })
  end

  defp ints(s), do: s |> String.split(",", trim: true) |> Enum.map(&String.to_integer(String.trim(&1)))

  defp range(s) do
    case String.split(s, "-") do
      [a, b] -> {String.to_integer(a), String.to_integer(b)}
      [a] -> {String.to_integer(a), String.to_integer(a)}
    end
  end
end
