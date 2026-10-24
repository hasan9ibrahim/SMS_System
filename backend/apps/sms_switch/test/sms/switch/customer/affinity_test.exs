defmodule Sms.Switch.Customer.AffinityTest do
  # Spec §13.1: receipts follow the session and IP that sent the message; acceptance tests (a)–(d).
  use Sms.Switch.Test.CustomerCase, async: false
  alias Sms.Switch.Customer.Affinity

  @moduletag capture_log: true
  @ip_a {127, 0, 0, 1}
  @ip_b {127, 0, 0, 2}

  setup do
    start_supervised!(Sms.Core.Bus)
    start_customer(trunks: [trunk(host_ips: [{@ip_a, 32}, {@ip_b, 32}], max_connections: 10)])
  end

  defp bound(port, command, ip) do
    {client, %Pdu{status: 0}} =
      Client.bind(port, command, %{system_id: "acme", password: "secret"}, ip: ip)

    [%{id: id}] = Enum.filter(Customer.sessions(), &(&1.ip == ip and not seen?(&1.id)))
    Process.put({:seen, id}, true)
    {client, id}
  end

  defp seen?(id), do: Process.get({:seen, id}, false)

  defp set_mode(mode) do
    put_trunks([
      trunk(host_ips: [{@ip_a, 32}, {@ip_b, 32}], max_connections: 10, dlr_session_affinity: mode)
    ])

    {:ok, _} = Customer.reload_trunks()
  end

  defp origin(id, ip, bind), do: %{session_id: id, trunk_id: 1, ip: ip, bind: bind}

  # Delivers on a separate process and answers it on whichever client receives it.
  defp deliver_and_answer(origin, mode, clients) do
    task =
      Task.async(fn ->
        Customer.deliver(origin, mode, %{esm_class: 4, short_message: "id:1 stat:DELIVRD"})
      end)

    {receiver, client, pdu} = receive_on(clients)
    Client.send_pdu(client, Pdu.new(:deliver_sm_resp, %{}, sequence: pdu.sequence))
    {receiver, Task.await(task)}
  end

  # Polls every client in turn until one receives the deliver_sm.
  defp receive_on(clients, rounds \\ 100)
  defp receive_on(_clients, 0), do: flunk("no client received the deliver_sm")

  defp receive_on(clients, rounds) do
    Enum.find_value(clients, &poll/1) || receive_on(clients, rounds - 1)
  end

  defp poll({name, client}) do
    case Client.recv(client, 20) do
      {client, %Pdu{command: :deliver_sm} = pdu} -> {name, client, pdu}
      {:error, :timeout} -> nil
    end
  end

  test "(a) two TRX binds from two IPs: each gets only its own receipts", %{port: port} do
    {ca, id_a} = bound(port, :bind_transceiver, @ip_a)
    {cb, id_b} = bound(port, :bind_transceiver, @ip_b)

    for _ <- 1..5 do
      assert {:a, {:ok, ^id_a, %{status: 0}}} =
               deliver_and_answer(origin(id_a, @ip_a, :trx), :strict, a: ca, b: cb)

      assert {:b, {:ok, ^id_b, %{status: 0}}} =
               deliver_and_answer(origin(id_b, @ip_b, :trx), :strict, a: ca, b: cb)
    end
  end

  test "(b) TX + RX from one IP: receipts of TX submits arrive on the RX", %{port: port} do
    {_tx, id_tx} = bound(port, :bind_transmitter, @ip_a)
    {rx, id_rx} = bound(port, :bind_receiver, @ip_a)

    assert {:rx, {:ok, ^id_rx, _}} =
             deliver_and_answer(origin(id_tx, @ip_a, :tx), :strict, rx: rx)
  end

  test "(b') a TX submit's receipt never goes to an RX from another IP, unless Same trunk", %{
    port: port
  } do
    {_tx, id_tx} = bound(port, :bind_transmitter, @ip_a)
    {rx_b, id_b} = bound(port, :bind_receiver, @ip_b)
    assert Customer.deliver(origin(id_tx, @ip_a, :tx), :strict, %{}) == :hold
    assert Customer.deliver(origin(id_tx, @ip_a, :tx), :same_ip, %{}) == :hold

    assert {:rx_b, {:ok, ^id_b, _}} =
             deliver_and_answer(origin(id_tx, @ip_a, :tx), :same_trunk, rx_b: rx_b)
  end

  test "(c) session dropped before the receipt: held, then delivered to the next bind from the same IP",
       %{port: port} do
    {ca, id_a} = bound(port, :bind_transceiver, @ip_a)
    Client.close(ca)
    assert_eventually(fn -> Customer.sessions() == [] end)
    assert Customer.deliver(origin(id_a, @ip_a, :trx), :strict, %{}) == :hold
    {ca2, id_a2} = bound(port, :bind_transceiver, @ip_a)

    assert {:a2, {:ok, ^id_a2, _}} =
             deliver_and_answer(origin(id_a, @ip_a, :trx), :strict, a2: ca2)
  end

  test "(d) a bind from another IP never gets held receipts under Strict or Same IP", %{
    port: port
  } do
    {ca, id_a} = bound(port, :bind_transceiver, @ip_a)
    Client.close(ca)
    assert_eventually(fn -> Customer.sessions() == [] end)
    {cb, id_b} = bound(port, :bind_transceiver, @ip_b)

    for mode <- [:strict, :same_ip] do
      set_mode(mode)
      assert Customer.deliver(origin(id_a, @ip_a, :trx), mode, %{}) == :hold
    end

    assert {:b, {:ok, ^id_b, _}} =
             deliver_and_answer(origin(id_a, @ip_a, :trx), :same_trunk, b: cb)
  end

  test "Strict while the original session lives: only that session, even with another from the same IP",
       %{port: port} do
    {ca, id_a} = bound(port, :bind_transceiver, @ip_a)
    {_ca2, id_a2} = bound(port, :bind_transceiver, @ip_a)
    assert Affinity.candidates(origin(id_a, @ip_a, :trx), :strict) |> length() == 1
    assert {:a, {:ok, ^id_a, _}} = deliver_and_answer(origin(id_a, @ip_a, :trx), :strict, a: ca)
    assert length(Affinity.candidates(origin(id_a, @ip_a, :trx), :same_ip)) == 2
    refute id_a == id_a2
  end

  test "Same IP: a full window on the original session moves the receipt to another session from that IP" do
    stop_supervised!(Sms.Switch.Customer.Supervisor)

    %{port: port} =
      start_customer(
        trunks: [trunk(host_ips: [{@ip_a, 32}], max_connections: 10)],
        session: [outbound_window: 1]
      )

    {ca, id_a} = bound(port, :bind_transceiver, @ip_a)
    {ca2, id_a2} = bound(port, :bind_transceiver, @ip_a)
    blocker = Task.async(fn -> Customer.deliver(origin(id_a, @ip_a, :trx), :strict, %{}) end)
    assert {_ca, %Pdu{command: :deliver_sm}} = Client.recv(ca)
    # The original session's window (1) is now full.
    assert Customer.deliver(origin(id_a, @ip_a, :trx), :strict, %{}) == :hold

    assert {:a2, {:ok, ^id_a2, _}} =
             deliver_and_answer(origin(id_a, @ip_a, :trx), :same_ip, a2: ca2)

    Task.shutdown(blocker, :brutal_kill)
  end

  test "a session that does not answer: {:error, :timeout, session_id} and no second session tried (S-5.14)" do
    stop_supervised!(Sms.Switch.Customer.Supervisor)

    %{port: port} =
      start_customer(
        trunks: [trunk(host_ips: [{@ip_a, 32}], max_connections: 10)],
        session: [deliver_timeout_ms: 100]
      )

    {_ca, id_a} = bound(port, :bind_transceiver, @ip_a)
    {ca2, _} = bound(port, :bind_transceiver, @ip_a)
    assert Customer.deliver(origin(id_a, @ip_a, :trx), :same_ip, %{}) == {:error, :timeout, id_a}
    assert {:error, :timeout} = Client.recv(ca2, 100)
  end

  test "an invalid receipt is refused before anything is sent", %{port: port} do
    {_ca, id_a} = bound(port, :bind_transceiver, @ip_a)

    assert {:error, {:invalid_pdu, _}} =
             Customer.deliver(origin(id_a, @ip_a, :trx), :strict, %{
               source_addr: String.duplicate("9", 30)
             })
  end
end
