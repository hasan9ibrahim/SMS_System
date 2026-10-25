defmodule Sms.Switch.Vendor.PartsTest do
  # The vendor side's building blocks, without sockets.
  use ExUnit.Case, async: true
  use ExUnitProperties
  @moduletag capture_log: true
  alias Sms.Switch.Vendor.{Loader, Manager, MessageId, Trunk}

  describe "MessageId (S-5.6)" do
    test "decimal ids match with or without leading zeros" do
      assert MessageId.normalize(" 000123 ", :decimal) == "123"
      assert MessageId.normalize("0", :decimal) == "0"
      assert hd(MessageId.receipt_keys("123", :decimal)) == "123"
    end

    test "hexadecimal ids in any case, with or without 0x, are kept as their value" do
      assert MessageId.normalize("00FF", :hexadecimal) == "255"
      assert MessageId.normalize("0xff", :hexadecimal) == "255"
      assert MessageId.normalize("Ff", :hexadecimal) == MessageId.normalize("fF", :hexadecimal)
    end

    test "a receipt in the other base still meets its resp; the trunk's base is tried first" do
      # Hex in the resp, decimal in the receipt.
      resp = MessageId.normalize("1A2B", :hexadecimal)
      assert resp in MessageId.receipt_keys("6699", :hexadecimal)
      assert MessageId.receipt_keys("6699", :hexadecimal) == ["26265", "6699"]
      # Decimal in the resp, hex in the receipt.
      assert MessageId.normalize("6699", :decimal) in MessageId.receipt_keys("1A2B", :decimal)
    end

    test "default ids are opaque text, and anything that is not a number is kept as text" do
      assert MessageId.normalize(" abc-01 ", :default) == "abc-01"
      assert MessageId.receipt_keys("abc-01", :default) == ["abc-01"]
      assert MessageId.normalize("not-hex!", :hexadecimal) == "not-hex!"
      assert MessageId.receipt_keys("xyz", :decimal) == ["xyz"]
    end

    property "a resp id is always among its receipt's keys, whatever the base" do
      check all(
              n <- integer(0..0xFFFFFFFFFFFF),
              type <- member_of([:decimal, :hexadecimal]),
              zeros <- integer(0..3)
            ) do
        text =
          String.duplicate("0", zeros) <>
            if(type == :decimal, do: "#{n}", else: Integer.to_string(n, 16))

        assert MessageId.normalize(text, type) == Integer.to_string(n)
        assert MessageId.normalize(text, type) in MessageId.receipt_keys(text, type)
      end
    end
  end

  describe "Manager.owner (Q12)" do
    test "each trunk's connections are spread evenly over the nodes" do
      nodes = [:a@h, :b@h]

      for id <- 1..50, max <- 1..10 do
        owners = Enum.frequencies(for i <- 0..(max - 1), do: Manager.owner(id, i, nodes))

        assert Map.values(owners)
               |> Enum.max()
               |> Kernel.-(Map.get(owners, :a@h, 0) |> min(Map.get(owners, :b@h, 0))) <= 1
      end

      # One-connection trunks do not all land on the same server.
      assert 1..10 |> Enum.map(&Manager.owner(&1, 0, nodes)) |> Enum.uniq() |> length() == 2
      # Alone, a node owns everything.
      assert Enum.all?(0..9, &(Manager.owner(7, &1, [:a@h]) == :a@h))
    end
  end

  describe "Trunk" do
    setup do
      %{
        t: %Trunk{
          id: 1,
          host: "h",
          port: 1,
          username: "u",
          password: "p",
          tps: 50,
          max_connections: 3
        }
      }
    end

    test "the trunk's TPS is tps × Max Connections, under one counter", %{t: t} do
      assert Trunk.trunk_tps(t) == 150
      assert Trunk.tps_counters(t) == [{:vendor_tps, "vt:1", 150}]
    end

    test "only connection settings need a reconnect", %{t: t} do
      refute Trunk.reconnect_needed?(t, %{
               t
               | tps: 9,
                 window_size: 2,
                 submit_timeout_s: 5,
                 max_connections: 1
             })

      assert Trunk.reconnect_needed?(t, %{t | password: "q"})
      assert Trunk.reconnect_needed?(t, %{t | host: "other"})
      assert Trunk.reconnect_needed?(t, %{t | tls: :"tls1.2"})
      assert Trunk.reconnect_needed?(t, %{t | bind_type: :tx})
      assert Trunk.reconnect_needed?(t, %{t | bind_addr_range: "^1"})
    end
  end

  describe "Loader rows" do
    defp row(overrides \\ %{}) do
      base = %{
        id: 5,
        enterprise_id: 2,
        name: "V",
        status: "active",
        ent_status: "active",
        bind_type: "TR",
        username: "u",
        password: "p",
        host: "smsc.example",
        port: 2775,
        source_host: "10.1.2.3",
        max_conn: 2,
        system_type: "",
        service_type: nil,
        ssl_type: "tls1.0",
        interval: 0,
        submit_timeout: 30,
        el_timeout: 30,
        el_interval: 30,
        schedule: [5, 10],
        alert_after: 2,
        auth_retry: 15,
        msg_id_type: "hexadecimal",
        tps: 100,
        overflow: 0,
        window: 10,
        addr_ton: 1,
        addr_npi: 1,
        addr_range: " ",
        skip_verify: false
      }

      keys =
        [
          :id,
          :enterprise_id,
          :name,
          :status,
          :ent_status,
          :bind_type,
          :username,
          :password,
          :host,
          :port
        ] ++
          [
            :source_host,
            :max_conn,
            :system_type,
            :service_type,
            :ssl_type,
            :interval,
            :submit_timeout
          ] ++
          [
            :el_timeout,
            :el_interval,
            :schedule,
            :alert_after,
            :auth_retry,
            :msg_id_type,
            :tps,
            :overflow
          ] ++
          [:window, :addr_ton, :addr_npi, :addr_range, :skip_verify]

      merged = Map.merge(base, overrides)
      Enum.map(keys, &Map.fetch!(merged, &1))
    end

    test "maps a row to a trunk" do
      assert [%Trunk{} = t] = Loader.trunk(row())
      assert t.bind_type == :trx and t.tls == :"tls1.0" and t.msg_id_type == :hexadecimal
      assert t.source_host == {10, 1, 2, 3}
      assert t.system_type == nil and t.bind_addr_range == nil
      assert t.reconnect_schedule_s == [5, 10]
      assert t.status == :active
      refute t.tls_skip_verify
      assert [%Trunk{tls_skip_verify: true}] = Loader.trunk(row(%{skip_verify: true}))
    end

    test "a trunk of an inactive enterprise is inactive; a bad schedule falls back to the default" do
      assert [%Trunk{status: :inactive}] = Loader.trunk(row(%{ent_status: "inactive"}))

      assert [%Trunk{reconnect_schedule_s: [5, 10, 30, 60]}] =
               Loader.trunk(row(%{schedule: [0, -1]}))
    end

    test "a row the switch cannot read is skipped, never stopping the others" do
      assert Loader.trunk(row(%{bind_type: "XX"})) == []
      assert [%Trunk{source_host: nil}] = Loader.trunk(row(%{source_host: "not-an-ip"}))
    end
  end
end
