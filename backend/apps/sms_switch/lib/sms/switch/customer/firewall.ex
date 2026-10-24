defmodule Sms.Switch.Customer.Firewall do
  @moduledoc """
  The Firewall screen's rules applied to SMPP binds (spec §8 Firewall, S-1.1, S-8.1). What the team sets there is
  what the switch does; there is no separate brute-force setting.

    * **Filters** whose listener is `smpp` or `all` and that are active each count failed binds (unknown system_id,
      wrong password, IP not allowed) per client IP. When a filter's `failed_attempts` is reached within its
      `window_seconds`, the IP is banned for the filter's `ban_minutes`: an `auto` row in the Banned list, with
      an expiry, visible on the Firewall screen and honoured by both servers. A successful bind clears the counts.
    * **Banned IPs** (manual, or auto and not expired) are refused at bind (0x0D), even with the right password;
      each refused attempt adds to the rule's Hits and Last hit.
    * **Trusted IPs** are never refused by a ban and never counted.

  Failures are counted in Redis, so both servers add to the same count; while Redis is unavailable each server
  counts on its own. The rules are reloaded every `:refresh_ms` (default 5 s); a ban decided here takes effect on
  this server at once, before the reload. Until the first load (or if the database is down at start) nothing is
  blocked: the firewall never stops every client from binding.
  """
  use GenServer
  require Logger
  alias Sms.Core.Redis
  alias Sms.Switch.Customer.{Events, IpRange}

  @table __MODULE__

  @typedoc "A filter that applies to SMPP binds."
  @type filter :: %{
          id: pos_integer(),
          failed_attempts: pos_integer(),
          window_seconds: pos_integer(),
          ban_minutes: pos_integer()
        }

  @typedoc "A banned range: the rule id and when it expires (`nil`: never; else Unix ms)."
  @type ban :: %{id: pos_integer() | nil, range: IpRange.t(), expires_at: integer() | nil}

  @typedoc "What the firewall reads and writes (`Sms.Switch.Customer.Firewall.Postgres` in production)."
  @type rules :: %{filters: [filter()], banned: [ban()], trusted: [IpRange.t()]}

  defmodule Source do
    @moduledoc "Where the firewall rules live."
    alias Sms.Switch.Customer.Firewall

    @callback load() :: {:ok, Firewall.rules()} | {:error, term()}
    @doc "Bans `ip` under the filter until `expires_at` (Unix ms); returns the rule id."
    @callback ban(
                filter_id :: pos_integer(),
                :inet.ip_address(),
                expires_at :: integer(),
                reason :: String.t()
              ) ::
                {:ok, pos_integer()} | {:error, term()}
    @doc "Adds refused attempts to rules' Hits."
    @callback add_hits([{pos_integer(), pos_integer()}]) :: :ok | {:error, term()}
  end

  @doc "Options: `:source` (a `Source` module), `:refresh_ms`, `:backend` (`:redis` or `:local` counting)."
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Whether binds from `ip` are refused now (a live ban and not trusted). A refused attempt counts as a hit."
  @spec blocked?(:inet.ip_address()) :: boolean()
  def blocked?(ip) do
    ip = IpRange.unmap(ip)

    with [{:rules, rules}] <- :ets.lookup(@table, :rules),
         false <- IpRange.member?(rules.trusted, ip),
         %{} = ban <- live_ban(rules.banned ++ local_bans(), ip) do
      _ = if ban.id, do: :ets.update_counter(@table, {:hits, ban.id}, 1, {{:hits, ban.id}, 0})
      true
    else
      _ -> false
    end
  rescue
    ArgumentError -> false
  end

  defp live_ban(bans, ip) do
    now = System.os_time(:millisecond)

    Enum.find(bans, fn ban ->
      (ban.expires_at == nil or ban.expires_at > now) and IpRange.member?([ban.range], ip)
    end)
  end

  defp local_bans,
    do:
      for(
        {{:local_ban, _, _}, ban} <- :ets.match_object(@table, {{:local_ban, :_, :_}, :_}),
        do: ban
      )

  @doc """
  Records a failed bind from `ip` against every SMPP filter; returns `:banned` when this failure bans the IP.
  """
  @spec failure(:inet.ip_address()) :: :ok | :banned
  def failure(ip), do: GenServer.call(__MODULE__, {:failure, IpRange.unmap(ip)})

  @doc "Records a successful bind: the IP's failure counts are cleared."
  @spec success(:inet.ip_address()) :: :ok
  def success(ip), do: GenServer.cast(__MODULE__, {:success, IpRange.unmap(ip)})

  @doc "Reloads the rules now (and writes the pending hits); returns the load result."
  @spec refresh() :: :ok | {:error, term()}
  def refresh, do: GenServer.call(__MODULE__, :refresh, 30_000)

  # ---------------------------------------------------------------- server

  @impl true
  def init(opts) do
    _ =
      :ets.new(@table, [
        :named_table,
        :public,
        :set,
        read_concurrency: true,
        write_concurrency: true
      ])

    state = %{
      source: Keyword.get(opts, :source, __MODULE__.Postgres),
      refresh_ms: Keyword.get(opts, :refresh_ms, 5_000),
      backend: Keyword.get(opts, :backend, backend()),
      timer: nil,
      warned: false
    }

    {:ok, state, {:continue, :load}}
  end

  defp backend do
    :sms_switch |> Application.get_env(__MODULE__, []) |> Keyword.get(:backend, :redis)
  end

  @impl true
  def handle_continue(:load, state), do: {:noreply, state |> load() |> elem(1) |> schedule()}

  @impl true
  def handle_call(:refresh, _from, state) do
    {result, state} = load(state)
    {:reply, result, schedule(state)}
  end

  def handle_call({:failure, ip}, _from, state) do
    rules = current_rules()

    skip? =
      IpRange.member?(rules.trusted, ip) or live_ban(rules.banned ++ local_bans(), ip) != nil

    {:reply, if(skip?, do: :ok, else: count_failure(state, rules.filters, ip)), state}
  end

  # One ban is enough: once a filter bans the IP, the others stop counting this failure.
  defp count_failure(state, filters, ip) do
    Enum.reduce_while(filters, :ok, fn filter, :ok ->
      if count(state.backend, filter, ip) >= filter.failed_attempts,
        do: {:halt, ban(state, filter, ip)},
        else: {:cont, :ok}
    end)
  end

  @impl true
  def handle_cast({:success, ip}, state) do
    for filter <- current_rules().filters, do: clear(state.backend, filter, ip)
    {:noreply, state}
  end

  @impl true
  def handle_info(:refresh, state), do: {:noreply, state |> load() |> elem(1) |> schedule()}

  defp current_rules do
    case :ets.lookup(@table, :rules) do
      [{:rules, rules}] -> rules
      [] -> %{filters: [], banned: [], trusted: []}
    end
  end

  defp load(state) do
    flush_hits(state.source)

    case state.source.load() do
      {:ok, rules} ->
        :ets.insert(@table, {:rules, rules})
        _ = drop_expired_local_bans()
        {:ok, warn_without_filter(state, rules)}

      {:error, reason} = error ->
        Logger.error("firewall rules not loaded, keeping the previous ones: #{inspect(reason)}")
        {error, state}
    end
  end

  defp warn_without_filter(%{warned: false} = state, %{filters: []}) do
    Logger.warning("no active Firewall filter for SMPP or All listeners: failed binds ban no IP")
    %{state | warned: true}
  end

  defp warn_without_filter(state, %{filters: []}), do: state
  defp warn_without_filter(state, _rules), do: %{state | warned: false}

  defp schedule(state) do
    _ = if state.timer, do: Process.cancel_timer(state.timer)
    %{state | timer: Process.send_after(self(), :refresh, state.refresh_ms)}
  end

  # Hits are counted in memory and written in one go with each reload, so an attacker hammering the listener costs
  # one UPDATE per reload, not one per attempt.
  defp flush_hits(source) do
    case for({{:hits, id}, n} <- :ets.match_object(@table, {{:hits, :_}, :_}), n > 0, do: {id, n}) do
      [] -> :ok
      hits -> write_hits(source, hits)
    end
  end

  defp write_hits(source, hits) do
    case source.add_hits(hits) do
      :ok -> Enum.each(hits, fn {id, n} -> :ets.update_counter(@table, {:hits, id}, -n) end)
      {:error, reason} -> Logger.warning("firewall hits not written: #{inspect(reason)}")
    end
  end

  defp ban(state, filter, ip) do
    expires_at = System.os_time(:millisecond) + filter.ban_minutes * 60_000
    reason = "#{filter.failed_attempts} failed SMPP binds within #{filter.window_seconds} s"

    id =
      case state.source.ban(filter.id, ip, expires_at, reason) do
        {:ok, id} ->
          id

        {:error, error} ->
          Logger.error(
            "firewall ban of #{ip_text(ip)} not saved (applies on this server only): #{inspect(error)}"
          )

          nil
      end

    # Effective at once on this server, before the next reload brings the saved rule.
    :ets.insert(
      @table,
      {{:local_ban, filter.id, ip}, %{id: id, range: {ip, full(ip)}, expires_at: expires_at}}
    )

    clear(state.backend, filter, ip)
    Logger.warning("IP #{ip_text(ip)} banned for #{filter.ban_minutes} min: #{reason}")

    Events.publish(:ip_banned, %{
      ip: ip_text(ip),
      filter_id: filter.id,
      rule_id: id,
      ban_minutes: filter.ban_minutes,
      reason: reason,
      node: node()
    })

    :banned
  end

  defp drop_expired_local_bans do
    now = System.os_time(:millisecond)

    for {key, %{expires_at: expires_at}} <- :ets.match_object(@table, {{:local_ban, :_, :_}, :_}),
        expires_at <= now do
      :ets.delete(@table, key)
    end
  end

  # ---------------------------------------------------------------- counting

  defp count(:redis, filter, ip) do
    key = key(filter, ip)

    case Redis.transaction(
           [["SET", key, "0", "PX", filter.window_seconds * 1_000, "NX"], ["INCR", key]],
           200
         ) do
      {:ok, [_, n]} when is_integer(n) -> n
      other -> count_locally(filter, ip, {:redis_unavailable, other})
    end
  end

  defp count(:local, filter, ip), do: count_locally(filter, ip, nil)

  defp count_locally(filter, ip, redis_error) do
    if redis_error,
      do: Logger.warning("firewall counts on this server only: #{inspect(redis_error)}")

    now = System.monotonic_time(:millisecond)
    key = {:count, filter.id, ip}

    case :ets.lookup(@table, key) do
      [{^key, n, since}] when now - since <= filter.window_seconds * 1_000 ->
        :ets.insert(@table, {key, n + 1, since})
        n + 1

      _ ->
        :ets.insert(@table, {key, 1, now})
        1
    end
  end

  defp clear(:redis, filter, ip) do
    _ = Redis.command(["DEL", key(filter, ip)], 200)
    :ets.delete(@table, {:count, filter.id, ip})
  end

  defp clear(:local, filter, ip), do: :ets.delete(@table, {:count, filter.id, ip})

  defp key(filter, ip), do: "fw:fail:#{filter.id}:#{ip_text(ip)}"
  defp full(ip) when tuple_size(ip) == 4, do: 32
  defp full(_ip), do: 128
  defp ip_text(ip), do: ip |> :inet.ntoa() |> to_string()

  defmodule Postgres do
    @moduledoc "The firewall rules in PostgreSQL (`firewall_filters`, `firewall_rules`, migration 021)."
    @behaviour Sms.Switch.Customer.Firewall.Source
    require Logger
    alias Sms.Core.Repo
    alias Sms.Switch.Customer.IpRange

    @filters """
    SELECT id, failed_attempts, window_seconds, ban_minutes FROM firewall_filters
     WHERE deleted_at IS NULL AND status = 'active' AND listener IN ('smpp', 'all') ORDER BY id
    """

    @rules """
    SELECT r.id, r.list, text(r.ip), (extract(epoch FROM r.expires_at) * 1000)::bigint
      FROM firewall_rules r
      JOIN firewall_filters f ON f.id = r.filter_id
     WHERE r.deleted_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())
       AND f.deleted_at IS NULL AND f.status = 'active' AND f.listener IN ('smpp', 'all')
    """

    @impl true
    def load do
      with {:ok, filters} <- Repo.query(@filters, [], log: false),
           {:ok, rules} <- Repo.query(@rules, [], log: false) do
        {:ok,
         %{
           filters:
             for(
               [id, attempts, window, ban] <- filters.rows,
               do: %{id: id, failed_attempts: attempts, window_seconds: window, ban_minutes: ban}
             ),
           banned:
             for(
               [id, "banned", ip, exp] <- rules.rows,
               {:ok, range} <- [IpRange.parse(ip)],
               do: %{id: id, range: range, expires_at: exp}
             ),
           trusted:
             for(
               [_id, "trusted", ip, _] <- rules.rows,
               {:ok, range} <- [IpRange.parse(ip)],
               do: range
             )
         }}
      end
    rescue
      e -> {:error, Exception.message(e)}
    end

    # A ban that expired keeps its row (the screen shows the history); banning the IP again under the same filter
    # renews that row instead of adding a second live one (one live row per IP and filter, migration 021).
    @impl true
    def ban(filter_id, ip, expires_at, reason) do
      ip = ip |> :inet.ntoa() |> to_string()

      renew = """
      UPDATE firewall_rules
         SET expires_at = to_timestamp($3 / 1000.0), reason = $4, source = 'auto', updated_at = now()
       WHERE ip = $1::text::cidr AND filter_id = $2 AND list = 'banned' AND deleted_at IS NULL
      RETURNING id
      """

      insert = """
      INSERT INTO firewall_rules (list, ip, filter_id, source, reason, expires_at)
      VALUES ('banned', $1::text::cidr, $2, 'auto', $4, to_timestamp($3 / 1000.0))
      ON CONFLICT DO NOTHING
      RETURNING id
      """

      params = [ip, filter_id, expires_at, reason]

      with {:ok, %{rows: []}} <- Repo.query(renew, params, log: false),
           {:ok, %{rows: []}} <- Repo.query(insert, params, log: false) do
        # Another server banned it a moment ago, or a trusted row holds the slot.
        {:error, :not_saved}
      else
        {:ok, %{rows: [[id]]}} -> {:ok, id}
        {:error, _} = error -> error
      end
    rescue
      e -> {:error, Exception.message(e)}
    end

    @impl true
    def add_hits(hits) do
      {ids, counts} = Enum.unzip(hits)

      sql = """
      UPDATE firewall_rules r SET hits = r.hits + h.n, last_hit_at = now()
        FROM unnest($1::bigint[], $2::int[]) AS h(id, n)
       WHERE r.id = h.id
      """

      case Repo.query(sql, [ids, counts], log: false) do
        {:ok, _} -> :ok
        {:error, _} = error -> error
      end
    rescue
      e -> {:error, Exception.message(e)}
    end
  end
end
