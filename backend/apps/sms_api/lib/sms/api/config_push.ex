defmodule Sms.Api.ConfigPush do
  @moduledoc """
  A saved change is live on every server at once (S-6.6; backend step 9): after a change goes through the API
  (answered by the mock or by Elixir), every node of the cluster is told to re-read the routing configuration
  (`Sms.Switch.Pipeline.Config.Server.nudge/0`, `:target`). Without the push each switch still finds the change at its
  next 5-second check. Changes in a burst (bulk edits, an import) are sent once, `:delay_ms` after the last.

  Only changes count: reads, and the user's own session, preferences and saved views, do not. A node where the switch
  does not run (the witness) ignores the call.
  """
  use GenServer
  require Logger

  @skip ~w(session me views password-check changes portal)

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Called after a call was answered: pushes when it was a successful change."
  @spec after_call(String.t(), String.t(), non_neg_integer()) :: :ok
  def after_call(method, path, status) do
    first = path |> String.split("/", trim: true) |> Enum.at(2)

    if method != "GET" and status in 200..299 and first not in @skip and
         not String.ends_with?(path, "/query"),
       do: GenServer.cast(__MODULE__, :changed)

    :ok
  end

  @impl true
  def init(_opts), do: {:ok, %{timer: nil}}

  @impl true
  def handle_cast(:changed, %{timer: timer} = state) do
    _ = if timer, do: Process.cancel_timer(timer)
    {:noreply, %{state | timer: Process.send_after(self(), :push, config(:delay_ms, 300))}}
  end

  @impl true
  def handle_info(:push, state) do
    {module, fun} = config(:target, {Sms.Switch.Pipeline.Config.Server, :nudge})
    :ok = :erpc.multicast([node() | Node.list()], module, fun, [])
    {:noreply, %{state | timer: nil}}
  end

  defp config(key, default),
    do: Keyword.get(Application.get_env(:sms_api, __MODULE__, []), key, default)
end
