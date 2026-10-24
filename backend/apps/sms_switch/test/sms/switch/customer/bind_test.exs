defmodule Sms.Switch.Customer.BindTest do
  # Binds on the customer side: docs/SMPP_SCENARIOS.md S-1.1–S-1.4, S-1.17, spec §5.4.
  use Sms.Switch.Test.CustomerCase, async: false
  import ExUnit.CaptureLog
  alias Sms.Core.Bus.Local
  alias Sms.Switch.Customer.Firewall
  alias Sms.Switch.Smpp.Status
  alias Sms.Switch.Test.FirewallSource

  @moduletag capture_log: true

  setup do
    start_supervised!(Sms.Core.Bus)
    start_customer()
  end

  defp bind(port, command \\ :bind_transceiver, fields \\ %{}, opts \\ []) do
    Client.bind(port, command, Map.merge(%{system_id: "acme", password: "secret"}, fields), opts)
  end

  defp status(%Pdu{status: status}), do: Status.name(status)

  defp reload(trunks) do
    put_trunks(trunks)
    {:ok, _} = Customer.reload_trunks()
  end

  test "a good bind gets bind_resp OK with our system_id and sc_interface_version (S-1.4)", %{
    port: port
  } do
    {client, resp} = bind(port)
    assert resp.command == :bind_transceiver_resp
    assert resp.status == 0
    assert resp.sequence == 1
    assert resp.fields.system_id == "SMSC"
    assert resp.tlvs == [sc_interface_version: 0x34]

    assert [%{trunk_id: 1, bind: :trx, ip: {127, 0, 0, 1}, system_id: "acme"}] =
             Customer.sessions()

    Client.close(client)
  end

  test "a 3.3 client gets no TLV in bind_resp (S-1.4)", %{port: port} do
    {_client, resp} = bind(port, :bind_transmitter, %{interface_version: 0x33})
    assert resp.status == 0
    assert resp.tlvs == []
  end

  test "unknown system_id, wrong password, IP not allowed: precise codes, no session, connection closed (S-1.1)",
       %{port: port} do
    for {fields, expected} <- [
          {%{system_id: "nobody"}, :esme_rinvsysid},
          {%{password: "wrong"}, :esme_rinvpaswd}
        ] do
      {client, resp} = bind(port, :bind_transceiver, fields)
      assert status(resp) == expected
      assert Client.closed?(client)
    end

    reload([trunk(host_ips: [{{10, 0, 0, 0}, 8}])])
    {client, resp} = bind(port)
    assert status(resp) == :esme_rbindfail
    assert Client.closed?(client)
    assert Customer.sessions() == []
  end

  test "an IP check comes before the password check, so a stranger learns nothing about the password",
       %{port: port} do
    reload([trunk(host_ips: [{{10, 0, 0, 0}, 8}])])
    {_client, resp} = bind(port, :bind_transceiver, %{password: "wrong"})
    assert status(resp) == :esme_rbindfail
  end

  test "every failed bind is audited on the bus, without the password (S-1.1)", %{port: port} do
    {_client, _resp} = bind(port, :bind_transmitter, %{password: "wrong"})

    assert_eventually(fn ->
      Enum.any?(Local.published(), fn e ->
        e.subject == "sms.session.customer.bind_failed" and e.data["reason"] == "invalid_password" and
          e.data["trunk_id"] == 1 and e.data["ip"] == "127.0.0.1" and
          not Map.has_key?(e.data, "password")
      end)
    end)
  end

  test "bound and closed events (Network Status, Send Bind)", %{port: port} do
    {client, _} = bind(port)
    Client.close(client)

    assert_eventually(fn ->
      subjects = Enum.map(Local.published(), & &1.subject)
      "sms.session.customer.bound" in subjects and "sms.session.customer.closed" in subjects
    end)
  end

  describe "Firewall (spec §8, S-1.1)" do
    test "past a filter's failed attempts the IP is banned with the filter's ban time, even with the right password",
         %{port: port} do
      for _ <- 1..3 do
        {_client, resp} = bind(port, :bind_transceiver, %{password: "wrong"})
        assert status(resp) == :esme_rinvpaswd
      end

      assert_received {:banned, 1, {127, 0, 0, 1}, expires_at, reason}
      assert_in_delta expires_at, System.os_time(:millisecond) + 60 * 60_000, 5_000
      assert reason == "3 failed SMPP binds within 60 s"
      {_client, resp} = bind(port)
      assert status(resp) == :esme_rbindfail

      assert_eventually(fn ->
        Enum.any?(Local.published(), &(&1.subject == "sms.session.customer.ip_banned"))
      end)
    end

    test "a banned IP's attempts are counted as hits on its rule" do
      stop_supervised!(Sms.Switch.Customer.Supervisor)

      %{port: port} =
        start_customer(
          firewall_rules: %{banned: [%{id: 7, range: {{127, 0, 0, 0}, 8}, expires_at: nil}]}
        )

      for _ <- 1..2 do
        {_client, resp} = bind(port)
        assert status(resp) == :esme_rbindfail
      end

      :ok = Firewall.refresh()
      assert FirewallSource.get().hits == %{7 => 2}
    end

    test "an expired ban no longer blocks" do
      stop_supervised!(Sms.Switch.Customer.Supervisor)
      past = System.os_time(:millisecond) - 1_000

      %{port: port} =
        start_customer(
          firewall_rules: %{banned: [%{id: 7, range: {{127, 0, 0, 1}, 32}, expires_at: past}]}
        )

      {_client, resp} = bind(port)
      assert resp.status == 0
    end

    test "a trusted IP is never banned and never counted" do
      stop_supervised!(Sms.Switch.Customer.Supervisor)

      %{port: port} =
        start_customer(
          firewall_rules: %{
            trusted: [{{127, 0, 0, 1}, 32}],
            banned: [%{id: 7, range: {{127, 0, 0, 0}, 8}, expires_at: nil}]
          }
        )

      for _ <- 1..5, do: bind(port, :bind_transceiver, %{password: "wrong"})
      refute_received {:banned, _, _, _, _}
      {_client, resp} = bind(port)
      assert resp.status == 0
    end

    test "without an active SMPP filter, failed binds ban nobody (and a warning says so)" do
      stop_supervised!(Sms.Switch.Customer.Supervisor)

      log =
        capture_log(fn ->
          %{port: port} = start_customer(firewall_rules: %{filters: []})
          for _ <- 1..5, do: bind(port, :bind_transceiver, %{password: "wrong"})
          {_client, resp} = bind(port)
          assert resp.status == 0
        end)

      refute_received {:banned, _, _, _, _}
      assert log =~ "no active Firewall filter"
    end

    test "each filter counts on its own: the first to reach its threshold bans" do
      stop_supervised!(Sms.Switch.Customer.Supervisor)

      %{port: port} =
        start_customer(
          firewall_rules: %{
            filters: [
              %{id: 1, failed_attempts: 5, window_seconds: 60, ban_minutes: 60},
              %{id: 4, failed_attempts: 2, window_seconds: 60, ban_minutes: 1440}
            ]
          }
        )

      for _ <- 1..2, do: bind(port, :bind_transceiver, %{password: "wrong"})
      assert_received {:banned, 4, {127, 0, 0, 1}, _, _}
      refute_received {:banned, 1, _, _, _}
    end

    test "a successful bind clears the IP's failure counts", %{port: port} do
      for _ <- 1..2, do: bind(port, :bind_transceiver, %{password: "wrong"})
      {client, resp} = bind(port)
      assert resp.status == 0
      Client.close(client)
      for _ <- 1..2, do: bind(port, :bind_transceiver, %{password: "wrong"})
      {_client, resp} = bind(port)
      assert resp.status == 0
      refute_received {:banned, _, _, _, _}
    end
  end

  test "an inactive trunk is refused with 0x0D", %{port: port} do
    reload([trunk(status: :inactive)])
    {_client, resp} = bind(port)
    assert status(resp) == :esme_rbindfail
  end

  test "bind type × trunk setting (S-1.3): AUTO takes all, TX/RX/TR only their own", %{port: port} do
    binds = [bind_transmitter: :tx, bind_receiver: :rx, bind_transceiver: :trx]

    for setting <- [:auto, :tx, :rx, :trx], {command, kind} <- binds do
      reload([trunk(bind_type: setting, max_connections: 10)])
      {client, resp} = bind(port, command)
      expected = if setting in [:auto, kind], do: :esme_rok, else: :esme_rbindfail
      assert status(resp) == expected, "#{setting} trunk, #{command}"
      Client.close(client)
    end
  end

  test "a trunk with a system_type takes only that system_type (0x53); without one, any", %{
    port: port
  } do
    reload([trunk(system_type: "OTP")])
    {_client, resp} = bind(port, :bind_transceiver, %{system_type: "BULK"})
    assert status(resp) == :esme_rinvsystyp
    {client, resp} = bind(port, :bind_transceiver, %{system_type: "OTP"})
    assert resp.status == 0
    Client.close(client)
    reload([trunk(system_type: nil)])
    {_client, resp} = bind(port, :bind_transceiver, %{system_type: "ANY"})
    assert resp.status == 0
  end

  test "Max Connections: one bind too many is refused, existing sessions untouched (S-1.2)", %{
    port: port
  } do
    {c1, r1} = bind(port)
    {c2, r2} = bind(port, :bind_receiver)
    {c3, r3} = bind(port, :bind_transmitter)
    assert {r1.status, r2.status} == {0, 0}
    assert status(r3) == :esme_rbindfail
    assert Client.closed?(c3)
    Client.send_pdu(c1, Pdu.new(:enquire_link, %{}, sequence: 7))
    assert {_, %Pdu{command: :enquire_link_resp, sequence: 7}} = Client.recv(c1)
    # A slot frees when a session ends.
    Client.close(c2)
    assert_eventually(fn -> length(Customer.sessions()) == 1 end)
    {_c4, r4} = bind(port)
    assert r4.status == 0
  end

  test "a second bind on a bound session gets 0x05", %{port: port} do
    {client, _} = bind(port)

    Client.send_pdu(
      client,
      Pdu.new(:bind_transmitter, %{system_id: "acme", password: "secret"}, sequence: 2)
    )

    assert {_, %Pdu{command: :bind_transmitter_resp, sequence: 2} = resp} = Client.recv(client)
    assert status(resp) == :esme_ralybnd
  end

  test "until the trunks are loaded once, binds get a system error (the client retries)" do
    stop_supervised!(Sms.Switch.Customer.Supervisor)

    log =
      capture_log(fn ->
        %{port: port} = start_customer(trunks: {:error, :database_down})
        {_client, resp} = bind(port)
        assert status(resp) == :esme_rsyserr
      end)

    assert log =~ "customer trunks not loaded"
  end

  test "the trunk's saved Port does not limit where it binds (fixed 2775 plain / 2776 TLS)", %{
    port: port
  } do
    reload([trunk(port: 3700)])
    {_client, resp} = bind(port)
    assert resp.status == 0
  end

  test "no bind within the bind timeout: the connection closes" do
    stop_supervised!(Sms.Switch.Customer.Supervisor)
    %{port: port} = start_customer(session: [bind_timeout_ms: 100])
    {:ok, client} = Client.connect(port)
    assert Client.closed?(client, 1_000)
  end

  describe "TLS (S-1.17)" do
    defp tls(versions), do: [tls: [verify: :verify_none, versions: versions]]

    test "a TLS trunk refuses a plain connection", %{port: port} do
      reload([trunk(tls: :"tls1.2")])
      {_client, resp} = bind(port)
      assert status(resp) == :esme_rbindfail
    end

    test "a TLS trunk binds over TLS at its version or newer", %{tls_port: tls_port} do
      reload([trunk(tls: :"tls1.2", max_connections: 10)])
      {_, resp} = bind(tls_port, :bind_transceiver, %{}, tls([:"tlsv1.2"]))
      assert resp.status == 0
      {_, resp} = bind(tls_port, :bind_transceiver, %{}, tls([:"tlsv1.3"]))
      assert resp.status == 0
      reload([trunk(tls: :"tls1.3")])
      {_, resp} = bind(tls_port, :bind_transceiver, %{}, tls([:"tlsv1.2"]))
      assert status(resp) == :esme_rbindfail
    end

    test "the TLS 1.0 legacy option (decision Q9)", %{tls_port: tls_port} do
      reload([trunk(tls: :"tls1.0")])
      {_, resp} = bind(tls_port, :bind_transceiver, %{}, tls([:tlsv1]))
      assert resp.status == 0
    end

    test "a plain trunk also accepts a TLS connection", %{tls_port: tls_port} do
      {_, resp} = bind(tls_port, :bind_transceiver, %{}, tls([:"tlsv1.3"]))
      assert resp.status == 0
    end

    test "a failed TLS handshake ends quietly and leaves the listener working", %{
      tls_port: tls_port,
      port: port
    } do
      {:ok, raw} = Client.connect(tls_port)
      Client.send_raw(raw, "not a TLS hello, just bytes\r\n\r\n")
      assert Client.raw_closed?(raw)
      {_, resp} = bind(port)
      assert resp.status == 0
    end
  end

  test "PROXY LOCAL (a load balancer health check) uses the socket's own address; a bad header closes" do
    stop_supervised!(Sms.Switch.Customer.Supervisor)

    %{proxied_port: port} =
      start_customer(listeners: [[port: 0, name: :proxied, proxy_protocol: true]])

    {:ok, client} = Client.connect(port)
    # PROXY v2, LOCAL command, no addresses.
    Client.send_raw(client, <<13, 10, 13, 10, 0, 13, 10, 81, 85, 73, 84, 10, 0x20, 0x00, 0::16>>)

    Client.send_pdu(
      client,
      Pdu.new(:bind_transceiver, %{system_id: "acme", password: "secret"}, sequence: 1)
    )

    assert {_, %Pdu{status: 0}} = Client.recv(client)
    assert [%{ip: {127, 0, 0, 1}}] = Customer.sessions()
    {:ok, bad} = Client.connect(port)
    Client.send_raw(bad, "HELLO THERE\r\n")
    assert Client.raw_closed?(bad)
  end

  test "PROXY protocol gives the real client IP and port (S-1.15, §13.1 rule 7)" do
    stop_supervised!(Sms.Switch.Customer.Supervisor)

    %{proxied_port: port} =
      start_customer(listeners: [[port: 0, name: :proxied, proxy_protocol: true]])

    reload([trunk(host_ips: [{{203, 0, 113, 9}, 32}])])
    {:ok, client} = Client.connect(port)
    Client.send_raw(client, "PROXY TCP4 203.0.113.9 192.0.2.1 40001 2775\r\n")

    Client.send_pdu(
      client,
      Pdu.new(:bind_transceiver, %{system_id: "acme", password: "secret"}, sequence: 1)
    )

    assert {_, %Pdu{status: 0}} = Client.recv(client)
    assert [%{ip: {203, 0, 113, 9}, port: 40_001}] = Customer.sessions()
  end
end
