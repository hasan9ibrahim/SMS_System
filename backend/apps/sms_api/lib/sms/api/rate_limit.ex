defmodule Sms.Api.RateLimit do
  @moduledoc """
  Sign-in attempts per client address (§13.28, Q33: the staff system is reachable from the internet): at most
  `:limit` sign-in calls (password, code and resend together) per address in a window of `:window_s` seconds; more
  are answered 429 until the window ends. The per-user lockout (5 wrong passwords, 15 minutes) is separate.

  Counted in ETS on each node; each server counts its own share.
  """
  use GenServer

  @table __MODULE__

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Counts one attempt from `ip`; `:ok`, or `{:error, seconds_left}` when over the limit."
  @spec hit(String.t()) :: :ok | {:error, pos_integer()}
  def hit(ip) do
    {limit, window} = settings()
    # Monotonic time can be negative: floor division and modulo keep the windows aligned.
    now = System.monotonic_time(:second)
    slot = Integer.floor_div(now, window)
    count = :ets.update_counter(@table, {ip, slot}, 1, {{ip, slot}, 0})
    if count > limit, do: {:error, max(window - Integer.mod(now, window), 1)}, else: :ok
  end

  defp settings do
    config = Application.get_env(:sms_api, __MODULE__, [])
    {Keyword.get(config, :limit, 30), Keyword.get(config, :window_s, 60)}
  end

  @impl true
  def init(_opts) do
    _ = :ets.new(@table, [:named_table, :public, :set, write_concurrency: true])
    _ = :timer.send_interval(60_000, :sweep)
    {:ok, nil}
  end

  # Drops the counts of windows that ended.
  @impl true
  def handle_info(:sweep, state) do
    {_limit, window} = settings()
    current = Integer.floor_div(System.monotonic_time(:second), window)
    _ = :ets.select_delete(@table, [{{{:_, :"$1"}, :_}, [{:<, :"$1", current}], [true]}])
    {:noreply, state}
  end
end
