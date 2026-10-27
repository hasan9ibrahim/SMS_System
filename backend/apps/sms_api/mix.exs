defmodule Sms.Api.MixProject do
  @moduledoc false
  use Mix.Project

  def project do
    [
      app: :sms_api,
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
        ignore_modules: [Sms.Api.Application, ~r/^Sms\.Api\.Test\./]
      ],
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger, :crypto],
      mod: {Sms.Api.Application, []}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      {:sms_core, in_umbrella: true},
      {:phoenix, "~> 1.8"},
      {:bandit, "~> 1.14"},
      {:finch, "~> 0.24"},
      {:jason, "~> 1.4"}
    ]
  end
end
