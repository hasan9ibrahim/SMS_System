defmodule Sms.Switch.Test.Cluster do
  @moduledoc """
  Helpers for tests with a second BEAM node (`:peer`), standing in for the second server: the session registry runs
  on both, and fake sessions register on either.
  """
  alias Sms.Switch.Customer.{Sessions, Trunk}

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
