defmodule Sms.Core.Release.Sql do
  @moduledoc false
  # One PostgreSQL connection on the simple query protocol (`Sms.Core.Release`): a migration file is many statements,
  # which the extended protocol (Ecto, Postgrex.query) refuses.
  @behaviour Postgrex.SimpleConnection
  alias Postgrex.SimpleConnection

  def start_link(config), do: SimpleConnection.start_link(__MODULE__, nil, config)

  @doc "Runs the SQL; the last statement's rows (as text), or raises with PostgreSQL's error."
  def query!(conn, sql) do
    case SimpleConnection.call(conn, {:query, sql}, :infinity) do
      %Postgrex.Error{} = error -> raise error
      results -> (List.last(results) || %{rows: nil}).rows
    end
  end

  @impl true
  def init(nil), do: {:ok, %{from: nil}}

  @impl true
  def handle_call({:query, sql}, from, state), do: {:query, sql, %{state | from: from}}

  @impl true
  def handle_result(result, state) do
    SimpleConnection.reply(state.from, result)
    {:noreply, %{state | from: nil}}
  end

  @impl true
  def notify(_channel, _payload, _state), do: :ok

  @impl true
  def handle_connect(state), do: {:noreply, state}

  @impl true
  def handle_disconnect(state), do: {:noreply, state}

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}
end
