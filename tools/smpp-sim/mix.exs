defmodule SmppSim.MixProject do
  @moduledoc false
  use Mix.Project

  # The switch's own SMPP 3.4 codec (backend step 1), compiled in rather than copied, so the simulator speaks exactly
  # the PDUs the switch does.
  @codec Path.expand("../../backend/apps/sms_switch/lib/sms/switch/smpp", __DIR__)

  def project do
    [
      app: :smpp_sim,
      version: "0.1.0",
      elixir: "~> 1.19",
      elixirc_paths: ["lib", @codec],
      start_permanent: false,
      deps: deps(),
      test_coverage: [summary: [threshold: 80], ignore_modules: [~r/^Sms\.Switch\./, ~r/^Mix\.Tasks\./]]
    ]
  end

  def application do
    [extra_applications: [:logger, :inets, :ssl], mod: {SmppSim.Application, []}]
  end

  defp deps do
    [{:credo, "~> 1.7", only: [:dev, :test], runtime: false}]
  end
end
