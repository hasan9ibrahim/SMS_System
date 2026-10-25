defmodule Sms.Switch.Vendor.SessionTest do
  # The vendor side against a fake vendor SMSC (spec §5.5, migration 058 bind policy, SMPP_SCENARIOS §5).
  use Sms.Switch.Test.VendorCase, async: false
  @moduletag capture_log: true
  alias Sms.Switch.Test.Receipts

  setup do
    start_supervised!(Sms.Core.Bus)
    smsc = start_smsc()
    %{smsc: smsc, port: FakeSmsc.port(smsc)}
  end

  defp submit(fields \\ %{destination_addr: "4915112345678", short_message: "hi"}, opts \\ []),
    do: Vendor.submit(1, :submit_sm, fields, [], opts)

  describe "bind" do
    test "binds as a transceiver with the trunk's credentials, System Type and bind address", %{
      port: port
    } do
      start_vendor([
        trunk(port,
          system_type: "VMA",
          bind_addr_ton: 1,
          bind_addr_npi: 1,
          bind_addr_range: "^49"
        )
      ])

      {_conn, bind} = assert_bind()
      assert bind.command == :bind_transceiver

      assert bind.fields == %{
               system_id: "switch",
               password: "secret",
               system_type: "VMA",
               interface_version: 0x34,
               addr_ton: 1,
               addr_npi: 1,
               address_range: "^49"
             }

      await_bound(1, 1)

      assert_eventually(fn ->
        match?([%{"trunk_id" => 1, "system_id" => "FAKESMSC"}], events("bound"))
      end)
    end

    test "the bind command follows the trunk's bind type; an RX connection never sends", %{
      port: port
    } do
      start_vendor([trunk(port, bind_type: :tx)])
      {_, bind} = assert_bind()
      assert bind.command == :bind_transmitter
      await_bound(1, 1)

      reload([trunk(port, bind_type: :rx)])
      {_, bind} = assert_bind()
      assert bind.command == :bind_receiver
      assert_eventually(fn -> Enum.any?(Vendor.sessions(), &(&1.phase == :bound)) end)
      # Bound, but not a transmitter: nothing to send on.
      assert submit() == {:error, :no_connection}
    end

    test "opens every Max Connections connection", %{port: port} do
      start_vendor([trunk(port, max_connections: 3)])
      for _ <- 1..3, do: assert_bind()
      await_bound(1, 3)
      assert Enum.sort(Enum.map(Vendor.sessions(), & &1.index)) == [0, 1, 2]
    end

    test "a refused bind is retried on the reconnect schedule", %{smsc: smsc, port: port} do
      FakeSmsc.set(smsc, :bind_status, 0x0D)
      start_vendor([trunk(port)])
      assert_bind()
      t0 = System.monotonic_time(:millisecond)
      FakeSmsc.set(smsc, :bind_status, 0)
      assert_bind(3_000)
      assert System.monotonic_time(:millisecond) - t0 >= 900
      await_bound(1, 1)

      assert [%{"reason" => reason, "retry_in_ms" => 1_000}] = events("bind_failed")
      assert reason =~ "esme_rbindfail"
    end

    test "the reconnect schedule's values are used in turn, the last one repeating", %{port: port} do
      trunk = trunk(port, reconnect_schedule_s: [5, 10, 30, 60])

      assert Enum.map(0..6, &Trunk.reconnect_delay_ms(trunk, &1)) ==
               [5, 10, 30, 60, 60, 60, 60] |> Enum.map(&(&1 * 1000))

      assert Trunk.reconnect_delay_ms(%{trunk | reconnect_schedule_s: []}, 3) == 5_000
    end

    test "a wrong password or system ID waits Auth Fail Retry instead of the schedule", %{
      smsc: smsc,
      port: port
    } do
      FakeSmsc.set(smsc, :bind_status, 0x0E)
      start_vendor([trunk(port, auth_fail_retry_min: 15)])
      assert_bind()
      refute_receive {:smsc, _, %Pdu{command: :bind_transceiver}}, 1_500
      assert_eventually(fn -> match?([%{"retry_in_ms" => 900_000}], events("bind_failed")) end)

      # Fixing the password on the trunk tries at once.
      FakeSmsc.set(smsc, :bind_status, 0)
      reload([trunk(port, auth_fail_retry_min: 15, password: "new")])
      {_, bind} = assert_bind()
      assert bind.fields.password == "new"
      await_bound(1, 1)
    end

    test "an unreachable vendor is retried, and the Bind Down Alert fires once per outage", %{
      smsc: smsc,
      port: port
    } do
      FakeSmsc.stop(smsc)
      start_vendor([trunk(port, bind_alert_after_min: 0)])
      assert_eventually(fn -> events("bind_failed") != [] end)
      assert_eventually(fn -> length(events("bind_down")) == 1 end)
      assert [%{"reason" => "{:connect_failed, :econnrefused}"} | _] = events("bind_failed")

      # Back up on the same port: bound, and bind_up says the outage is over.
      smsc = start_smsc(port: port)
      _ = smsc
      assert_eventually(fn -> length(events("bind_up")) == 1 end, 3_000)
      await_bound(1, 1)
      assert length(events("bind_down")) == 1
    end

    test "no bind response within the bind timeout: closed and retried", %{port: port} do
      # A server that accepts the connection and never answers.
      {:ok, silent} = :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true])
      {:ok, silent_port} = :inet.port(silent)
      spawn_link(fn -> accept_forever(silent) end)
      start_vendor([trunk(silent_port)], session: [bind_timeout_ms: 200])

      assert_eventually(fn ->
        Enum.any?(events("bind_failed"), &(&1["reason"] == ":bind_timeout"))
      end)

      _ = port
    end

    test "a username or password too long for SMPP 3.4 is never sent; it waits like a refused password",
         %{port: port} do
      start_vendor([trunk(port, password: "much-too-long")])
      refute_receive {:smsc, _, _}, 300

      assert_eventually(fn ->
        Enum.any?(events("bind_failed"), &(&1["reason"] =~ "invalid_bind"))
      end)
    end
  end

  defp accept_forever(listen) do
    case :gen_tcp.accept(listen) do
      {:ok, _socket} -> accept_forever(listen)
      _ -> :ok
    end
  end

  describe "connection drops and keep-alive" do
    test "a dropped connection is opened again; waiting submits answer :connection_lost", %{
      smsc: smsc,
      port: port
    } do
      FakeSmsc.set(smsc, :submit, :silent)
      start_vendor([trunk(port)])
      {conn, _} = assert_bind()
      await_bound(1, 1)
      task = Task.async(fn -> submit() end)
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}
      FakeSmsc.close(conn)
      assert Task.await(task) == {:error, :connection_lost}
      assert_bind(3_000)
      await_bound(1, 1)
      assert_eventually(fn -> match?([%{"reason" => ":closed_by_vendor"}], events("closed")) end)
    end

    test "enquire_link after the interval; a vendor that stops answering is reconnected", %{
      smsc: smsc,
      port: port
    } do
      start_vendor([trunk(port, enquire_link_interval_s: 1, enquire_link_timeout_s: 1)])
      {conn, _} = assert_bind()
      assert_receive {:smsc, ^conn, %Pdu{command: :enquire_link}}, 1_500
      # Answered: still the same connection.
      refute_receive {:smsc, _, %Pdu{command: :bind_transceiver}}, 200

      FakeSmsc.set(smsc, :enquire_link, :silent)
      assert_receive {:smsc, ^conn, %Pdu{command: :enquire_link}}, 1_500
      assert_bind(4_000)

      assert_eventually(fn ->
        Enum.any?(events("closed"), &(&1["reason"] == ":enquire_link_timeout"))
      end)
    end

    test "the vendor's enquire_link is answered", %{port: port} do
      start_vendor([trunk(port)])
      {conn, _} = assert_bind()
      await_bound(1, 1)
      FakeSmsc.send_pdu(conn, Pdu.new(:enquire_link, %{}, sequence: 77))
      assert_receive {:smsc, ^conn, %Pdu{command: :enquire_link_resp, sequence: 77}}
    end

    test "the vendor's unbind is answered after the receipts in hand, then the connection opens again",
         %{port: port} do
      start_vendor([trunk(port)])
      {conn, _} = assert_bind()
      await_bound(1, 1)
      FakeSmsc.send_pdu(conn, Pdu.new(:unbind, %{}, sequence: 5))
      assert_receive {:smsc, ^conn, %Pdu{command: :unbind_resp, sequence: 5}}
      assert_bind(3_000)
    end

    test "a stopping node unbinds its vendor connections", %{port: port} do
      start_vendor([trunk(port)])
      {conn, _} = assert_bind()
      await_bound(1, 1)
      stop_supervised!(Sms.Switch.Vendor.Supervisor)
      assert_receive {:smsc, ^conn, %Pdu{command: :unbind}}
    end
  end

  describe "submits" do
    test "the vendor's message id comes back normalised per MsgID Type (S-5.6)", %{
      smsc: smsc,
      port: port
    } do
      FakeSmsc.set(smsc, :message_id, fn n -> "00" <> Integer.to_string(n + 254, 16) end)
      start_vendor([trunk(port, msg_id_type: :hexadecimal, service_type: "CMT")])
      {conn, _} = assert_bind()
      await_bound(1, 1)

      assert {:ok, %{status: 0, message_id: "255", raw_message_id: "00FF", session_id: sid}} =
               submit()

      assert is_binary(sid)
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm, fields: fields}}
      # The trunk's Service Type is sent.
      assert fields.service_type == "CMT"
      assert fields.destination_addr == "4915112345678"
    end

    test "a refusal comes back with its status for the pipeline to classify (S-5.3)", %{
      smsc: smsc,
      port: port
    } do
      FakeSmsc.set(smsc, :submit, {:status, 0x58})
      start_vendor([trunk(port)])
      await_bound(1, 1)
      assert {:ok, %{status: 0x58, message_id: nil}} = submit()
    end

    test "data_sm goes out too", %{port: port} do
      start_vendor([trunk(port)])
      await_bound(1, 1)

      assert {:ok, %{status: 0, message_id: "1"}} =
               Vendor.submit(1, :data_sm, %{destination_addr: "49151"})
    end

    test "Window Size: past it, :window_full at once", %{smsc: smsc, port: port} do
      FakeSmsc.set(smsc, :submit, :silent)
      start_vendor([trunk(port, window_size: 2, submit_timeout_s: 5)])
      await_bound(1, 1)
      tasks = for _ <- 1..2, do: Task.async(fn -> submit() end)
      assert_receive {:smsc, _, %Pdu{command: :submit_sm}}
      assert_receive {:smsc, _, %Pdu{command: :submit_sm}}
      assert submit() == {:error, :window_full}
      Enum.each(tasks, &Task.shutdown(&1, :brutal_kill))
    end

    test "a full connection hands over to the next one", %{smsc: smsc, port: port} do
      FakeSmsc.set(smsc, :submit, {:delay, 300})
      start_vendor([trunk(port, window_size: 1, max_connections: 2)])
      await_bound(1, 2)

      results =
        1..2 |> Enum.map(fn _ -> Task.async(fn -> submit() end) end) |> Enum.map(&Task.await/1)

      assert Enum.all?(results, &match?({:ok, %{status: 0}}, &1))
      assert results |> Enum.map(fn {:ok, r} -> r.session_id end) |> Enum.uniq() |> length() == 2
    end

    test "Submit Timeout answers :timeout; a late OK is published as a possible duplicate (S-5.2, D4)",
         %{smsc: smsc, port: port} do
      FakeSmsc.set(smsc, :submit, {:delay, 1_300})
      start_vendor([trunk(port, submit_timeout_s: 1)])
      await_bound(1, 1)
      assert submit(%{destination_addr: "49151"}, ref: "msg-42") == {:error, :timeout}

      assert_eventually(
        fn ->
          match?(
            [%{"ref" => "msg-42", "status" => 0, "message_id" => "1", "trunk_id" => 1}],
            events("late_response")
          )
        end,
        2_000
      )

      # The connection carries on.
      FakeSmsc.set(smsc, :submit, :ok)
      assert {:ok, %{status: 0}} = submit()
    end

    test "Submit Interval spaces the submits on a connection", %{port: port} do
      start_vendor([trunk(port, submit_interval_ms: 150)])
      await_bound(1, 1)
      tasks = for _ <- 1..3, do: Task.async(fn -> submit() end)

      times =
        for _ <- 1..3 do
          assert_receive {:smsc, _, %Pdu{command: :submit_sm}}, 1_000
          System.monotonic_time(:millisecond)
        end

      assert Enum.all?(Task.await_many(tasks), &match?({:ok, %{status: 0}}, &1))
      [a, b, c] = times
      assert b - a >= 130 and c - b >= 130
    end

    test "the trunk's TPS (tps × Max Connections) is shared by every caller (Q12)", %{port: port} do
      start_vendor([trunk(port, tps: 2, max_connections: 1)])
      await_bound(1, 1)
      # Start of a second, so all three are counted in the same one.
      Process.sleep(1_000 - rem(System.os_time(:millisecond), 1_000) + 5)
      results = for _ <- 1..3, do: submit()
      assert Enum.count(results, &match?({:ok, _}, &1)) == 2
      assert {:error, :throttled} in results
    end

    test "unknown, inactive and unbound trunks", %{smsc: smsc, port: port} do
      FakeSmsc.set(smsc, :bind_status, 0x0D)
      start_vendor([trunk(port), trunk(port, id: 2, status: :inactive)])
      assert Vendor.submit(9, :submit_sm, %{}) == {:error, :unknown_trunk}
      assert Vendor.submit(2, :submit_sm, %{}) == {:error, :trunk_inactive}
      assert submit() == {:error, :no_connection}
    end

    test "a PDU that cannot be encoded is refused without being sent", %{port: port} do
      start_vendor([trunk(port)])
      await_bound(1, 1)
      assert {:error, {:invalid_pdu, _}} = submit(%{destination_addr: String.duplicate("1", 30)})
    end
  end

  describe "receipts and MO" do
    test "deliver_sm goes to the receipt handler and is answered with its status", %{port: port} do
      start_vendor([trunk(port)])
      {conn, _} = assert_bind()
      await_bound(1, 1)

      FakeSmsc.send_pdu(
        conn,
        Pdu.new(:deliver_sm, %{esm_class: 4, short_message: "id:1 stat:DELIVRD"},
          sequence: 9,
          tlvs: [receipted_message_id: "1"]
        )
      )

      assert_receive {:receipt, context, %Pdu{command: :deliver_sm, sequence: 9}}
      assert context.trunk.id == 1 and context.node == node()
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, sequence: 9, status: 0}}

      Receipts.own(fn _, _ -> {:error, :esme_rx_t_appn} end)
      FakeSmsc.send_pdu(conn, Pdu.new(:deliver_sm, %{esm_class: 4}, sequence: 10))
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, sequence: 10, status: 0x64}}

      Receipts.own(fn _, _ -> raise "boom" end)
      FakeSmsc.send_pdu(conn, Pdu.new(:deliver_sm, %{esm_class: 4}, sequence: 11))
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, sequence: 11, status: 0x08}}

      Receipts.own(fn _, _ -> :what end)
      FakeSmsc.send_pdu(conn, Pdu.new(:data_sm, %{}, sequence: 12))
      assert_receive {:smsc, ^conn, %Pdu{command: :data_sm_resp, sequence: 12, status: 0x08}}
    end

    test "a handler that takes too long is answered with a system error", %{port: port} do
      start_vendor([trunk(port)], session: [receipt_timeout_ms: 100])
      Receipts.own(fn _, _ -> Process.sleep(1_000) && :ok end)
      {conn, _} = assert_bind()
      await_bound(1, 1)
      FakeSmsc.send_pdu(conn, Pdu.new(:deliver_sm, %{}, sequence: 3))

      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, sequence: 3, status: 0x08}},
                     1_000
    end

    test "no connection is opened before the receipts' handler is ready (a server starting)", %{
      port: port
    } do
      alias Sms.Switch.Test.GatedReceipts
      GatedReceipts.close()
      start_vendor([trunk(port)], receipts: GatedReceipts)
      refute_receive {:smsc_connected, _}, 1_500

      GatedReceipts.open()
      assert_bind()
      assert Sms.Switch.Vendor.Receipts.ready?(Sms.Switch.Vendor.Receipts.LogOnly)
    end

    test "the default handler answers OK (Q7, S-5.12)", %{port: port} do
      start_vendor([trunk(port)], receipts: Sms.Switch.Vendor.Receipts.LogOnly)
      {conn, _} = assert_bind()
      await_bound(1, 1)
      FakeSmsc.send_pdu(conn, Pdu.new(:deliver_sm, %{}, sequence: 4))
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, sequence: 4, status: 0}}
    end

    test "a receipt on a TX connection, or a request only a client sends, is refused", %{
      port: port
    } do
      start_vendor([trunk(port, bind_type: :tx)])
      {conn, _} = assert_bind()
      await_bound(1, 1)
      FakeSmsc.send_pdu(conn, Pdu.new(:deliver_sm, %{}, sequence: 6))
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, sequence: 6, status: 0x04}}
      FakeSmsc.send_pdu(conn, Pdu.new(:submit_sm, %{}, sequence: 7))
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm_resp, sequence: 7, status: 0x03}}
    end

    test "a malformed PDU is answered and the connection carries on (S-8.2)", %{port: port} do
      start_vendor([trunk(port)])
      {conn, _} = assert_bind()
      await_bound(1, 1)
      # An unknown command id: generic_nack 0x03, same sequence.
      send(conn, {:send_later, <<16::32, 0x00000999::32, 0::32, 33::32>>})
      assert_receive {:smsc, ^conn, %Pdu{command: :generic_nack, sequence: 33, status: 0x03}}
      FakeSmsc.send_pdu(conn, Pdu.new(:enquire_link, %{}, sequence: 34))
      assert_receive {:smsc, ^conn, %Pdu{command: :enquire_link_resp, sequence: 34}}
    end
  end

  describe "trunk changes" do
    test "new connection settings unbind and bind again at once; other changes apply in place", %{
      port: port
    } do
      start_vendor([trunk(port)])
      {conn, _} = assert_bind()
      await_bound(1, 1)

      reload([trunk(port, tps: 5, window_size: 3, submit_timeout_s: 10)])
      refute_receive {:smsc, _, %Pdu{command: :unbind}}, 200

      reload([trunk(port, tps: 5, password: "rotated")])
      assert_receive {:smsc, ^conn, %Pdu{command: :unbind}}
      {_, bind} = assert_bind()
      assert bind.fields.password == "rotated"
      await_bound(1, 1)
    end

    test "a deactivated or deleted trunk is unbound and its connections stop", %{port: port} do
      start_vendor([trunk(port, max_connections: 2), trunk(port, id: 2)])
      for _ <- 1..3, do: assert_bind()
      await_bound(1, 2)

      reload([trunk(port, max_connections: 2, status: :inactive), trunk(port, id: 2)])
      assert_receive {:smsc, _, %Pdu{command: :unbind}}
      assert_receive {:smsc, _, %Pdu{command: :unbind}}
      await_bound(1, 0)
      assert_eventually(fn -> Map.keys(Manager.sessions()) == [{2, 0}] end)

      reload([])
      assert_receive {:smsc, _, %Pdu{command: :unbind}}
      assert_eventually(fn -> Manager.sessions() == %{} end)
      assert_eventually(fn -> Vendor.sessions() == [] end)
    end

    test "fewer Max Connections closes the extra ones", %{port: port} do
      start_vendor([trunk(port, max_connections: 3)])
      await_bound(1, 3)
      reload([trunk(port, max_connections: 1)])
      await_bound(1, 1)
      assert Map.keys(Manager.sessions()) == [{1, 0}]
    end

    test "a crashed session is started again", %{port: port} do
      start_vendor([trunk(port)])
      assert_bind()
      await_bound(1, 1)
      [{_, pid}] = Map.to_list(Manager.sessions())
      Process.exit(pid, :kill)
      assert_bind(3_000)
      await_bound(1, 1)
    end
  end

  describe "TLS (decision Q9)" do
    setup do
      {certfile, keyfile} = certificate()
      %{certfile: certfile, keyfile: keyfile}
    end

    test "connects at the trunk's TLS version or newer", %{certfile: c, keyfile: k} do
      smsc = start_smsc(tls: [certfile: c, keyfile: k, versions: [:"tlsv1.2"]])
      start_vendor([trunk(FakeSmsc.port(smsc), tls: :"tls1.2")], session: [tls_verify: :none])
      assert_bind()
      await_bound(1, 1)
      assert [%{tls: :"tlsv1.2"}] = Vendor.sessions()
      assert {:ok, %{status: 0}} = submit()
    end

    test "a vendor below the trunk's TLS version is refused", %{certfile: c, keyfile: k} do
      smsc = start_smsc(tls: [certfile: c, keyfile: k, versions: [:"tlsv1.2"]])
      start_vendor([trunk(FakeSmsc.port(smsc), tls: :"tls1.3")], session: [tls_verify: :none])

      assert_eventually(fn ->
        Enum.any?(events("bind_failed"), &(&1["reason"] =~ "connect_failed"))
      end)

      refute_received {:smsc, _, _}
    end

    test "by default the vendor's certificate must be trusted: a self-signed one is refused", %{
      certfile: c,
      keyfile: k
    } do
      smsc = start_smsc(tls: [certfile: c, keyfile: k])
      start_vendor([trunk(FakeSmsc.port(smsc), host: "localhost", tls: :"tls1.2")])

      assert_eventually(fn ->
        Enum.any?(events("bind_failed"), &(&1["reason"] =~ "connect_failed"))
      end)

      refute_received {:smsc, _, _}
    end

    test "TLS 1.0 trunks offer 1.0 and every newer version" do
      opts = Session.tls_options(trunk(1, tls: :"tls1.0"), Session.settings(tls_verify: :none))
      assert opts[:versions] == [:"tlsv1.3", :"tlsv1.2", :"tlsv1.1", :tlsv1]
      assert opts[:verify] == :verify_none

      opts =
        Session.tls_options(trunk(1, tls: :"tls1.3", host: "smsc.example"), Session.settings())

      assert opts[:versions] == [:"tlsv1.3"]
      assert opts[:verify] == :verify_peer and opts[:server_name_indication] == ~c"smsc.example"
    end

    test "a trunk with Skip certificate check binds without checking the vendor's certificate (Q3)" do
      trunk = trunk(1, tls: :"tls1.2", host: "smsc.example", tls_skip_verify: true)
      assert Session.tls_options(trunk, Session.settings())[:verify] == :verify_none
    end

    test "a self-signed vendor certificate is accepted when the trunk skips the check (Q3)", %{
      certfile: c,
      keyfile: k
    } do
      smsc = start_smsc(tls: [certfile: c, keyfile: k])

      start_vendor([
        trunk(FakeSmsc.port(smsc), host: "localhost", tls: :"tls1.2", tls_skip_verify: true)
      ])

      await_bound(1, 1)
    end
  end
end
