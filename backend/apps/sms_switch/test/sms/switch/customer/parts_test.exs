defmodule Sms.Switch.Customer.PartsTest do
  # The customer side's building blocks, without sockets.
  use ExUnit.Case, async: false
  use ExUnitProperties
  @moduletag capture_log: true
  import ExUnit.CaptureLog
  alias Sms.Switch.Customer.{Firewall, IpRange, Loader, Trunk, TrunkStore}
  alias Sms.Switch.Test.FirewallSource
  alias Sms.Switch.Throttle

  describe "IpRange" do
    test "hosts and networks, IPv4 and IPv6" do
      {:ok, host} = IpRange.parse("10.1.2.3")
      {:ok, net} = IpRange.parse("192.168.0.0/16")
      {:ok, v6} = IpRange.parse("2001:db8::/32")
      {:ok, all} = IpRange.parse("0.0.0.0/0")
      assert host == {{10, 1, 2, 3}, 32}
      assert IpRange.member?([host], {10, 1, 2, 3})
      refute IpRange.member?([host], {10, 1, 2, 4})
      assert IpRange.member?([net], {192, 168, 200, 1})
      refute IpRange.member?([net], {192, 169, 0, 1})
      assert IpRange.member?([v6], {0x2001, 0xDB8, 0, 0, 0, 0, 0, 1})
      refute IpRange.member?([v6], {0x2001, 0xDB9, 0, 0, 0, 0, 0, 1})
      refute IpRange.member?([net], {0x2001, 0xDB8, 0, 0, 0, 0, 0, 1})
      assert IpRange.member?([all], {8, 8, 8, 8})
      refute IpRange.member?([], {8, 8, 8, 8})
    end

    test "an IPv4-mapped IPv6 client matches as IPv4" do
      {:ok, host} = IpRange.parse("10.1.2.3")
      assert IpRange.member?([host], {0, 0, 0, 0, 0, 0xFFFF, 0x0A01, 0x0203})
      assert IpRange.unmap({0, 0, 0, 0, 0, 0xFFFF, 0x0A01, 0x0203}) == {10, 1, 2, 3}
    end

    test "invalid text is refused" do
      for text <- [
            "",
            "10.1.2",
            "10.1.2.3/33",
            "10.1.2.3/x",
            "1.2.3.4/8/9",
            "::1/129",
            "host.example"
          ] do
        assert {:error, {:invalid_ip_range, ^text}} = IpRange.parse(text)
      end
    end

    property "an address is inside its own /n network for every n" do
      check all(
              a <- integer(0..255),
              b <- integer(0..255),
              c <- integer(0..255),
              d <- integer(0..255),
              n <- integer(0..32)
            ) do
        {:ok, range} = IpRange.parse("#{a}.#{b}.#{c}.#{d}/#{n}")
        assert IpRange.member?([range], {a, b, c, d})
      end
    end
  end

  describe "Trunk" do
    test "trunk TPS is tps × max_connections (migration 034, Q13)" do
      assert Trunk.trunk_tps(%Trunk{
               id: 1,
               username: "u",
               password: "p",
               tps: 50,
               max_connections: 2
             }) == 100
    end

    test "transport rules (S-1.17)" do
      plain = %Trunk{id: 1, username: "u", password: "p", tls: :none}
      assert Trunk.transport_allowed?(plain, nil)
      assert Trunk.transport_allowed?(plain, :tlsv1)

      for {required, ok, refused} <- [
            {:"tls1.0", [:tlsv1, :"tlsv1.1", :"tlsv1.2", :"tlsv1.3"], [nil]},
            {:"tls1.2", [:"tlsv1.2", :"tlsv1.3"], [nil, :tlsv1, :"tlsv1.1"]},
            {:"tls1.3", [:"tlsv1.3"], [nil, :tlsv1, :"tlsv1.2"]}
          ] do
        trunk = %{plain | tls: required}
        for v <- ok, do: assert(Trunk.transport_allowed?(trunk, v), "#{required} #{v}")

        for v <- refused,
            do: refute(Trunk.transport_allowed?(trunk, v), "#{required} #{inspect(v)}")
      end
    end

    test "password check" do
      trunk = %Trunk{id: 1, username: "u", password: "secret"}
      assert Trunk.password_ok?(trunk, "secret")
      refute Trunk.password_ok?(trunk, "secre")
      refute Trunk.password_ok?(trunk, "")
    end
  end

  describe "Throttle, local backend" do
    setup do
      start_supervised!(Throttle)
      :ok
    end

    test "counts per second up to the trunk limit; the company limit applies on top" do
      trunk = %Trunk{id: 1, username: "u", password: "p", tps: 3, max_connections: 1}
      results = for _ <- 1..5, do: Throttle.acquire(Trunk.tps_counters(trunk))
      assert length(Enum.filter(results, &(&1 == :ok))) in 1..3
      assert {:error, :trunk_tps} in results

      company = %Trunk{
        id: 2,
        username: "v",
        password: "p",
        tps: 100,
        max_connections: 1,
        business_company_id: 5,
        company_tps_limit: 2
      }

      other = %Trunk{company | id: 3}

      results =
        for t <- [company, other, company, other], do: Throttle.acquire(Trunk.tps_counters(t))

      assert {:error, :company_tps} in results
    end

    test "a refused submit is not counted, so a refusal by the company limit leaves the trunk's count" do
      trunk = %Trunk{
        id: 9,
        username: "u",
        password: "p",
        tps: 2,
        max_connections: 1,
        business_company_id: 1,
        company_tps_limit: 1
      }

      second = System.os_time(:second)
      _ = Throttle.acquire(Trunk.tps_counters(trunk))
      _ = Throttle.acquire(Trunk.tps_counters(trunk))

      # The table holds the counted submits only (one, under the company limit), unless the second changed.
      if System.os_time(:second) == second do
        assert :ets.lookup(Throttle, {"ct:9", second}) == [{{"ct:9", second}, 1}]
        assert :ets.lookup(Throttle, {"bc:1", second}) == [{{"bc:1", second}, 1}]
      end
    end

    test "old seconds are swept" do
      :ets.insert(Throttle, {{"ct:1", 0}, 5})
      send(Throttle, :sweep)
      _ = :sys.get_state(Throttle)
      assert :ets.lookup(Throttle, {"ct:1", 0}) == []
    end
  end

  describe "Throttle, Redis unreachable" do
    setup do
      previous = Application.get_env(:sms_switch, Throttle)

      Application.put_env(:sms_switch, Throttle,
        backend: :redis,
        cluster_size: 2,
        retry_redis_after_ms: 60_000
      )

      on_exit(fn ->
        if previous,
          do: Application.put_env(:sms_switch, Throttle, previous),
          else: Application.delete_env(:sms_switch, Throttle)
      end)

      start_supervised!(Throttle)
      :ok
    end

    test "falls back to per-server counting with the limit divided by the cluster size (S-7.4), and logs it" do
      trunk = %Trunk{id: 1, username: "u", password: "p", tps: 4, max_connections: 1}

      log =
        capture_log(fn ->
          results = for _ <- 1..4, do: Throttle.acquire(Trunk.tps_counters(trunk))
          ok = Enum.count(results, &(&1 == :ok))
          assert ok >= 1 and ok <= 2
        end)

      assert log =~ "TPS limits counted per server"
    end
  end

  describe "Firewall" do
    defmodule FailingSource do
      @moduledoc false
      @behaviour Sms.Switch.Customer.Firewall.Source
      @impl true
      def load, do: FirewallSource.load()
      @impl true
      def ban(_filter_id, _ip, _expires_at, _reason), do: {:error, :db_down}
      @impl true
      def add_hits(_hits), do: {:error, :db_down}
    end

    defp firewall(rules, source \\ FirewallSource) do
      FirewallSource.put(rules)
      start_supervised!({Firewall, source: source, refresh_ms: 60_000, backend: :local})
      :ok = Firewall.refresh()
    end

    test "counts failures per filter within its window; the threshold bans" do
      firewall(%{filters: [%{id: 1, failed_attempts: 2, window_seconds: 1, ban_minutes: 1}]})
      ip = {192, 0, 2, 1}
      refute Firewall.blocked?(ip)
      assert Firewall.failure(ip) == :ok
      assert Firewall.failure(ip) == :banned
      assert Firewall.blocked?(ip)
      # Already banned: further failures are not counted again.
      assert Firewall.failure(ip) == :ok
    end

    test "failures outside the window start a new count; success clears it" do
      firewall(%{filters: [%{id: 1, failed_attempts: 2, window_seconds: 1, ban_minutes: 1}]})
      ip = {192, 0, 2, 2}
      assert Firewall.failure(ip) == :ok
      Process.sleep(1_100)
      assert Firewall.failure(ip) == :ok
      Firewall.success(ip)
      assert Firewall.failure(ip) == :ok
      refute Firewall.blocked?(ip)
    end

    test "a ban the database cannot save still applies on this server" do
      log =
        capture_log(fn ->
          firewall(
            %{filters: [%{id: 1, failed_attempts: 1, window_seconds: 60, ban_minutes: 1}]},
            FailingSource
          )

          assert Firewall.failure({192, 0, 2, 3}) == :banned
        end)

      assert Firewall.blocked?({192, 0, 2, 3})
      assert log =~ "not saved"
    end

    test "IPv4-mapped IPv6 clients match IPv4 rules" do
      firewall(%{banned: [%{id: 9, range: {{10, 1, 2, 3}, 32}, expires_at: nil}]})
      assert Firewall.blocked?({0, 0, 0, 0, 0, 0xFFFF, 0x0A01, 0x0203})
    end

    test "a failed reload keeps the previous rules; hits that cannot be written are kept for the next try" do
      log =
        capture_log(fn ->
          firewall(
            %{banned: [%{id: 9, range: {{10, 0, 0, 0}, 8}, expires_at: nil}]},
            FailingSource
          )

          assert Firewall.blocked?({10, 9, 9, 9})
          FirewallSource.put(%{fail: :db_down})
          assert {:error, :db_down} = Firewall.refresh()
          assert Firewall.blocked?({10, 9, 9, 9})
        end)

      assert log =~ "firewall rules not loaded"
      assert log =~ "hits not written"
      assert [{_, 2}] = :ets.lookup(Firewall, {:hits, 9})
    end

    test "nothing is blocked before the first load, or with no firewall running" do
      refute Firewall.blocked?({10, 0, 0, 1})
      FirewallSource.put(%{fail: :db_down})

      capture_log(fn ->
        start_supervised!({Firewall, source: FirewallSource, refresh_ms: 60_000, backend: :local})
        assert {:error, :db_down} = Firewall.refresh()
      end)

      refute Firewall.blocked?({10, 0, 0, 1})
    end

    test "a local ban is dropped once expired" do
      firewall(
        %{filters: [%{id: 1, failed_attempts: 1, window_seconds: 60, ban_minutes: 1}]},
        FailingSource
      )

      capture_log(fn -> assert Firewall.failure({192, 0, 2, 4}) == :banned end)
      [{key, ban}] = :ets.match_object(Firewall, {{:local_ban, :_, :_}, :_})
      :ets.insert(Firewall, {key, %{ban | expires_at: System.os_time(:millisecond) - 1}})
      refute Firewall.blocked?({192, 0, 2, 4})
      capture_log(fn -> Firewall.refresh() end)
      assert :ets.match_object(Firewall, {{:local_ban, :_, :_}, :_}) == []
    end
  end

  describe "TrunkStore" do
    setup do
      start_supervised!({Registry, keys: :duplicate, name: Sms.Switch.Customer.Registry})
      :ok
    end

    defp store(result_fun) do
      start_supervised!({TrunkStore, loader: result_fun, refresh_ms: 60_000})
    end

    test "lookup by username and by id; refresh replaces; a renamed or removed trunk leaves no stale row" do
      agent =
        start_supervised!(
          {Agent,
           fn ->
             {:ok,
              [
                %Trunk{id: 1, username: "a", password: "p"},
                %Trunk{id: 2, username: "b", password: "p"}
              ]}
           end}
        )

      store(fn -> Agent.get(agent, & &1) end)
      assert {:ok, 2} = TrunkStore.refresh()
      assert TrunkStore.ready?()
      assert {:ok, %Trunk{id: 1}} = TrunkStore.lookup("a")
      assert {:ok, %Trunk{username: "b"}} = TrunkStore.get(2)
      Agent.update(agent, fn _ -> {:ok, [%Trunk{id: 1, username: "a2", password: "p"}]} end)
      assert {:ok, 1} = TrunkStore.refresh()
      assert TrunkStore.lookup("a") == :error
      assert {:ok, %Trunk{id: 1}} = TrunkStore.lookup("a2")
      assert TrunkStore.lookup("b") == :error
      assert TrunkStore.get(2) == :error
      # A username moved from one trunk to another.
      Agent.update(agent, fn _ ->
        {:ok,
         [
           %Trunk{id: 1, username: "x", password: "p"},
           %Trunk{id: 3, username: "a2", password: "p"}
         ]}
      end)

      assert {:ok, 2} = TrunkStore.refresh()
      assert {:ok, %Trunk{id: 3}} = TrunkStore.lookup("a2")
      assert {:ok, %Trunk{id: 1}} = TrunkStore.lookup("x")
    end

    test "a failed load keeps the trunks it had; not ready before the first success" do
      agent = start_supervised!({Agent, fn -> {:error, :db_down} end})

      capture_log(fn ->
        store(fn -> Agent.get(agent, & &1) end)
        assert {:error, :db_down} = TrunkStore.refresh()
        refute TrunkStore.ready?()
        Agent.update(agent, fn _ -> {:ok, [%Trunk{id: 1, username: "a", password: "p"}]} end)
        assert {:ok, 1} = TrunkStore.refresh()
        Agent.update(agent, fn _ -> {:error, :db_down} end)
        assert {:error, :db_down} = TrunkStore.refresh()
        assert {:ok, _} = TrunkStore.lookup("a")
      end)
    end

    test "sessions of changed or removed trunks are asked to re-check; unchanged ones are not" do
      agent =
        start_supervised!(
          {Agent,
           fn ->
             {:ok,
              [
                %Trunk{id: 1, username: "a", password: "p"},
                %Trunk{id: 2, username: "b", password: "p"}
              ]}
           end}
        )

      store(fn -> Agent.get(agent, & &1) end)
      {:ok, _} = TrunkStore.refresh()
      {:ok, _} = Registry.register(Sms.Switch.Customer.Registry, {:trunk, 1}, %{})
      {:ok, _} = Registry.register(Sms.Switch.Customer.Registry, {:trunk, 2}, %{})

      Agent.update(agent, fn _ -> {:ok, [%Trunk{id: 1, username: "a", password: "p", tps: 9}]} end)

      {:ok, _} = TrunkStore.refresh()
      assert_received :revalidate
      assert_received :revalidate
      refute_received :revalidate
      {:ok, _} = TrunkStore.refresh()
      refute_received :revalidate
    end

    test "the store reloads on its own timer, quickly until the first success" do
      parent = self()
      counter = :counters.new(1, [])

      capture_log(fn ->
        start_supervised!(
          {TrunkStore,
           loader: fn ->
             :counters.add(counter, 1, 1)
             send(parent, :loaded)
             if :counters.get(counter, 1) < 2, do: {:error, :not_yet}, else: {:ok, []}
           end,
           refresh_ms: 60_000}
        )

        assert_receive :loaded, 500
        assert_receive :loaded, 2_000
      end)

      assert TrunkStore.ready?()
    end

    test "ready? is false while no store runs" do
      refute TrunkStore.ready?()
    end
  end

  describe "Loader rows" do
    defp row(overrides \\ %{}) do
      base = %{
        id: 7,
        enterprise_id: 3,
        company_id: 2,
        company_tps: 5000,
        name: "ACME_OTP",
        username: "acme",
        password: "pw",
        status: "active",
        ent_status: "active",
        bind_type: "TR",
        host_ips: ["10.0.0.1", "192.168.1.0/24"],
        max_conn: 2,
        system_type: "",
        port: 2775,
        ssl_type: "tls1.2",
        tps: 50,
        overflow: 10_000,
        affinity: "same_ip",
        hold_hours: 72,
        delayed: false
      }

      b = Map.merge(base, overrides)

      [
        b.id,
        b.enterprise_id,
        b.company_id,
        b.company_tps,
        b.name,
        b.username,
        b.password,
        b.status,
        b.ent_status,
        b.bind_type,
        b.host_ips,
        b.max_conn,
        b.system_type,
        b.port,
        b.ssl_type,
        b.tps,
        b.overflow,
        b.affinity,
        b.hold_hours,
        b.delayed
      ]
    end

    test "a row becomes a trunk" do
      assert [%Trunk{} = t] = Loader.trunk(row())
      assert t.bind_type == :trx
      assert t.tls == :"tls1.2"
      assert t.dlr_session_affinity == :same_ip
      assert t.system_type == nil
      assert t.company_tps_limit == 5000
      assert t.host_ips == [{{10, 0, 0, 1}, 32}, {{192, 168, 1, 0}, 24}]
      assert t.status == :active
    end

    test "an inactive enterprise makes the trunk inactive; no company limit when 0 or null" do
      assert [%Trunk{status: :inactive}] = Loader.trunk(row(%{ent_status: "inactive"}))
      assert [%Trunk{company_tps_limit: nil}] = Loader.trunk(row(%{company_tps: nil}))
      assert [%Trunk{company_tps_limit: nil}] = Loader.trunk(row(%{company_tps: 0}))
    end

    test "a bad host IP is skipped with a log; an unknown value skips just that trunk" do
      log =
        capture_log(fn ->
          assert [%Trunk{host_ips: [{{10, 0, 0, 1}, 32}]}] =
                   Loader.trunk(row(%{host_ips: ["10.0.0.1", "nonsense"]}))
        end)

      assert log =~ "host IP"
      log = capture_log(fn -> assert [] = Loader.trunk(row(%{bind_type: "XX"})) end)
      assert log =~ "customer trunk 7 skipped"
    end

    test "every enum value of the schema maps" do
      for {bind, kind} <- [{"TX", :tx}, {"RX", :rx}, {"TR", :trx}, {"AUTO", :auto}],
          {ssl, tls} <- [
            {"none", :none},
            {"tls1.0", :"tls1.0"},
            {"tls1.2", :"tls1.2"},
            {"tls1.3", :"tls1.3"}
          ],
          {aff, mode} <- [{"strict", :strict}, {"same_ip", :same_ip}, {"same_trunk", :same_trunk}] do
        assert [%Trunk{bind_type: ^kind, tls: ^tls, dlr_session_affinity: ^mode}] =
                 Loader.trunk(
                   row(%{bind_type: bind, ssl_type: ssl, affinity: aff, system_type: "X"})
                 )
      end
    end

    test "without a database the loader returns an error" do
      assert {:error, _} = Loader.load()
    end
  end
end
