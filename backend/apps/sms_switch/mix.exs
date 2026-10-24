defmodule Sms.Switch.MixProject do
  @moduledoc false
  use Mix.Project

  def project do
    [
      app: :sms_switch,
      version: "0.1.0",
      build_path: "../../_build",
      config_path: "../../config/config.exs",
      deps_path: "../../deps",
      lockfile: "../../mix.lock",
      elixir: "~> 1.19",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      test_coverage: [
        summary: [threshold: 90],
        ignore_modules: [Sms.Switch.Application, ~r/^Sms\.Switch\.Test\./]
      ],
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger, :crypto, :ssl, :public_key],
      mod: {Sms.Switch.Application, []}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      {:sms_core, in_umbrella: true},
      {:ch, "~> 0.9"},
      {:jason, "~> 1.4"},
      {:ranch, "~> 2.2"},
      {:telemetry, "~> 1.3"},
      {:stream_data, "~> 1.1", only: :test}
    ]
  end
end
