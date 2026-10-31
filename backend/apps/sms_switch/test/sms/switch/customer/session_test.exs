defmodule Sms.Switch.Customer.SessionTest do
  # A bound customer session: docs/SMPP_SCENARIOS.md S-1.5–S-1.18, S-2.1–S-2.4, decision D8, §13.1 rule 1.
  use Sms.Switch.Test.CustomerCase, async: false
  import ExUnit.CaptureLog
  alias Sms.Switch.Customer.{Listener, Session}
  alias Sms.Switch.Smpp.Status
  alias Sms.Switch.Test.Intake

  @moduletag capture_log: true

  setup do
    start_supervised!(Sms.Core.Bus)
    start_customer()
  end

  defp bound(port, command \\ :bind_transceiver, opts \\ []) do
    {client, %Pdu{status: 0}} =
      Client.bind(port, command, %{system_id: "acme", password: "secret"}, opts)

    client
  end

  defp submit(seq, fields \\ %{}) do
    Pdu.new(
      :submit_sm,
      Map.merge(
        %{source_addr: "ACME", destination_addr: "4479001234", short_message: "hi"},
        fields
      ),
      sequence: seq
    )
  end

  defp status(%Pdu{status: status}), do: Status.name(status)

  defp recv_n(client, n) do
    Enum.map_reduce(1..n, client, fn _, client ->
      {client, pdu} = Client.recv(client)
      {pdu, client}
    end)
    |> then(fn {pdus, client} -> {client, pdus} end)
  end

  defp session_pid do
    [%{pid: pid}] = Customer.sessions()
    pid
  end

  defp restart(opts) do
    stop_supervised!(Sms.Switch.Customer.Supervisor)
    start_customer(opts)
  end

  describe "requests before and outside the bind" do
    test "a PDU before bind gets 0x04; enquire_link is answered (S-1.11)", %{port: port} do
      {:ok, client} = Client.connect(port)
      Client.send_pdu(client, submit(3))
      assert {client, %Pdu{command: :submit_sm_resp, sequence: 3} = resp} = Client.recv(client)
      assert status(resp) == :esme_rinvbndsts
      Client.send_pdu(client, Pdu.new(:enquire_link, %{}, sequence: 4))
      assert {_, %Pdu{command: :enquire_link_resp, sequence: 4, status: 0}} = Client.recv(client)
    end

    test "submit_sm on a receiver bind gets 0x04 (S-1.12)", %{port: port} do
      client = bound(port, :bind_receiver)
      Client.send_pdu(client, submit(2))
      assert {_, %Pdu{command: :submit_sm_resp} = resp} = Client.recv(client)
      assert status(resp) == :esme_rinvbndsts
      refute_received {:intake, _, _, _}
    end

    test "replace_sm and submit_multi get 0x03 (D8); deliver_sm and outbind from a client get 0x03",
         %{port: port} do
      client = bound(port)

      for {pdu, resp_command} <- [
            {Pdu.new(:replace_sm, %{message_id: "1"}, sequence: 10), :replace_sm_resp},
            {Pdu.new(
               :submit_multi,
               %{dest_addresses: [%{dest_flag: 1, ton: 1, npi: 1, address: "4479"}]},
               sequence: 11
             ), :submit_multi_resp},
            {Pdu.new(:deliver_sm, %{}, sequence: 12), :deliver_sm_resp},
            {Pdu.new(:outbind, %{system_id: "x"}, sequence: 13), :generic_nack}
          ] do
        Client.send_pdu(client, pdu)
        assert {_, %Pdu{command: ^resp_command, sequence: seq} = resp} = Client.recv(client)
        assert seq == pdu.sequence
        assert status(resp) == :esme_rinvcmdid
      end
    end

    test "replace_sm before bind gets 0x04", %{port: port} do
      {:ok, client} = Client.connect(port)
      Client.send_pdu(client, Pdu.new(:replace_sm, %{message_id: "1"}, sequence: 5))
      assert {_, resp} = Client.recv(client)
      assert status(resp) == :esme_rinvbndsts
    end

    test "a response the switch never asked for is ignored", %{port: port} do
      client = bound(port)
      Client.send_pdu(client, Pdu.new(:submit_sm_resp, %{message_id: "x"}, sequence: 77))
      Client.send_pdu(client, Pdu.new(:deliver_sm_resp, %{message_id: ""}, sequence: 78))
      Client.send_pdu(client, Pdu.new(:enquire_link, %{}, sequence: 79))
      assert {_, %Pdu{command: :enquire_link_resp, sequence: 79}} = Client.recv(client)
    end
  end

  describe "message requests (S-2.1, §13.1 rule 1)" do
    test "submit_sm goes to the intake with where it came from; the answer comes back with the same sequence",
         %{port: port} do
      client = bound(port, :bind_transmitter)
      Client.send_pdu(client, submit(42))
      assert_receive {:intake, _pid, context, %Pdu{command: :submit_sm, sequence: 42}}

      assert %{
               origin: %{trunk_id: 1, ip: {127, 0, 0, 1}, bind: :tx, session_id: id},
               trunk: %Trunk{id: 1}
             } = context

      assert [%{id: ^id}] = Customer.sessions()

      assert {_,
              %Pdu{
                command: :submit_sm_resp,
                sequence: 42,
                status: 0,
                fields: %{message_id: "m42"}
              }} =
               Client.recv(client)
    end

    test "data_sm, query_sm and cancel_sm go to the intake too", %{port: port} do
      Intake.own(fn
        _, %Pdu{command: :data_sm} -> {:ok, %{message_id: "d1"}, []}
        _, %Pdu{command: :query_sm} -> {:ok, %{message_id: "m1", message_state: 2}, []}
        _, %Pdu{command: :cancel_sm} -> {:ok, %{}, []}
      end)

      client = bound(port)
      Client.send_pdu(client, Pdu.new(:data_sm, %{destination_addr: "4479"}, sequence: 1))
      Client.send_pdu(client, Pdu.new(:query_sm, %{message_id: "m1"}, sequence: 2))
      Client.send_pdu(client, Pdu.new(:cancel_sm, %{message_id: "m1"}, sequence: 3))

      for command <- [:data_sm, :query_sm, :cancel_sm] do
        assert_receive {:intake, _, _, %Pdu{command: ^command}}
      end

      {client, r1} = Client.recv(client)
      {client, r2} = Client.recv(client)
      {_, r3} = Client.recv(client)
      responses = Enum.sort_by([r1, r2, r3], & &1.sequence)

      assert Enum.map(responses, &{&1.command, &1.status}) == [
               data_sm_resp: 0,
               query_sm_resp: 0,
               cancel_sm_resp: 0
             ]

      assert hd(responses).fields.message_id == "d1"
    end

    test "an intake error status is sent as is, with no body (spec §4.4.2)", %{port: port} do
      Intake.own(fn _, _ -> {:error, :esme_rinvdstadr} end)
      client = bound(port)
      Client.send_pdu(client, submit(5))

      assert {_, %Pdu{command: :submit_sm_resp, sequence: 5, fields: fields} = resp} =
               Client.recv(client)

      assert status(resp) == :esme_rinvdstadr
      assert fields == %{}
    end

    test "an intake that crashes, answers nonsense or an unencodable field: 0x08, never silence (S-2.3)",
         %{port: port} do
      client = bound(port)

      for {reply, seq} <- [
            {fn _, _ -> raise "boom" end, 1},
            {fn _, _ -> :what end, 2},
            {fn _, _ -> {:ok, %{message_id: String.duplicate("9", 80)}, []} end, 3},
            {fn _, _ -> {:error, :no_such_status} end, 4},
            {fn _, _ -> {:error, 0} end, 5}
          ] do
        Intake.own(reply)
        Client.send_pdu(client, submit(seq))
        assert {_, %Pdu{command: :submit_sm_resp, sequence: ^seq} = resp} = Client.recv(client)
        assert status(resp) == :esme_rsyserr
      end
    end

    test "an intake slower than the intake timeout: 0x08; its late answer is dropped" do
      %{port: port} = restart(session: [intake_timeout_ms: 100])

      Intake.own(fn _, _ ->
        Process.sleep(300)
        {:ok, %{message_id: "late"}, []}
      end)

      client = bound(port)
      Client.send_pdu(client, submit(9))
      assert {client, %Pdu{sequence: 9} = resp} = Client.recv(client)
      assert status(resp) == :esme_rsyserr
      assert {:error, :timeout} = Client.recv(client, 500)
    end

    test "requests in flight are answered independently and in completion order", %{port: port} do
      test = self()

      Intake.own(fn _, pdu ->
        if pdu.sequence == 1, do: receive(do: (:release -> :ok))
        send(test, {:answering, pdu.sequence})
        {:ok, %{message_id: "m#{pdu.sequence}"}, []}
      end)

      client = bound(port)
      Client.send_pdu(client, submit(1))
      assert_receive {:intake, slow, _, _}
      Client.send_pdu(client, submit(2))
      assert {client, %Pdu{sequence: 2}} = Client.recv(client)
      send(slow, :release)
      assert {_, %Pdu{sequence: 1}} = Client.recv(client)
    end

    test "a sequence number reused while the first is open: both answered, a warning logged (S-1.13)",
         %{port: port} do
      test = self()

      Intake.own(fn _, pdu ->
        send(test, {:waiting, self()})
        receive(do: (:release -> :ok))
        {:ok, %{message_id: pdu.fields.short_message}, []}
      end)

      client = bound(port)

      log =
        capture_log(fn ->
          Client.send_pdu(client, submit(7, %{short_message: "a"}))
          assert_receive {:waiting, first}
          Client.send_pdu(client, submit(7, %{short_message: "b"}))
          assert_receive {:waiting, second}
          send(first, :release)
          send(second, :release)
          {client, r1} = Client.recv(client)
          {_, r2} = Client.recv(client)
          assert Enum.sort([r1.fields.message_id, r2.fields.message_id]) == ["a", "b"]
          assert r1.sequence == 7 and r2.sequence == 7
        end)

      assert log =~ "reused sequence 7"
    end

    test "several PDUs in one write, and a PDU split over many writes (S-1.8)", %{port: port} do
      client = bound(port)
      Client.send_raw(client, Enum.map(1..5, &Pdu.encode!(submit(&1))))
      {client, pdus} = recv_n(client, 5)
      seqs = Enum.map(pdus, & &1.sequence)
      assert Enum.sort(seqs) == [1, 2, 3, 4, 5]

      for <<byte <- Pdu.encode!(submit(6))>> do
        Client.send_raw(client, <<byte>>)
      end

      assert {_, %Pdu{sequence: 6, status: 0}} = Client.recv(client)
    end

    test "an unknown command id gets generic_nack 0x03 and the session stays up (S-1.10)", %{
      port: port
    } do
      client = bound(port)
      Client.send_raw(client, <<16::32, 0x0000FFFF::32, 0::32, 33::32>>)
      assert {client, %Pdu{command: :generic_nack, sequence: 33} = resp} = Client.recv(client)
      assert status(resp) == :esme_rinvcmdid
      Client.send_pdu(client, submit(34))
      assert {_, %Pdu{sequence: 34, status: 0}} = Client.recv(client)
    end

    test "a bad command_length gets generic_nack 0x02 and the session closes (S-1.9)", %{
      port: port
    } do
      client = bound(port)
      Client.send_raw(client, <<8::32, 0x00000004::32, 0::32, 1::32>>)
      assert {client, %Pdu{command: :generic_nack} = resp} = Client.recv(client)
      assert status(resp) == :esme_rinvcmdlen
      assert Client.closed?(client)
    end

    test "a malformed submit_sm gets its own response with the precise status", %{port: port} do
      client = bound(port)
      # source_addr longer than 21 octets with no NUL inside the limit.
      body = <<0, 1, 1>> <> String.duplicate("1", 30) <> <<0>>

      Client.send_raw(
        client,
        <<16 + byte_size(body)::32, 0x00000004::32, 0::32, 8::32, body::binary>>
      )

      assert {_, %Pdu{command: :submit_sm_resp, sequence: 8} = resp} = Client.recv(client)
      assert status(resp) in [:esme_rinvsrcadr, :esme_rinvcmdlen]
    end
  end

  describe "window and TPS" do
    test "past the inbound window the session stops reading until an answer frees a slot (S-1.18)" do
      %{port: port} = restart(session: [inbound_window: 2])
      test = self()

      Intake.own(fn _, pdu ->
        send(test, {:in_intake, pdu.sequence, self()})
        receive(do: (:release -> :ok))
        {:ok, %{message_id: "m#{pdu.sequence}"}, []}
      end)

      client = bound(port)
      Client.send_raw(client, Enum.map(1..3, &Pdu.encode!(submit(&1))))
      assert_receive {:in_intake, 1, p1}
      assert_receive {:in_intake, 2, _p2}
      refute_receive {:in_intake, 3, _}, 200
      send(p1, :release)
      assert_receive {:in_intake, 3, _p3}
    end

    test "over the trunk's TPS (tps × max_connections) a submit gets 0x58 (S-2.4)", %{port: port} do
      put_trunks([trunk(tps: 2, max_connections: 1)])
      {:ok, _} = Customer.reload_trunks()
      client = bound(port)
      Client.send_raw(client, Enum.map(1..4, &Pdu.encode!(submit(&1))))
      {_client, pdus} = recv_n(client, 4)
      statuses = Enum.map(Enum.sort_by(pdus, & &1.sequence), &status/1)
      assert :esme_rthrottled in statuses
      assert length(Enum.filter(statuses, &(&1 == :esme_rok))) in 1..2
    end

    test "over the business company's TPS a submit gets 0x58 (S-2.4)", %{port: port} do
      put_trunks([trunk(business_company_id: 9, company_tps_limit: 1)])
      {:ok, _} = Customer.reload_trunks()
      client = bound(port)
      Client.send_raw(client, Enum.map(1..3, &Pdu.encode!(submit(&1))))
      {_client, pdus} = recv_n(client, 3)
      statuses = Enum.map(Enum.sort_by(pdus, & &1.sequence), &status/1)
      assert :esme_rthrottled in statuses
    end

    test "query_sm is not counted against TPS", %{port: port} do
      put_trunks([trunk(tps: 1, max_connections: 1)])
      {:ok, _} = Customer.reload_trunks()
      client = bound(port)

      Client.send_raw(
        client,
        Enum.map(1..3, &Pdu.encode!(Pdu.new(:query_sm, %{message_id: "1"}, sequence: &1)))
      )

      {_client, pdus} = recv_n(client, 3)
      statuses = Enum.map(Enum.sort_by(pdus, & &1.sequence), &status/1)
      assert statuses == [:esme_rok, :esme_rok, :esme_rok]
    end
  end

  describe "unbind (S-1.7)" do
    test "answers already being decided go out before unbind_resp, then the connection closes", %{
      port: port
    } do
      Intake.own(fn _, pdu ->
        Process.sleep(150)
        {:ok, %{message_id: "m#{pdu.sequence}"}, []}
      end)

      client = bound(port)
      Client.send_pdu(client, submit(1))
      Client.send_pdu(client, Pdu.new(:unbind, %{}, sequence: 2))

      assert {client, %Pdu{command: :submit_sm_resp, sequence: 1, status: 0}} =
               Client.recv(client)

      assert {client, %Pdu{command: :unbind_resp, sequence: 2, status: 0}} = Client.recv(client)
      assert Client.closed?(client)
    end

    test "with nothing in flight, unbind is answered at once; a second unbind meanwhile gets 0x04",
         %{port: port} do
      client = bound(port)
      Client.send_pdu(client, Pdu.new(:unbind, %{}, sequence: 2))
      assert {client, %Pdu{command: :unbind_resp, sequence: 2, status: 0}} = Client.recv(client)
      assert Client.closed?(client)

      Intake.own(fn _, _ ->
        Process.sleep(200)
        {:ok, %{message_id: "x"}, []}
      end)

      client = bound(port)
      Client.send_pdu(client, submit(1))
      Client.send_pdu(client, Pdu.new(:unbind, %{}, sequence: 2))
      Client.send_pdu(client, Pdu.new(:unbind, %{}, sequence: 3))
      assert {client, %Pdu{command: :unbind_resp, sequence: 3} = resp} = Client.recv(client)
      assert status(resp) == :esme_rinvbndsts
      assert {client, %Pdu{sequence: 1}} = Client.recv(client)
      assert {_, %Pdu{command: :unbind_resp, sequence: 2, status: 0}} = Client.recv(client)
    end

    test "a submit after unbind gets 0x04", %{port: port} do
      Intake.own(fn _, _ ->
        Process.sleep(200)
        {:ok, %{message_id: "x"}, []}
      end)

      client = bound(port)
      Client.send_pdu(client, submit(1))
      Client.send_pdu(client, Pdu.new(:unbind, %{}, sequence: 2))
      Client.send_pdu(client, submit(3))
      assert {client, %Pdu{sequence: 3} = resp} = Client.recv(client)
      assert status(resp) == :esme_rinvbndsts
      assert {client, %Pdu{sequence: 1}} = Client.recv(client)
      assert {_, %Pdu{command: :unbind_resp}} = Client.recv(client)
    end

    test "answers still pending after the unbind timeout: unbind_resp is sent anyway" do
      %{port: port} = restart(session: [unbind_timeout_ms: 100])

      Intake.own(fn _, _ ->
        Process.sleep(1_000)
        {:ok, %{message_id: "x"}, []}
      end)

      client = bound(port)
      Client.send_pdu(client, submit(1))
      Client.send_pdu(client, Pdu.new(:unbind, %{}, sequence: 2))
      assert {_, %Pdu{command: :unbind_resp}} = Client.recv(client)
    end

    test "unbind on an unbound connection is answered and the connection closes", %{port: port} do
      {:ok, client} = Client.connect(port)
      Client.send_pdu(client, Pdu.new(:unbind, %{}, sequence: 1))
      assert {client, %Pdu{command: :unbind_resp, status: 0}} = Client.recv(client)
      assert Client.closed?(client)
    end

    test "a client that closes while its answer is being decided: the answer is dropped and logged (S-2.6)",
         %{port: port} do
      Intake.own(fn _, _ ->
        Process.sleep(200)
        {:ok, %{message_id: "x"}, []}
      end)

      client = bound(port)

      log =
        capture_log(fn ->
          Client.send_pdu(client, submit(1))
          assert_receive {:intake, _, _, _}
          Client.close(client)
          Process.sleep(400)
        end)

      assert log =~ "session lost before response"
    end
  end

  describe "keep-alive (S-1.5, S-1.6)" do
    setup do
      restart(session: [enquire_link_interval_ms: 100, enquire_link_timeout_ms: 150, tick_ms: 20])
    end

    test "an idle client gets enquire_link; answering keeps the session", %{port: port} do
      client = bound(port)
      assert {client, %Pdu{command: :enquire_link, sequence: seq}} = Client.recv(client, 1_000)
      Client.send_pdu(client, Pdu.new(:enquire_link_resp, %{}, sequence: seq))
      assert {client, %Pdu{command: :enquire_link}} = Client.recv(client, 1_000)
      refute Client.closed?(client, 50)
    end

    test "a client that stops answering is closed after the timeout", %{port: port} do
      client = bound(port)
      assert {client, %Pdu{command: :enquire_link}} = Client.recv(client, 1_000)
      assert Client.closed?(client, 1_000)
    end

    test "a client that sends traffic but ignores enquire_link stays up", %{port: port} do
      client = bound(port)
      assert {client, %Pdu{command: :enquire_link}} = Client.recv(client, 1_000)

      client =
        Enum.reduce(1..8, client, fn i, client ->
          Process.sleep(50)
          Client.send_pdu(client, Pdu.new(:enquire_link, %{}, sequence: 100 + i))
          drain_until(client, :enquire_link_resp)
        end)

      Client.send_pdu(client, submit(1))
      assert drain_until(client, :submit_sm_resp)
    end

    test "an unbound connection is closed by the bind timeout, keep-alive or not" do
      %{port: port} =
        restart(session: [bind_timeout_ms: 150, enquire_link_interval_ms: 50, tick_ms: 20])

      {:ok, client} = Client.connect(port)
      assert Client.closed?(client, 1_000)
    end

    test "while the inbound window is full the session reads nothing, and never times the client out (S-1.18)" do
      %{port: port} =
        restart(
          session: [
            inbound_window: 2,
            enquire_link_interval_ms: 200,
            enquire_link_timeout_ms: 200,
            tick_ms: 20
          ]
        )

      # A slow intake (a Delayed Submit trunk waiting for its vendor, a slow HLR): 1.5 s per request.
      Intake.own(fn _, pdu ->
        Process.sleep(1_500)
        {:ok, %{message_id: "m#{pdu.sequence}"}, []}
      end)

      client = bound(port)
      Client.send_raw(client, [Pdu.encode!(submit(2)), Pdu.encode!(submit(3))])
      seen = answer_enquire_links(client, System.monotonic_time(:millisecond) + 2_500, [])
      assert {:submit_sm_resp, 2, 0} in seen
      assert {:submit_sm_resp, 3, 0} in seen
    end
  end

  # Answers every enquire_link until `deadline`; the other PDUs seen, in order. Fails if the session closes.
  defp answer_enquire_links(client, deadline, seen) do
    case Client.recv(client, max(deadline - System.monotonic_time(:millisecond), 0)) do
      {:error, :timeout} ->
        Enum.reverse(seen)

      {client, %Pdu{command: :enquire_link} = pdu} ->
        Client.send_pdu(client, Pdu.response(pdu))
        answer_enquire_links(client, deadline, seen)

      {client, pdu} ->
        answer_enquire_links(client, deadline, [{pdu.command, pdu.sequence, pdu.status} | seen])
    end
  end

  defp drain_until(client, command) do
    case Client.recv(client, 1_000) do
      {client, %Pdu{command: ^command}} -> client
      {client, _other} -> drain_until(client, command)
    end
  end

  describe "deliver_sm to the client" do
    test "a receipt is sent and the client's answer comes back with the session id", %{port: port} do
      client = bound(port)
      pid = session_pid()

      task =
        Task.async(fn ->
          Session.deliver(pid, %{source_addr: "4479", destination_addr: "ACME", esm_class: 4})
        end)

      assert {client, %Pdu{command: :deliver_sm, sequence: seq, fields: %{esm_class: 4}}} =
               Client.recv(client)

      Client.send_pdu(client, Pdu.new(:deliver_sm_resp, %{message_id: ""}, sequence: seq))
      assert {:ok, %{status: 0, session_id: id}} = Task.await(task)
      assert [%{id: ^id}] = Customer.sessions()
    end

    test "a client refusing the receipt: its status comes back", %{port: port} do
      client = bound(port)
      pid = session_pid()
      task = Task.async(fn -> Session.deliver(pid, %{}) end)
      assert {client, %Pdu{command: :deliver_sm, sequence: seq}} = Client.recv(client)
      Client.send_pdu(client, Pdu.new(:deliver_sm_resp, %{}, sequence: seq, status: 0x08))
      assert {:ok, %{status: 8}} = Task.await(task)
      Client.close(client)
    end

    test "a generic_nack from the client answers the deliver_sm", %{port: port} do
      client = bound(port)
      pid = session_pid()
      task = Task.async(fn -> Session.deliver(pid, %{}) end)
      assert {client, %Pdu{command: :deliver_sm, sequence: seq}} = Client.recv(client)
      Client.send_pdu(client, Pdu.generic_nack(seq, :esme_rinvcmdid))
      assert {:ok, %{status: 3}} = Task.await(task)
      Client.close(client)
    end

    test "a receipt waits for the submits in flight, so their submit_sm_resp goes first (S-5.5)",
         %{port: port} do
      test = self()

      Intake.own(fn _, pdu ->
        send(test, {:waiting, self()})

        receive do
          :go -> {:ok, %{message_id: "m#{pdu.sequence}"}, []}
        end
      end)

      client = bound(port)
      pid = session_pid()

      Client.send_pdu(
        client,
        Pdu.new(:submit_sm, %{destination_addr: "4479", short_message: "x"}, sequence: 5)
      )

      assert_receive {:waiting, intake}
      task = Task.async(fn -> Session.deliver(pid, %{esm_class: 4}) end)
      assert {:error, :timeout} = Client.recv(client, 200)

      send(intake, :go)
      assert {client, %Pdu{command: :submit_sm_resp, sequence: 5}} = Client.recv(client)
      assert {client, %Pdu{command: :deliver_sm, sequence: seq}} = Client.recv(client)
      Client.send_pdu(client, Pdu.new(:deliver_sm_resp, %{message_id: ""}, sequence: seq))
      assert {:ok, %{status: 0}} = Task.await(task)
    end

    test "a receipt waits at most a second for a slow submit", %{port: port} do
      Intake.own(fn _, _ -> Process.sleep(3_000) && {:error, :esme_rsyserr} end)
      client = bound(port)
      pid = session_pid()

      Client.send_pdu(
        client,
        Pdu.new(:submit_sm, %{destination_addr: "4479", short_message: "x"}, sequence: 5)
      )

      assert_receive {:intake, _, _, _}
      task = Task.async(fn -> Session.deliver(pid, %{esm_class: 4}) end)
      assert {client, %Pdu{command: :deliver_sm, sequence: seq}} = Client.recv(client, 2_000)
      Client.send_pdu(client, Pdu.new(:deliver_sm_resp, %{message_id: ""}, sequence: seq))
      assert {:ok, %{status: 0}} = Task.await(task)
    end

    test "a TX bind cannot receive", %{port: port} do
      _client = bound(port, :bind_transmitter)
      assert Session.deliver(session_pid(), %{}) == {:error, :not_receiver}
    end

    test "the outbound window: past it, :window_full at once (S-1.18)" do
      %{port: port} = restart(session: [outbound_window: 2])
      _client = bound(port)
      pid = session_pid()
      tasks = for _ <- 1..2, do: Task.async(fn -> Session.deliver(pid, %{}) end)
      assert_eventually(fn -> Session.info(pid).deliver_pending == 2 end)
      assert Session.deliver(pid, %{}) == {:error, :window_full}
      Enum.each(tasks, &Task.shutdown(&1, :brutal_kill))
    end

    test "no answer within the deliver timeout: {:error, :timeout} (S-5.14)" do
      %{port: port} = restart(session: [deliver_timeout_ms: 100])
      _client = bound(port)
      assert Session.deliver(session_pid(), %{}) == {:error, :timeout}
    end

    test "after a timeout a slow reader takes no receipt until it answers one, or for the timeout (S-1.18)" do
      %{port: port} = restart(session: [deliver_timeout_ms: 300])
      client = bound(port)
      pid = session_pid()
      assert Session.deliver(pid, %{}) == {:error, :timeout}
      assert {client, %Pdu{command: :deliver_sm} = late} = Client.recv(client)
      # At once, without waiting for the client.
      assert Session.deliver(pid, %{}) == {:error, :slow}

      # A late answer shows the client reading again.
      Client.send_pdu(client, Pdu.response(late, :esme_rok, %{message_id: ""}))
      Process.sleep(100)
      task = Task.async(fn -> Session.deliver(pid, %{}) end)
      assert {client, %Pdu{command: :deliver_sm} = dlr} = Client.recv(client)
      Client.send_pdu(client, Pdu.response(dlr, :esme_rok, %{message_id: ""}))
      assert {:ok, %{status: 0}} = Task.await(task)

      # Silent again: slow until the timeout has passed once more.
      assert Session.deliver(pid, %{}) == {:error, :timeout}
      assert Session.deliver(pid, %{}) == {:error, :slow}
      Process.sleep(350)
      assert Session.deliver(pid, %{}) == {:error, :timeout}
      _ = client
    end

    test "the session closing: waiting deliveries get :closed", %{port: port} do
      client = bound(port)
      pid = session_pid()
      task = Task.async(fn -> Session.deliver(pid, %{}) end)
      assert {client, %Pdu{command: :deliver_sm}} = Client.recv(client)
      Client.close(client)
      assert Task.await(task) == {:error, :closed}
      assert Session.deliver(pid, %{}) == {:error, :closed}
    end

    test "an invalid deliver_sm is refused before anything is sent", %{port: port} do
      _client = bound(port)

      assert {:error, {:invalid_pdu, _}} =
               Session.deliver(session_pid(), %{source_addr: String.duplicate("1", 40)})
    end

    test "sequence numbers wrap from 0x7FFFFFFF to 1 and skip numbers still waiting (S-1.14)", %{
      port: port
    } do
      client = bound(port)
      pid = session_pid()
      :sys.replace_state(pid, &%{&1 | next_seq: 0x7FFFFFFF})
      t1 = Task.async(fn -> Session.deliver(pid, %{}) end)
      assert {client, %Pdu{sequence: 0x7FFFFFFF}} = Client.recv(client)
      t2 = Task.async(fn -> Session.deliver(pid, %{}) end)
      assert {client, %Pdu{sequence: 1}} = Client.recv(client)
      # 2 is taken by a request still waiting: the next one skips it.
      :sys.replace_state(pid, fn s ->
        %{s | next_seq: 1, out: Map.put(s.out, 2, %{command: :deliver_sm, from: nil, timer: nil})}
      end)

      t3 = Task.async(fn -> Session.deliver(pid, %{}) end)
      assert {client, %Pdu{sequence: 3}} = Client.recv(client)

      for {task, seq} <- [{t1, 0x7FFFFFFF}, {t2, 1}, {t3, 3}] do
        Client.send_pdu(client, Pdu.new(:deliver_sm_resp, %{}, sequence: seq))
        assert {:ok, %{status: 0}} = Task.await(task)
      end
    end

    test "info/1 describes the session", %{port: port} do
      _client = bound(port)

      assert %{phase: :bound, bind: :trx, trunk_id: 1, inflight: 0, tls: nil} =
               Session.info(session_pid())
    end
  end

  describe "trunk changes" do
    test "a trunk deactivated, deleted or with new credentials unbinds its sessions", %{
      port: port
    } do
      for change <- [
            [trunk(status: :inactive)],
            [],
            [trunk(password: "newpass")],
            [trunk(host_ips: [])]
          ] do
        put_trunks([trunk()])
        {:ok, _} = Customer.reload_trunks()
        client = bound(port)
        put_trunks(change)
        {:ok, _} = Customer.reload_trunks()
        assert {client, %Pdu{command: :unbind, sequence: seq}} = Client.recv(client)
        Client.send_pdu(client, Pdu.new(:unbind_resp, %{}, sequence: seq))
        assert Client.closed?(client)
      end
    end

    test "a client that does not answer our unbind is closed after the unbind timeout" do
      %{port: port} = restart(session: [unbind_timeout_ms: 100])
      client = bound(port)
      put_trunks([trunk(status: :inactive)])
      {:ok, _} = Customer.reload_trunks()
      assert {client, %Pdu{command: :unbind}} = Client.recv(client)
      assert Client.closed?(client, 1_000)
    end

    test "submits sent while we unbind get 0x58 (the client retries elsewhere)" do
      %{port: port} = restart(session: [unbind_timeout_ms: 1_000])
      client = bound(port)
      Session.stop(session_pid(), :test)
      assert {client, %Pdu{command: :unbind}} = Client.recv(client)
      Client.send_pdu(client, submit(5))
      assert {_, %Pdu{sequence: 5} = resp} = Client.recv(client)
      assert status(resp) == :esme_rthrottled
    end

    test "other changes (TPS) update the session in place", %{port: port} do
      client = bound(port)
      put_trunks([trunk(tps: 7)])
      {:ok, _} = Customer.reload_trunks()
      assert_eventually(fn -> :sys.get_state(session_pid()).trunk.tps == 7 end)
      Client.send_pdu(client, submit(1))
      assert {_, %Pdu{sequence: 1, status: 0}} = Client.recv(client)
    end
  end

  describe "draining (S-1.16)" do
    test "submits get 0x58, new connections are refused; resume undoes it", %{port: port} do
      client = bound(port)
      :ok = Customer.drain()
      on_exit(fn -> :persistent_term.erase({Customer, :draining}) end)
      assert Customer.draining?()
      Client.send_pdu(client, submit(1))
      assert {client, %Pdu{sequence: 1} = resp} = Client.recv(client)
      assert status(resp) == :esme_rthrottled
      Client.send_pdu(client, Pdu.new(:query_sm, %{message_id: "1"}, sequence: 2))
      assert {_, %Pdu{sequence: 2, status: 0}} = Client.recv(client)

      assert {:error, _} =
               Client.connect(port)
               |> then(fn
                 {:ok, c} -> Client.recv(c, 300)
                 error -> error
               end)

      :ok = Customer.resume()
      refute Customer.draining?()
      # A listener on port 0 (tests only) listens on a new free port when it resumes.
      port = Listener.port(Listener.ref(:plain))

      assert {_c, %Pdu{status: 0}} =
               Client.bind(port, :bind_receiver, %{system_id: "acme", password: "secret"})
    end

    test "a stopping node unbinds its sessions so clients move to the other server", %{port: port} do
      client = bound(port)
      stop_supervised!(Sms.Switch.Customer.Supervisor)
      assert {_, %Pdu{command: :unbind}} = Client.recv(client)
    end

    test "a stopping node waits briefly for the client's unbind_resp, reading past other PDUs", %{
      port: port
    } do
      client = bound(port)
      test = self()

      answerer =
        spawn_link(fn ->
          {client, %Pdu{command: :unbind, sequence: seq}} = Client.recv(client, 5_000)
          Client.send_pdu(client, Pdu.new(:enquire_link, %{}, sequence: 900))
          Client.send_pdu(client, Pdu.new(:unbind_resp, %{}, sequence: seq))
          send(test, {:answered, Client.closed?(client)})
        end)

      :ok = :gen_tcp.controlling_process(client.socket, answerer)
      stop_supervised!(Sms.Switch.Customer.Supervisor)
      assert_receive {:answered, true}, 5_000
    end

    test "our unbind on a connection that never bound just closes it", %{port: port} do
      {:ok, client} = Client.connect(port)
      # The listener accepts asynchronously: wait for the connection's process.
      assert_eventually(fn -> length(:ranch.procs(Listener.ref(:plain), :connections)) == 1 end)
      [pid] = :ranch.procs(Listener.ref(:plain), :connections)
      Session.stop(pid, :test)
      assert Client.closed?(client)
    end
  end
end
