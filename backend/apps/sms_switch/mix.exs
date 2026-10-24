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
      start_permanent: Mix.env() == :prod,
      test_coverage: [summary: [threshold: 90], ignore_modules: [Sms.Switch.Application]],
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {Sms.Switch.Application, []}
    ]
  end

  defp deps do
    [
      {:sms_core, in_umbrella: true},
      {:stream_data, "~> 1.1", only: :test}
    ]
  end
end
