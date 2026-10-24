defmodule Sms.Switch.Test.FirewallSource do
  @moduledoc """
  Firewall rules in memory for tests (`Sms.Switch.Customer.Firewall.Source`). Bans the firewall saves are added to
  the banned list and reported to the owner test; hits are kept for checking.
  """
  @behaviour Sms.Switch.Customer.Firewall.Source

  @key {__MODULE__, :state}

  @doc "Sets the rules and makes the calling test the owner. The default: one SMPP filter, 3 failures → 60 min."
  def put(rules \\ %{}) do
    filters = [%{id: 1, failed_attempts: 3, window_seconds: 60, ban_minutes: 60}]

    state =
      Map.merge(
        %{filters: filters, banned: [], trusted: [], hits: %{}, fail: nil, next_id: 100},
        rules
      )

    :persistent_term.put(@key, Map.put(state, :owner, self()))
  end

  def get, do: :persistent_term.get(@key)
  defp update(fun), do: :persistent_term.put(@key, fun.(get()))

  @impl true
  def load do
    case get() do
      %{fail: reason} when reason != nil -> {:error, reason}
      s -> {:ok, Map.take(s, [:filters, :banned, :trusted])}
    end
  end

  @impl true
  def ban(filter_id, ip, expires_at, reason) do
    %{next_id: id, owner: owner} = get()
    bits = if tuple_size(ip) == 4, do: 32, else: 128

    update(
      &%{
        &1
        | next_id: id + 1,
          banned: [%{id: id, range: {ip, bits}, expires_at: expires_at} | &1.banned]
      }
    )

    send(owner, {:banned, filter_id, ip, expires_at, reason})
    {:ok, id}
  end

  @impl true
  def add_hits(hits) do
    update(fn s ->
      %{
        s
        | hits:
            Enum.reduce(hits, s.hits, fn {id, n}, acc -> Map.update(acc, id, n, &(&1 + n)) end)
      }
    end)

    :ok
  end
end
