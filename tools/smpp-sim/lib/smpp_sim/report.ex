defmodule SmppSim.Report do
  @moduledoc """
  Writes a run's results (`SmppSim.Runner.run/2`) as Markdown, for people, and JSON, for comparing runs:
  `<dir>/<scenario>-<time>.md` and `.json`.
  """

  @doc "Writes both files and returns the Markdown file's path."
  @spec write(map(), Path.t()) :: Path.t()
  def write(result, dir) do
    File.mkdir_p!(dir)
    stamp = result.started_at |> String.slice(0, 19) |> String.replace(~r/[:T]/, "-")
    base = Path.join(dir, "#{result.scenario}-#{stamp}")
    File.write!(base <> ".json", result |> json_safe() |> JSON.encode!())
    File.write!(base <> ".md", markdown(result))
    base <> ".md"
  end

  @doc "The Markdown report."
  @spec markdown(map()) :: String.t()
  def markdown(r) do
    m = r.machine

    """
    # Load test: #{r.scenario} (#{r.started_at})

    Machine: #{m.cpus} CPUs, #{m.memory_gb} GB, #{m.os}, OTP #{m.otp}, Elixir #{m.elixir}. The switch, its databases,
    NATS and the simulator all ran on this one machine, so these figures are a floor for the production servers.

    Options: #{options(r.options)}

    #{capacity(r)}

    ## Phases

    | Phase | Offered/s | Sent/s | Accepted parts/s | Receipts/s | resp p50 | p95 | p99 | max | Errors | Machine CPU | Switch CPU (1 core = 100 %) | Switch RSS | Result |
    | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
    #{Enum.map_join(r.phases, "\n", &phase_row/1)}

    Latency in ms (submit_sm → submit_sm_resp, at the customer). Errors: refused, throttled (0x58), unanswered within
    30 s or lost with a dropped connection.

    ## Whole run

    #{totals(r.totals)}

    ## Receipts

    #{drain(r)}

    #{edr(r.edr)}

    ## Per second

    #{timeline(r.timeline)}
    """
    |> String.replace(~r/\n{3,}/, "\n\n")
  end

  defp options(o) do
    o
    |> Map.drop([:switch_pids])
    |> Enum.sort()
    |> Enum.map_join(", ", fn {k, v} -> "#{k} `#{inspect(v)}`" end)
  end

  defp capacity(%{capacity: %{highest_rate_passed: rate, first_failure: failure}}) do
    "**Highest rate that passed every check: #{rate} msg/s**" <>
      if(failure, do: " (first failure at #{failure}).", else: " (the ramp's maximum; no failure found).")
  end

  defp capacity(%{capacity: %{all_phases_passed: true}}), do: "**Every phase passed.**"
  defp capacity(_), do: "**At least one phase failed** (see the checks below)."

  defp phase_row(p) do
    errors = p.counters.resp_rejected + p.counters.resp_throttled + p.counters.resp_timeout + p.counters.lost_inflight
    switch_cpu = p.switch |> Map.values() |> Enum.map_join(" + ", &"#{&1.cpu_pct} %")
    switch_rss = p.switch |> Map.values() |> Enum.map_join(" + ", &"#{&1.rss_mb_max} MB")
    failed = p.checks |> Enum.reject(&elem(&1, 1)) |> Enum.map_join(", ", &elem(&1, 0))

    "| #{p.name} | #{p.offered} | #{p.sent_per_s} | #{p.accepted_parts_per_s} | #{p.receipts_per_s} | " <>
      "#{p.resp_ms.p50} | #{p.resp_ms.p95} | #{p.resp_ms.p99} | #{p.resp_ms.max} | #{errors} | " <>
      "#{p.machine_cpu_pct} % | #{blank(switch_cpu)} | #{blank(switch_rss)} | " <>
      if(p.pass, do: "PASS |", else: "FAIL (#{failed}) |")
  end

  defp blank(""), do: "–"
  defp blank(s), do: s

  defp totals(t) do
    c = t.counters

    """
    | Measure | Value |
    | --- | ---: |
    | Messages sent (a multipart message counts once) | #{c.submitted} |
    | submit_sm sent (parts) | #{c.parts_submitted} |
    | Accepted (submit_sm_resp OK) | #{c.resp_ok} |
    | Throttled (0x58) | #{c.resp_throttled} |
    | Refused (other statuses) | #{c.resp_rejected} |
    | Unanswered within 30 s | #{c.resp_timeout} |
    | Waiting when a connection dropped | #{c.lost_inflight} |
    | Offered but not sent (window full) | #{c.behind} |
    | Customer connections dropped / bound | #{c.disconnects} / #{c.binds} |
    | Vendor submits / refused by the vendor | #{c.smsc_submits} / #{c.smsc_resp_error} |
    | Duplicate submits at the vendors (same text to the same number) | #{c.smsc_duplicates} |
    | Vendor connections dropped / bound | #{c.smsc_disconnects} / #{c.smsc_binds} |
    | Statuses | #{t.statuses |> Enum.sort() |> Enum.map_join(", ", fn {k, v} -> "0x#{Integer.to_string(k, 16)}: #{v}" end)} |
    | resp latency p50 / p99 / p99.9 / max (ms) | #{l(t.latency.resp)} |
    | submit → receipt p50 / p99 / p99.9 / max (ms) | #{l(t.latency.e2e)} |
    """
  end

  defp l(h) do
    p = h.percentiles
    "#{ms(p[50])} / #{ms(p[99])} / #{ms(p[99.9])} / #{ms(h.max)}"
  end

  defp ms(nil), do: 0
  defp ms(us), do: Float.round(us / 1_000, 2)

  defp drain(r) do
    c = r.totals.counters
    d = r.drain

    """
    | Measure | Value |
    | --- | ---: |
    | Receipts sent by the vendors | #{c.smsc_receipts} |
    | Receipts received by the customers | #{c.receipts} |
    | DELIVRD / UNDELIV / EXPIRED / REJECTD / other | #{c.dlr_delivrd} / #{c.dlr_undeliv} / #{c.dlr_expired} / #{c.dlr_rejectd} / #{c.dlr_other} |
    | Duplicate receipts | #{c.receipts_dup} |
    | Receipts for unknown messages | #{c.receipts_unknown} |
    | Accepted messages still without a receipt after the drain | #{d.awaiting_receipts} |
    | Receipts the switch refused (sent again) | #{c.smsc_receipts_refused} |
    | Receipts the vendors could not deliver (no connection for 60 s) | #{c.smsc_receipts_dropped} |
    """
  end

  defp edr(nil), do: ""
  defp edr(%{error: e}), do: "EDR check failed: #{e}"

  defp edr(e) do
    """
    ## The switch's EDRs (ClickHouse)

    | Measure | Value |
    | --- | ---: |
    | Accepted by the switch (simulator, warm-up included) | #{e["accepted_by_simulator"]} |
    | Customer message parts with an EDR | #{e["customer_parts"]} |
    | Vendor attempts | #{e["attempts"]} (re-routes #{e["reroutes"]}) |
    | Outcome rows (final status per attempt) | #{e["outcomes"]} |
    | Customer-billable outcomes | #{e["customer_billable"]} |
    | Revenue / cost (EUR) | #{e["revenue"]} / #{e["cost"]} |
    """
  end

  # Every second when short; one line per 10 s (averages) when longer than 5 minutes.
  defp timeline(seconds) do
    rows = if length(seconds) > 300, do: seconds |> Enum.chunk_every(10) |> Enum.map(&average/1), else: seconds

    "| Phase | s | Offered | Sent | Accepted | Errors | Receipts | resp p99 ms | Machine CPU |\n" <>
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n" <>
      Enum.map_join(rows, "\n", fn s ->
        "| #{s.phase} | #{s.second} | #{s.offered} | #{s.sent} | #{s.accepted} | #{s.errors} | #{s.receipts} | " <>
          "#{s.resp_p99_ms} | #{s.machine_cpu_pct} % |"
      end)
  end

  defp average([first | _] = chunk) do
    n = length(chunk)
    avg = fn key -> Float.round(Enum.sum(Enum.map(chunk, & &1[key])) / n, 1) end

    %{
      phase: first.phase,
      second: "#{first.second}–#{List.last(chunk).second}",
      offered: first.offered,
      sent: avg.(:sent),
      accepted: avg.(:accepted),
      errors: avg.(:errors),
      receipts: avg.(:receipts),
      resp_p99_ms: chunk |> Enum.map(& &1.resp_p99_ms) |> Enum.max(),
      machine_cpu_pct: avg.(:machine_cpu_pct)
    }
  end

  # JSON has no integer keys or tuples.
  defp json_safe(%{} = map) when not is_struct(map), do: Map.new(map, fn {k, v} -> {to_string(k), json_safe(v)} end)
  defp json_safe(list) when is_list(list), do: Enum.map(list, &json_safe/1)
  defp json_safe(tuple) when is_tuple(tuple), do: tuple |> Tuple.to_list() |> json_safe()
  defp json_safe(other), do: other
end
