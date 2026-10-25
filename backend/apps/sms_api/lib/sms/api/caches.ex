defmodule Sms.Api.Caches do
  @moduledoc """
  Owns the ETS tables of the per-user caches (`Sms.Api.Access`, `Sms.Api.PasswordGate`) for the life of the API. A
  table made by the request that first needed it went away with that request, and a request racing it answered 500
  (found by the backend step 10 browser check). Without the tables (the API not started) the callers read the
  database every time.
  """
  use GenServer

  @tables [Sms.Api.Access, Sms.Api.PasswordGate]

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Whether the cache table exists."
  @spec ready?(atom()) :: boolean()
  def ready?(table), do: :ets.whereis(table) != :undefined

  @impl true
  def init(_opts) do
    for t <- @tables,
        do: ^t = :ets.new(t, [:named_table, :public, :set, read_concurrency: true])

    {:ok, nil}
  end
end
