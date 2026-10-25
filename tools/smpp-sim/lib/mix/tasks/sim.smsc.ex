defmodule Mix.Tasks.Sim.Smsc do
  @shortdoc "Runs the fake vendor SMSC on its own"
  @moduledoc """
  Runs the fake vendor SMSC until stopped, for a load generated from another machine (`mix sim.run --no-smsc`) or
  for trying the switch by hand. Fake data only.

      mix sim.smsc --port 9100 --resp-ms 1-5 --dlr-ms 500-3000 --vendor-errors 0.5
  """
  use Mix.Task

  @impl true
  def run(args) do
    {opts, _, _} =
      OptionParser.parse(args, strict: [port: :integer, resp_ms: :string, dlr_ms: :string, vendor_errors: :float])

    Mix.Task.run("app.start")
    o = Mix.Tasks.Sim.Run.options(Map.new(opts), "steady")
    SmppSim.Smsc.configure(resp_ms: o.resp_ms, dlr_ms: o.dlr_ms, error_pct: o.error_pct)
    {:ok, _} = SmppSim.Smsc.start_link(port: opts[:port] || 9100)
    Mix.shell().info("fake SMSC listening on #{opts[:port] || 9100}; Ctrl-C twice to stop")
    Process.sleep(:infinity)
  end
end
