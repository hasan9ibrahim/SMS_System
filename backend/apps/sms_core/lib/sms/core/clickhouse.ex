defmodule Sms.Core.ClickHouse do
  @moduledoc """
  The EDR store (ClickHouse, spec §14). EDRs are appended, never updated: a receipt is a new row (docs/BACKEND_PLAN.md
  §3.2).
  """

  @doc false
  def child_spec(_opts) do
    options = Keyword.put(Application.fetch_env!(:sms_core, __MODULE__), :name, __MODULE__)
    Supervisor.child_spec({Ch, options}, id: __MODULE__)
  end

  @doc ~s|Runs a query with `{name:Type}` parameters, e.g. `query("SELECT {n:UInt8}", %{"n" => 1})`.|
  @spec query(iodata(), map() | [term()], keyword()) ::
          {:ok, Ch.Result.t()} | {:error, Exception.t()}
  def query(statement, params \\ [], opts \\ []),
    do: Ch.query(__MODULE__, statement, params, opts)
end
