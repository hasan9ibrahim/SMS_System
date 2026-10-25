defmodule Sms.Core.Metrics do
  @moduledoc """
  Metrics in the Prometheus text format for `Sms.Core.Http` (backend step 8). Every node reports the VM's memory,
  processes and run queue, whether each data store and the bus answer, and how many cluster peers it reaches; a
  provider module (`c:metrics/0`) adds its own, e.g. the switch's sessions, overload guard and buffers.

  A metric is `{name, type, help, samples}`, each sample `{labels, value}`. A provider that fails is skipped (and
  logged), so one broken reading never hides the others.
  """
  require Logger
  alias Sms.Core.{Cluster, Health}

  @type sample :: {%{optional(atom()) => term()}, number()}
  @type metric :: {String.t(), :gauge | :counter, String.t(), [sample()]}

  @callback metrics() :: [metric()]

  @doc "The text served at /metrics."
  @spec render([module()]) :: iolist()
  def render(providers) do
    for {name, type, help, samples} <- core() ++ Enum.flat_map(providers, &safe/1) do
      [
        "# HELP #{name} #{help}\n# TYPE #{name} #{type}\n"
        | for({labels, value} <- samples, do: [name, labels(labels), " ", number(value), "\n"])
      ]
    end
  end

  @doc false
  def core do
    health = Health.check()

    [
      {"sms_up", :gauge, "1 when every data store and the bus answer",
       [{%{}, up(health.overall)}]},
      {"sms_service_up", :gauge, "Whether each data store and the bus answer",
       for({service, status} <- health.services, do: {%{service: service}, up(status)})},
      {"sms_cluster_peers_connected", :gauge, "Cluster peers (SWITCH_PEERS) this node reaches",
       [{%{}, connected_peers()}]},
      {"sms_vm_memory_bytes", :gauge, "Memory used by the Erlang VM",
       for(
         {kind, bytes} <- :erlang.memory(),
         kind in [:total, :processes, :binary, :ets],
         do: {%{kind: kind}, bytes}
       )},
      {"sms_vm_processes", :gauge, "Erlang processes",
       [{%{}, :erlang.system_info(:process_count)}]},
      {"sms_vm_run_queue", :gauge, "Processes waiting for a scheduler",
       [{%{}, :erlang.statistics(:run_queue)}]}
    ]
  end

  defp safe(provider) do
    provider.metrics()
  rescue
    e ->
      Logger.warning("metrics of #{inspect(provider)} not read: #{Exception.message(e)}")
      []
  catch
    :exit, reason ->
      Logger.warning("metrics of #{inspect(provider)} not read: #{inspect(reason)}")
      []
  end

  defp connected_peers do
    if Process.whereis(Cluster), do: length(Cluster.status().connected), else: 0
  end

  defp up(:ok), do: 1
  defp up(_), do: 0

  defp labels(labels) when labels == %{}, do: ""

  defp labels(labels) do
    inner =
      labels
      |> Enum.sort()
      |> Enum.map_join(",", fn {k, v} -> ~s(#{k}="#{escape(to_string(v))}") end)

    "{" <> inner <> "}"
  end

  defp escape(value),
    do:
      value
      |> String.replace("\\", "\\\\")
      |> String.replace("\"", "\\\"")
      |> String.replace("\n", "\\n")

  defp number(true), do: "1"
  defp number(false), do: "0"
  defp number(n) when is_integer(n), do: Integer.to_string(n)
  defp number(n) when is_float(n), do: :erlang.float_to_binary(n, [:compact, decimals: 6])
end
