defmodule Sms.Switch.Metrics do
  @moduledoc """
  The switch's metrics for monitoring (backend step 8, `Sms.Core.Metrics`): submits answered, the overload guard,
  customer and vendor connections, the vendor side's quorum, the sender's backlog and the overflow buffers. Alerts and
  dashboards are in `deploy/ansible/roles/monitoring`.

  Submits are counted in `:counters` (no lock on the message path); the rest is read at each scrape.
  """
  @behaviour Sms.Core.Metrics
  alias Sms.Core.Bus
  alias Sms.Switch.Customer.Sessions
  alias Sms.Switch.Fence
  alias Sms.Switch.Pipeline.{Backlog, Config}
  alias Sms.Switch.Vendor
  alias Sms.Switch.Vendor.{Manager, Quorum}

  @key {__MODULE__, :submits}
  @results [:accepted, :throttled, :refused]

  @doc "Counts a submit's answer (the pipeline's intake)."
  @spec submit({:ok, map(), list()} | {:error, term()}) :: :ok
  def submit(reply) do
    slot =
      case reply do
        {:ok, _, _} -> 1
        {:error, :esme_rthrottled} -> 2
        {:error, _} -> 3
      end

    :counters.add(counters(), slot, 1)
  end

  @impl true
  def metrics do
    c = counters()

    [
      {"sms_submits_total", :counter, "submit_sm / data_sm answered, by result",
       for(
         {result, i} <- Enum.with_index(@results, 1),
         do: {%{result: result}, :counters.get(c, i)}
       )},
      {"sms_overload", :gauge,
       "1 while new messages are refused because the sender is behind (0x58)",
       [{%{}, Backlog.over?()}]},
      {"sms_config_loaded", :gauge, "1 once the routing configuration is in memory",
       [{%{}, ready?()}]},
      {"sms_fenced", :gauge,
       "1 while this server has stepped back (the other one carries the traffic)",
       [{%{}, Fence.fenced?()}]}
    ] ++ customer() ++ vendor() ++ bus()
  end

  defp customer do
    if Process.whereis(Sms.Switch.Customer.Supervisor),
      do: [
        {"sms_customer_sessions", :gauge, "Customer SMPP sessions bound here",
         [{%{}, length(Sessions.local())}]}
      ],
      else: []
  end

  defp vendor do
    if Process.whereis(Manager) do
      sessions = Vendor.sessions()

      [
        {"sms_vendor_sessions", :gauge, "Vendor connections run here, by phase",
         sessions
         |> Enum.frequencies_by(& &1.phase)
         |> Enum.map(fn {phase, n} -> {%{phase: phase}, n} end)},
        {"sms_vendor_nodes", :gauge,
         "Servers sharing the vendor connections as this one sees them (0 = minority)",
         [{%{}, length(Quorum.nodes(Manager.nodes()))}]}
      ]
    else
      []
    end
  end

  defp bus do
    if Process.whereis(Sms.Switch.Pipeline.Supervisor) do
      buffers =
        case Bus.queues() do
          {:ok, queues} -> buffered(queues)
          {:error, _} -> %{}
        end

      backlog =
        case Bus.backlog("pipeline-sender") do
          {:ok, n} -> [{%{}, n}]
          {:error, _} -> []
        end

      [
        {"sms_sender_backlog", :gauge, "Accepted messages not yet taken by the sender", backlog},
        {"sms_buffered_messages", :gauge, "Messages waiting in overflow buffers, by side",
         Enum.map(buffers, fn {kind, n} -> {%{side: kind}, n} end)}
      ]
    else
      []
    end
  end

  defp buffered(queues) do
    for {queue, n} <- queues, kind = buffer_kind(queue), reduce: %{customer: 0, vendor: 0} do
      acc -> Map.update!(acc, kind, &(&1 + n))
    end
  end

  defp buffer_kind("ct." <> _), do: :customer
  defp buffer_kind("vt." <> _), do: :vendor
  defp buffer_kind(_), do: nil

  defp ready? do
    Config.ready?()
  rescue
    _ -> false
  end

  defp counters do
    case :persistent_term.get(@key, nil) do
      nil ->
        ref = :counters.new(length(@results), [:write_concurrency])
        :persistent_term.put(@key, ref)
        ref

      ref ->
        ref
    end
  end
end
