defmodule Sms.Core.MixProject do
  @moduledoc false
  use Mix.Project

  def project do
    [
      app: :sms_core,
      version: "0.1.0",
      build_path: "../../_build",
      config_path: "../../config/config.exs",
      deps_path: "../../deps",
      lockfile: "../../mix.lock",
      elixir: "~> 1.19",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      # The application module starts before coverage begins; test support code is not product code.
      test_coverage: [
        summary: [threshold: 90],
        ignore_modules: [Sms.Core.Application, ~r/^Sms\.Core\.Test\./]
      ],
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger, :crypto],
      mod: {Sms.Core.Application, []}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      {:ecto_sql, "~> 3.13"},
      {:postgrex, "~> 0.20"},
      {:ch, "~> 0.9"},
      {:redix, "~> 1.5"},
      {:gnat, "~> 1.18"},
      {:jason, "~> 1.4"},
      {:telemetry, "~> 1.3"},
      {:logger_json, "~> 7.0"},
      {:stream_data, "~> 1.1", only: :test}
    ]
  end
end
