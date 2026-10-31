defmodule Sms.Switch.Test.Cluster do
  @moduledoc """
  Helpers for tests with a second BEAM node (`:peer`), standing in for the second server: the session registry runs
  on both, and fake sessions register on either.
  """
  alias Sms.Core.{Bus, Redis}
  alias Sms.Switch.Customer.{Sessions, Trunk, TrunkStore}
  alias Sms.Switch.Pipeline.Store
  alias Sms.Switch.Test.{CustomerCase, VendorCase}
  alias Sms.Switch.{Throttle, Vendor}

  @doc "Starts a peer node (not linked: stop it with `:peer.stop/1`); the calling node becomes distributed if it is not."
  def start_peer(name) do
    _ =
      unless Node.alive?() do
        {_, 0} = System.cmd("epmd", ["-daemon"])

        name = :"primary-#{System.unique_integer([:positive])}@127.0.0.1"
        {:ok, _} = :net_kernel.start(name, %{name_domain: :longnames})
      end

    args = Enum.flat_map(:code.get_path(), &[~c"-pa", &1])

    {:ok, peer, node} =
      :peer.start(%{name: name, host: ~c"127.0.0.1", longnames: true, args: args})

    {peer, node}
  end

  @doc "Starts the session registry and cluster scope on this node, not linked to the caller."
  def start_sessions do
    {:ok, pid} = Supervisor.start_link(Sessions.child_specs(), strategy: :one_for_one)
    Process.unlink(pid)
    pid
  end

  @doc """
  Starts the vendor side on this node with `trunks`, not linked to the caller: the event bus in memory and trunks
  served from memory (`Sms.Switch.Test.VendorCase.load_trunks/0`).
  """
  def start_vendor(trunks, session \\ []) do
    Application.put_env(:sms_core, Bus, adapter: Bus.Local)
    VendorCase.put_trunks(trunks)

    children = [
      Bus,
      {Vendor.Supervisor,
       trunk_loader: &VendorCase.load_trunks/0, trunk_refresh_ms: 60_000, session: session}
    ]

    {:ok, pid} = Supervisor.start_link(children, strategy: :one_for_one)
    Process.unlink(pid)
    pid
  end

  @doc """
  Starts the message store on Redis and the event bus in memory on this node, with the first node's configuration of
  both (`redis`, `bus`), not linked to the caller: a second server sharing the first one's Redis (S-2.12). The TPS
  counters are shared through that Redis too, and the customer trunks are `trunks` (S-2.4).
  """
  def start_store(redis, bus, trunks \\ []) do
    Application.put_env(:sms_core, Redis, redis)
    Application.put_env(:sms_core, Bus, Keyword.put(bus, :adapter, Bus.Local))
    Application.put_env(:sms_switch, Store, backend: :redis)
    Application.put_env(:sms_switch, Throttle, backend: :redis)
    CustomerCase.put_trunks(trunks)

    trunk_store = {TrunkStore, loader: &CustomerCase.load_trunks/0, refresh_ms: 3_600_000}

    {:ok, pid} =
      Supervisor.start_link([Redis, Store, Bus, Throttle, trunk_store],
        strategy: :one_for_one
      )

    Process.unlink(pid)
    await_redis(50)
  end

  defp await_redis(tries) do
    case Redis.command(["PING"]) do
      {:ok, "PONG"} ->
        :ok

      _ when tries > 0 ->
        Process.sleep(50)
        await_redis(tries - 1)

      error ->
        error
    end
  end

  @doc "A process that registers as a session of `trunk` and stays until told to stop; returns `{pid, result}`."
  def fake_session(%Trunk{} = trunk, meta) do
    caller = self()

    pid =
      spawn(fn ->
        send(caller, {:registered, self(), Sessions.register(trunk, meta)})
        receive(do: (:stop -> :ok))
      end)

    receive do
      {:registered, ^pid, result} -> {pid, result}
    after
      5_000 -> {pid, :timeout}
    end
  end
end
