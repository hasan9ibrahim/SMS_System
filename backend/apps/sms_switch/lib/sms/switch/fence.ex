defmodule Sms.Switch.Fence do
  @moduledoc """
  One server steps back when the two servers lose each other but both still reach the witness (backend step 8).

  The lab drill showed why: with only the link between the servers cut, each server lost a primary that lived on the
  other one (PostgreSQL behind one, the Redis primary or a NATS stream leader behind the other), so neither carried
  traffic properly. So exactly one side carries it:

    * the server holding the **PostgreSQL primary** (Patroni's lease in etcd, decided with the witness) keeps working;
    * the other server is **fenced**: it drains its customers (`Sms.Switch.Customer.drain/0`: binds refused, submits
      0x58) and unbinds them so their platforms use the other server's address, opens no vendor connection
      (`Sms.Switch.Vendor.Quorum`), and runs the step-back hook (`:hook`, from deploy/ansible), which moves the Redis
      primary and the NATS leadership to the other server so it has every primary.

  A server whose peer is really **down** (the witness lost it too) is not fenced: it takes over, as before. A server
  reaching neither the other server nor the witness is in the minority and fenced too. The decision must hold for two
  checks in a row (`:interval_ms`, 2 s) before it changes, so a short blip does not move traffic. When the link is
  back, the fenced server resumes taking customers and shares the vendor connections again.

  Settings (`config :sms_switch, Sms.Switch.Fence`): `:primary_url` (`SWITCH_PRIMARY_URL`, Patroni's `/primary`, 200
  only on the primary; without it this server never counts as secondary), `:hook` (`SWITCH_FENCE_HOOK`, called with
  `fenced` or `resumed`), `:interval_ms`. Only when a witness is configured (`SWITCH_WITNESS`).
  """
  use GenServer
  require Logger
  alias Sms.Switch.Customer
  alias Sms.Switch.Customer.{Session, Sessions}
  alias Sms.Switch.Vendor.Manager

  @key {__MODULE__, :fenced}
  @timeout 1_000

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Whether this server has stepped back (vendor connections closed, customers drained)."
  @spec fenced?() :: boolean()
  def fenced?, do: :persistent_term.get(@key, false)

  @doc """
  The decision for one check, from what this node sees (pure; the inputs are gathered by `check/1`):
  `:majority` (it reaches 2 of the 3 machines), `:lost_peer` (a server it does not reach), `:witness_sees_peer`
  (the witness still reaches that server) and `:primary` (it holds the PostgreSQL primary).
  """
  @spec decide(map()) :: boolean()
  def decide(%{majority: false}), do: true
  def decide(%{lost_peer: true, witness_sees_peer: true, primary: false}), do: true
  def decide(_), do: false

  @impl true
  def init(opts) do
    config = Keyword.merge(Application.get_env(:sms_switch, __MODULE__, []), opts)
    :persistent_term.put(@key, false)
    state = %{config: config, interval: Keyword.get(config, :interval_ms, 2_000), pending: nil}
    Process.send_after(self(), :check, state.interval)
    {:ok, state}
  end

  @impl true
  def handle_info(:check, state) do
    Process.send_after(self(), :check, state.interval)
    {:noreply, step(state, check(state.config))}
  end

  # A change applies once two checks in a row agree.
  defp step(state, wanted) do
    cond do
      wanted == fenced?() -> %{state | pending: nil}
      state.pending == wanted -> apply_change(wanted, state.config, state)
      true -> %{state | pending: wanted}
    end
  end

  defp apply_change(true, config, state) do
    Logger.error(
      "fenced: the other server is unreachable (the witness still sees it) and this one is not the " <>
        "PostgreSQL primary, or no majority; customers and vendors move to the other server"
    )

    :persistent_term.put(@key, true)
    :ok = Manager.reconcile()
    _ = customers(:drain)
    _ = hook(config, "fenced")
    %{state | pending: nil}
  end

  defp apply_change(false, config, state) do
    Logger.warning("fence lifted: taking customers and sharing vendor connections again")
    :persistent_term.put(@key, false)
    :ok = Manager.reconcile()
    _ = customers(:resume)
    _ = hook(config, "resumed")
    %{state | pending: nil}
  end

  defp customers(:drain) do
    if Process.whereis(Sms.Switch.Customer.Supervisor) do
      Customer.drain()
      for {pid, _meta} <- Sessions.local(), do: Session.stop(pid, :fenced)
    end
  end

  defp customers(:resume) do
    if Process.whereis(Sms.Switch.Customer.Supervisor), do: Customer.resume()
  end

  defp hook(config, event) do
    case config[:hook] do
      path when path in [nil, ""] ->
        :ok

      path ->
        Task.start(fn -> run_hook(path, event) end)
    end
  end

  defp run_hook(path, event) do
    {out, code} = System.cmd(path, [event], stderr_to_stdout: true)
    if code != 0, do: Logger.error("fence hook #{event} exited #{code}: #{out}")
  end

  # ---------------------------------------------------------------- what this node sees

  @doc false
  def check(config) do
    cluster =
      Keyword.get(config, :cluster) || Application.get_env(:sms_core, Sms.Core.Cluster, [])

    connected = Keyword.get(config, :connected, Node.list())
    witness = to_node(cluster[:witness])

    servers =
      cluster |> Keyword.get(:peers, []) |> Enum.map(&to_node/1) |> Enum.reject(&(&1 == witness))

    machines = Enum.uniq([node(), witness | servers])
    lost = Enum.reject(servers, &(&1 in connected))
    seen_by_witness = if witness in connected, do: witness_view(config, witness), else: []

    decide(%{
      majority: Enum.count(machines, &(&1 == node() or &1 in connected)) * 2 > length(machines),
      lost_peer: lost != [],
      witness_sees_peer: Enum.any?(lost, &(&1 in seen_by_witness)),
      primary: primary?(config)
    })
  end

  defp witness_view(config, witness) do
    case config[:witness_view] do
      nil -> :erpc.call(witness, :erlang, :nodes, [], @timeout)
      fun -> fun.(witness)
    end
  catch
    _, _ -> []
  end

  defp primary?(config) do
    case config[:primary] do
      nil -> primary_url?(config[:primary_url])
      fun -> fun.()
    end
  end

  # Patroni answers 200 on the primary only; no URL configured: never the secondary.
  defp primary_url?(url) when url in [nil, ""], do: true

  defp primary_url?(url) do
    case :httpc.request(
           :get,
           {String.to_charlist(url), []},
           [timeout: @timeout, connect_timeout: @timeout],
           []
         ) do
      {:ok, {{_, 200, _}, _, _}} -> true
      _ -> false
    end
  end

  defp to_node(nil), do: nil
  defp to_node(""), do: nil
  defp to_node(name) when is_atom(name), do: name
  defp to_node(name) when is_binary(name), do: String.to_atom(name)
end
