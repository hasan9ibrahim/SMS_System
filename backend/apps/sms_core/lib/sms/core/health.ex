defmodule Sms.Core.Health do
  @moduledoc """
  Whether each data store and the event bus answer, for the health endpoint and the status bar (§13.3). Every check
  has its own short timeout, so one slow store never hides the others.
  """
  alias Sms.Core.{Bus, ClickHouse, Redis, Repo}

  @type service :: :repo | :redis | :clickhouse | :bus
  @type status :: :ok | {:error, term()}

  @timeout 2_000

  @doc "Checks the given services in parallel; `:ok` only when every one answered."
  @spec check([service()]) :: %{overall: :ok | :degraded, services: %{service() => status()}}
  def check(services \\ Application.get_env(:sms_core, :services, [])) do
    results =
      services
      |> Task.async_stream(&{&1, safe(fn -> probe(&1) end)},
        timeout: @timeout + 500,
        on_timeout: :kill_task
      )
      |> Enum.zip(services)
      |> Map.new(fn
        {{:ok, {service, status}}, service} -> {service, status}
        {{:exit, :timeout}, service} -> {service, {:error, :timeout}}
      end)

    overall = if Enum.all?(results, fn {_, s} -> s == :ok end), do: :ok, else: :degraded
    %{overall: overall, services: results}
  end

  defp probe(:repo) do
    case Repo.query("SELECT 1", [], timeout: @timeout) do
      {:ok, %{rows: [[1]]}} -> :ok
      {:error, error} -> {:error, error}
    end
  end

  defp probe(:redis) do
    case Redis.command(["PING"], @timeout) do
      {:ok, "PONG"} -> :ok
      {:error, error} -> {:error, error}
    end
  end

  defp probe(:clickhouse) do
    case ClickHouse.query("SELECT 1", [], timeout: @timeout) do
      {:ok, %{rows: [[1]]}} -> :ok
      {:error, error} -> {:error, error}
    end
  end

  defp probe(:bus), do: Bus.health()

  defp safe(fun) do
    fun.()
  rescue
    e -> {:error, e}
  catch
    :exit, reason -> {:error, {:exit, reason}}
  end
end
