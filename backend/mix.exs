defmodule Sms.Umbrella.MixProject do
  @moduledoc false
  use Mix.Project

  # The Elixir backend (spec §14, docs/BACKEND_PLAN.md): `core` (data stores, event bus, domain) and `switch`
  # (SMPP engine). The API and jobs apps join in phase B.
  def project do
    [
      apps_path: "apps",
      version: "0.1.0",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      aliases: aliases(),
      dialyzer: [
        plt_local_path: "priv/plts",
        plt_core_path: "priv/plts",
        plt_add_apps: [:mix, :ex_unit],
        flags: [:error_handling, :extra_return, :missing_return, :underspecs, :unmatched_returns]
      ],
      releases: [
        sms: [applications: [sms_core: :permanent, sms_switch: :permanent]]
      ]
    ]
  end

  # `mix check` compiles, analyses and tests in the test environment, like CI.
  def cli, do: [preferred_envs: [check: :test]]

  # Tools only; each app lists its own runtime dependencies.
  defp deps do
    [
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:dialyxir, "~> 1.4", only: [:dev, :test], runtime: false},
      {:mix_audit, "~> 2.1", only: [:dev, :test], runtime: false}
    ]
  end

  # `mix check` is what CI runs, in this order; it must pass before any push.
  defp aliases do
    [
      check: [
        "format --check-formatted",
        "deps.unlock --check-unused",
        "hex.audit",
        "deps.audit",
        "compile --warnings-as-errors --force",
        "credo --strict",
        "dialyzer --format short",
        "test --cover --warnings-as-errors"
      ]
    ]
  end
end
