defmodule Sms.Core.Redis do
  @moduledoc """
  Redis for live counters shared by both servers (spec §14): TPS limits per trunk, credit, duplicate-filter
  fingerprints. A small pool of connections; each command goes to one picked at random.

  On the servers (backend step 8) Redis runs as a primary on one server and a replica on the other, with Sentinel on
  all three machines: with `:sentinels` set, each connection asks a sentinel for the current primary and follows it
  after a failover (Redix checks the role it connects to). Without, it connects to `:host` and `:port`.
  """

  @type command :: [String.t() | number()]

  @doc false
  def child_spec(_opts) do
    config = config()
    size = Keyword.fetch!(config, :pool_size)

    children =
      for i <- 1..size do
        options =
          target(config) ++
            [
              password: Keyword.get(config, :password),
              name: name(i),
              sync_connect: false,
              backoff_max: 2_000,
              # Small request/response writes: without this, Nagle holds a write for the previous one's ACK (up to
              # 40 ms with delayed ACKs), which was most of a submit_sm_resp's time (load test, backend step 7).
              socket_opts: [nodelay: true]
            ]

        Supervisor.child_spec({Redix, options}, id: {Redix, i})
      end

    %{
      id: __MODULE__,
      type: :supervisor,
      start: {Supervisor, :start_link, [children, [strategy: :one_for_one, name: __MODULE__]]}
    }
  end

  @doc ~s|Runs one command, e.g. `command(["INCR", "tps:42"])`.|
  @spec command(command(), timeout()) :: {:ok, Redix.Protocol.redis_value()} | {:error, term()}
  def command(command, timeout \\ 1_000) do
    Redix.command(pick(), command, timeout: timeout)
  catch
    :exit, reason -> {:error, {:not_connected, reason}}
  end

  @doc "Runs commands as one atomic MULTI/EXEC transaction."
  @spec transaction([command()], timeout()) ::
          {:ok, [Redix.Protocol.redis_value()]} | {:error, term()}
  def transaction(commands, timeout \\ 1_000) do
    Redix.transaction_pipeline(pick(), commands, timeout: timeout)
  catch
    :exit, reason -> {:error, {:not_connected, reason}}
  end

  @doc false
  # Where a connection goes: the primary named by the sentinels, else the one host.
  def target(config) do
    case Keyword.get(config, :sentinels, []) do
      [] ->
        [host: Keyword.fetch!(config, :host), port: Keyword.fetch!(config, :port)]

      sentinels ->
        sentinel =
          [sentinels: sentinels, group: Keyword.get(config, :sentinel_group, "sms")] ++
            if(pw = config[:sentinel_password], do: [password: pw], else: [])

        [sentinel: sentinel]
    end
  end

  defp pick, do: name(:rand.uniform(Keyword.fetch!(config(), :pool_size)))
  defp name(i), do: :"#{__MODULE__}.#{i}"
  defp config, do: Application.fetch_env!(:sms_core, __MODULE__)
end
