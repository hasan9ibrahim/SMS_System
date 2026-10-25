defmodule Sms.Switch.Customer.IntegrationTest do
  # Against the real PostgreSQL schema (db/postgres/migrations) and Redis (INTEGRATION=1).
  use ExUnit.Case, async: false
  alias Sms.Core.{Redis, Repo}
  alias Sms.Switch.Customer.{Firewall, Loader, Trunk}
  alias Sms.Switch.Throttle
  alias Sms.Switch.Vendor

  @moduletag :integration

  describe "Loader on the real schema" do
    setup do
      start_supervised!(Repo)
      :ok
    end

    # Rows written inside a transaction that is rolled back, so the database is left as it was.
    defp in_rollback(fun) do
      {:error, {:result, result}} =
        Repo.transaction(fn -> Repo.rollback({:result, fun.()}) end)

      result
    end

    defp insert!(sql, params) do
      %{rows: [[id]]} = Repo.query!(sql, params)
      id
    end

    defp fixtures do
      Repo.query!(
        "INSERT INTO currencies (iso, name, symbol) VALUES ('XTS', 'Test', 'T') ON CONFLICT DO NOTHING"
      )

      company =
        insert!(
          "INSERT INTO business_companies (name, base_currency, tps_limit) VALUES ('Test Co', 'XTS', 900) RETURNING id",
          []
        )

      insert_enterprise = fn status ->
        insert!(
          """
          INSERT INTO enterprises (business_company_id, name, alias, type, tier, status, address_line1)
          VALUES ($1, 'Switch Test ' || $2, 'swtest' || $2, 'customer', 'tier2', $2, 'Street 1') RETURNING id
          """,
          [company, status]
        )
      end

      active = insert_enterprise.("active")
      inactive = insert_enterprise.("inactive")

      trunk = fn enterprise, username, overrides ->
        cols =
          Map.merge(
            %{protocol: "smpp", deleted: false, ssl_type: "tls1.2", bind_type: "TR"},
            overrides
          )

        insert!(
          """
          INSERT INTO customer_trunks (enterprise_id, name, protocol, billing_type, bind_type, host_ips, username,
                                       password, max_connections, ssl_type, tps, dlr_session_affinity,
                                       system_type, deleted_at)
          VALUES ($1, $2, $3, 'submit', $4, '{10.20.30.40, 10.9.0.0/16}'::inet[], $2, 'pw', 3, $5, 40,
                  'same_trunk', 'OTP', CASE WHEN $6 THEN now() END)
          RETURNING id
          """,
          [enterprise, username, cols.protocol, cols.bind_type, cols.ssl_type, cols.deleted]
        )
      end

      %{
        company: company,
        smpp: trunk.(active, "swtest_smpp", %{}),
        http: trunk.(active, "swtest_http", %{protocol: "http"}),
        deleted: trunk.(active, "swtest_deleted", %{deleted: true}),
        of_inactive: trunk.(inactive, "swtest_inactive", %{bind_type: "AUTO", ssl_type: "none"})
      }
    end

    test "loads SMPP trunks with their settings; leaves out HTTP and deleted ones" do
      {ids, trunks} =
        in_rollback(fn ->
          ids = fixtures()
          {:ok, trunks} = Loader.load()
          {ids, trunks}
        end)

      by_id = Map.new(trunks, &{&1.id, &1})
      assert %Trunk{} = smpp = by_id[ids.smpp]
      assert smpp.username == "swtest_smpp"
      assert smpp.host_ips == [{{10, 20, 30, 40}, 32}, {{10, 9, 0, 0}, 16}]
      assert smpp.max_connections == 3 and smpp.tps == 40 and Trunk.trunk_tps(smpp) == 120
      # Worked out from ssl_type by the database (migration 070): TLS → 2776.
      assert smpp.port == 2776
      assert by_id[ids.of_inactive].port == 2775
      assert smpp.tls == :"tls1.2"
      assert smpp.bind_type == :trx
      assert smpp.dlr_session_affinity == :same_trunk
      assert smpp.system_type == "OTP"
      assert smpp.company_tps_limit == 900 and smpp.business_company_id == ids.company
      assert smpp.status == :active
      assert by_id[ids.of_inactive].status == :inactive
      refute Map.has_key?(by_id, ids.http)
      refute Map.has_key?(by_id, ids.deleted)
    end

    test "a trunk stopped on Network Status loads as inactive until Start (backend step 11c)" do
      statuses =
        in_rollback(fn ->
          ids = fixtures()
          stop = "INSERT INTO trunk_binds (side, trunk_id, status) VALUES ('customer', $1, $2)"
          {:ok, _} = Repo.query(stop, [ids.smpp, "stopped"])
          {:ok, stopped} = Loader.load()

          {:ok, _} =
            Repo.query("UPDATE trunk_binds SET status = 'offline' WHERE trunk_id = $1", [ids.smpp])

          {:ok, started} = Loader.load()
          find = fn trunks -> Enum.find(trunks, &(&1.id == ids.smpp)).status end
          {find.(stopped), find.(started)}
        end)

      assert statuses == {:inactive, :active}
    end
  end

  describe "vendor Loader on the real schema" do
    setup do
      start_supervised!(Repo)
      :ok
    end

    test "loads SMPP vendor trunks with their bind policy; leaves out HTTP and deleted ones" do
      {ids, trunks} =
        in_rollback(fn ->
          Repo.query!(
            "INSERT INTO currencies (iso, name, symbol) VALUES ('XTS', 'Test', 'T') ON CONFLICT DO NOTHING"
          )

          company =
            insert!(
              "INSERT INTO business_companies (name, base_currency) VALUES ('V Co', 'XTS') RETURNING id",
              []
            )

          category =
            insert!(
              "INSERT INTO product_categories (name) VALUES ('switch test') RETURNING id",
              []
            )

          enterprise = fn status ->
            insert!(
              """
              INSERT INTO enterprises (business_company_id, name, alias, type, tier, status, address_line1)
              VALUES ($1, 'Vendor Test ' || $2, 'vtest' || $2, 'vendor', 'tier2', $2, 'Street 1') RETURNING id
              """,
              [company, status]
            )
          end

          active = enterprise.("active")
          inactive = enterprise.("inactive")

          trunk = fn ent, name, protocol, deleted ->
            insert!(
              """
              INSERT INTO vendor_trunks (enterprise_id, name, protocol, product_category_id, billing_type, bind_type,
                                         username, password, host, port, source_host, max_connections, ssl_type,
                                         tps, msg_id_type, system_type, enquire_link_interval_s,
                                         reconnect_schedule_s, bind_alert_after_min, auth_fail_retry_min,
                                         bind_addr_ton, bind_addr_range, deleted_at)
              VALUES ($1, $2, $3, $4, 'submit', 'TX', 'sw', 'pw', 'smsc.example', 2775, '10.0.0.9', 3, 'tls1.2',
                      20, 'hexadecimal', 'VMA', 15, '{2,4}', 3, 20, 1, '^49', CASE WHEN $5 THEN now() END)
              RETURNING id
              """,
              [ent, name, protocol, category, deleted]
            )
          end

          ids = %{
            smpp: trunk.(active, "vt smpp", "smpp", false),
            http: trunk.(active, "vt http", "http", false),
            deleted: trunk.(active, "vt deleted", "smpp", true),
            of_inactive: trunk.(inactive, "vt inactive", "smpp", false),
            stopped: trunk.(active, "vt stopped", "smpp", false)
          }

          # Stopped on Network Status (backend step 11c): its connections close until Start.
          {:ok, _} =
            Repo.query(
              "INSERT INTO trunk_binds (side, trunk_id, status) VALUES ('vendor', $1, 'stopped')",
              [
                ids.stopped
              ]
            )

          {:ok, trunks} = Vendor.Loader.load()
          {ids, trunks}
        end)

      by_id = Map.new(trunks, &{&1.id, &1})
      assert %Vendor.Trunk{} = t = by_id[ids.smpp]
      assert t.bind_type == :tx and t.tls == :"tls1.2" and t.msg_id_type == :hexadecimal
      assert t.host == "smsc.example" and t.port == 2775 and t.source_host == {10, 0, 0, 9}
      assert t.max_connections == 3 and Vendor.Trunk.trunk_tps(t) == 60
      assert t.enquire_link_interval_s == 15 and t.reconnect_schedule_s == [2, 4]
      assert t.bind_alert_after_min == 3 and t.auth_fail_retry_min == 20
      assert t.bind_addr_ton == 1 and t.bind_addr_range == "^49" and t.system_type == "VMA"
      assert t.status == :active
      assert by_id[ids.of_inactive].status == :inactive
      assert by_id[ids.stopped].status == :inactive
      refute Map.has_key?(by_id, ids.http)
      refute Map.has_key?(by_id, ids.deleted)
    end
  end

  describe "Firewall rules on the real schema (spec §8)" do
    setup do
      start_supervised!(Repo)
      :ok
    end

    defp in_tx(fun) do
      {:error, {:result, result}} = Repo.transaction(fn -> Repo.rollback({:result, fun.()}) end)
      result
    end

    defp filter!(listener, status) do
      %{rows: [[id]]} =
        Repo.query!(
          """
          INSERT INTO firewall_filters (name, listener, status, failed_attempts, window_seconds, ban_minutes)
          VALUES ('switch test ' || $1 || $2, $1, $2, 4, 30, 15) RETURNING id
          """,
          [listener, status]
        )

      id
    end

    test "loads the active SMPP and All filters with their live rules; saves, renews and counts bans" do
      in_tx(fn ->
        smpp = filter!("smpp", "active")
        http = filter!("http", "active")
        off = filter!("smpp", "inactive")

        Repo.query!(
          """
          INSERT INTO firewall_rules (list, ip, filter_id, source, expires_at) VALUES
            ('banned', '198.51.100.7', $1, 'manual', NULL),
            ('banned', '198.51.100.8', $1, 'auto', now() - interval '1 minute'),
            ('trusted', '198.51.100.0/28', $1, 'manual', NULL),
            ('banned', '198.51.100.9', $2, 'manual', NULL),
            ('banned', '198.51.100.10', $3, 'manual', NULL)
          """,
          [smpp, http, off]
        )

        {:ok, rules} = Firewall.Postgres.load()

        assert Enum.any?(
                 rules.filters,
                 &(&1 == %{id: smpp, failed_attempts: 4, window_seconds: 30, ban_minutes: 15})
               )

        refute Enum.any?(rules.filters, &(&1.id in [http, off]))
        banned = Enum.map(rules.banned, & &1.range)
        assert {{198, 51, 100, 7}, 32} in banned
        refute {{198, 51, 100, 8}, 32} in banned
        refute {{198, 51, 100, 9}, 32} in banned
        refute {{198, 51, 100, 10}, 32} in banned
        assert {{198, 51, 100, 0}, 28} in rules.trusted

        # A new auto ban, then renewing the expired one (one live row per IP and filter).
        expires = System.os_time(:millisecond) + 15 * 60_000

        assert {:ok, new_id} =
                 Firewall.Postgres.ban(
                   smpp,
                   {203, 0, 113, 50},
                   expires,
                   "4 failed SMPP binds within 30 s"
                 )

        assert {:ok, renewed} = Firewall.Postgres.ban(smpp, {198, 51, 100, 8}, expires, "again")

        %{rows: rows} =
          Repo.query!(
            "SELECT id, source, reason, expires_at > now() FROM firewall_rules WHERE filter_id = $1 AND id = ANY($2)",
            [smpp, [new_id, renewed]]
          )

        assert Enum.sort(rows) ==
                 Enum.sort([
                   [new_id, "auto", "4 failed SMPP binds within 30 s", true],
                   [renewed, "auto", "again", true]
                 ])

        assert :ok = Firewall.Postgres.add_hits([{new_id, 3}, {renewed, 1}])
        assert :ok = Firewall.Postgres.add_hits([{new_id, 2}])

        %{rows: [[5, true]]} =
          Repo.query!("SELECT hits, last_hit_at IS NOT NULL FROM firewall_rules WHERE id = $1", [
            new_id
          ])
      end)
    end

    test "failure counts are shared in Redis, so two servers add to the same count" do
      start_supervised!(Redis)
      wait_for_redis()
      source = Sms.Switch.Test.FirewallSource

      source.put(%{
        filters: [%{id: 999_001, failed_attempts: 3, window_seconds: 30, ban_minutes: 1}]
      })

      start_supervised!({Firewall, source: source, refresh_ms: 60_000, backend: :redis})
      :ok = Firewall.refresh()
      ip = {192, 0, 2, 77}
      {:ok, _} = Redis.command(["DEL", "fw:fail:999001:192.0.2.77"])
      assert Firewall.failure(ip) == :ok
      # The other server's failure, straight into the shared counter.
      {:ok, 2} = Redis.command(["INCR", "fw:fail:999001:192.0.2.77"])
      assert Firewall.failure(ip) == :banned
      {:ok, nil} = Redis.command(["GET", "fw:fail:999001:192.0.2.77"])
    end
  end

  describe "Throttle on Redis (S-2.4, Q13)" do
    setup do
      start_supervised!(Redis)
      previous = Application.get_env(:sms_switch, Throttle)

      Application.put_env(:sms_switch, Throttle,
        backend: :redis,
        cluster_size: 2,
        redis_timeout_ms: 500
      )

      on_exit(fn ->
        if previous,
          do: Application.put_env(:sms_switch, Throttle, previous),
          else: Application.delete_env(:sms_switch, Throttle)
      end)

      start_supervised!(Throttle)
      wait_for_redis()
      id = System.unique_integer([:positive]) + 1_000_000
      %{id: id}
    end

    defp wait_for_redis(tries \\ 50) do
      case Redis.command(["PING"]) do
        {:ok, "PONG"} -> :ok
        _ when tries > 0 -> Process.sleep(50) && wait_for_redis(tries - 1)
      end
    end

    # Starts at the beginning of a second so a burst stays inside one counting window.
    defp at_second_start do
      ms = System.os_time(:millisecond)
      Process.sleep(1_000 - rem(ms, 1_000) + 5)
    end

    test "the overflow buffer is one shared count: places taken up to its size, given back (S-2.4)",
         %{id: id} do
      key = "ct:#{id}"
      assert Enum.map(1..4, fn _ -> Throttle.buffer_take(key, 3) end) == [true, true, true, false]
      :ok = Throttle.buffer_release(key)
      assert Throttle.buffer_take(key, 3)
      refute Throttle.buffer_take(key, 3)
      assert {:ok, ttl} = Redis.command(["PTTL", "buf:#{key}"])
      assert ttl > 0
      for _ <- 1..3, do: Throttle.buffer_release(key)
      assert {:ok, "0"} = Redis.command(["GET", "buf:#{key}"])
      # Never below zero, whatever is given back.
      :ok = Throttle.buffer_release(key)
      assert {:ok, "0"} = Redis.command(["GET", "buf:#{key}"])
    end

    test "one shared count per trunk: never more than the limit in a second, whatever the caller",
         %{id: id} do
      trunk = %Trunk{id: id, username: "u", password: "p", tps: 5, max_connections: 2}
      at_second_start()

      results =
        1..30
        |> Task.async_stream(fn _ -> Throttle.acquire(Trunk.tps_counters(trunk)) end,
          max_concurrency: 10
        )
        |> Enum.map(fn {:ok, r} -> r end)

      assert Enum.count(results, &(&1 == :ok)) == 10
      assert Enum.count(results, &(&1 == {:error, :trunk_tps})) == 20
    end

    test "the company limit applies on top across trunks, and a refused submit is not counted", %{
      id: id
    } do
      a = %Trunk{
        id: id,
        username: "a",
        password: "p",
        tps: 100,
        max_connections: 1,
        business_company_id: id,
        company_tps_limit: 3
      }

      b = %Trunk{a | id: id + 1}
      at_second_start()
      results = for t <- [a, b, a, b, a], do: Throttle.acquire(Trunk.tps_counters(t))
      assert results == [:ok, :ok, :ok, {:error, :company_tps}, {:error, :company_tps}]
      second = System.os_time(:second)
      {:ok, count} = Redis.command(["GET", "tps:ct:#{id}:#{second}"])
      assert count in ["2", nil]
    end

    test "the script is loaded again after Redis forgets it (NOSCRIPT)", %{id: id} do
      {:ok, "OK"} = Redis.command(["SCRIPT", "FLUSH"])

      assert Throttle.acquire(
               Trunk.tps_counters(%Trunk{
                 id: id,
                 username: "u",
                 password: "p",
                 tps: 5,
                 max_connections: 1
               })
             ) == :ok
    end

    test "counters expire on their own", %{id: id} do
      :ok =
        Throttle.acquire(
          Trunk.tps_counters(%Trunk{
            id: id,
            username: "u",
            password: "p",
            tps: 5,
            max_connections: 1
          })
        )

      {:ok, keys} = Redis.command(["KEYS", "tps:ct:#{id}:*"])

      for key <- keys do
        {:ok, ttl} = Redis.command(["PTTL", key])
        assert ttl > 0 and ttl <= 2_000
      end
    end
  end
end
