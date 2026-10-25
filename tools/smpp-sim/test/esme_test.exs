defmodule SmppSim.EsmeTest do
  # A fake customer against a hand-written server: what the switch may send besides answers.
  use ExUnit.Case, async: false
  alias Sms.Switch.Smpp.Pdu
  alias SmppSim.{Esme, Load, Stats}

  setup do
    Stats.reset()
    {:ok, listen} = :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true])
    {:ok, port} = :inet.port(listen)
    on_exit(fn -> :gen_tcp.close(listen) end)
    %{listen: listen, port: port}
  end

  defp recv_pdu(socket, buffer \\ <<>>) do
    case Pdu.decode(buffer) do
      {:ok, pdu, rest} ->
        {pdu, rest}

      {:incomplete, _} ->
        {:ok, data} = :gen_tcp.recv(socket, 0, 2_000)
        recv_pdu(socket, buffer <> data)
    end
  end

  test "a generic_nack refuses the submit; enquire_link is answered; a bad PDU is answered; unbind closes", %{
    listen: listen,
    port: port
  } do
    {:ok, pid} =
      Esme.start_link(hosts: [{"127.0.0.1", port}], system_id: "e1", password: "x", prefixes: {"44"}, reconnect: false)

    {:ok, s} = :gen_tcp.accept(listen, 2_000)
    {bind, rest} = recv_pdu(s)
    :ok = :gen_tcp.send(s, Pdu.encode!(Pdu.response(bind, :esme_rok, %{system_id: "X"})))
    assert Load.wait_until(fn -> Esme.info(pid).state == :bound end, 2_000)

    Esme.set_rate(pid, 20)
    {submit, rest} = recv_pdu(s, rest)
    Esme.set_rate(pid, 0)
    :ok = :gen_tcp.send(s, Pdu.encode!(Pdu.generic_nack(submit.sequence, :esme_rinvcmdid)))
    :ok = :gen_tcp.send(s, Pdu.encode!(Pdu.new(:enquire_link, %{}, sequence: 90)))
    :ok = :gen_tcp.send(s, <<16::32, 0x00000999::32, 0::32, 91::32>>)
    :ok = :gen_tcp.send(s, Pdu.encode!(Pdu.new(:deliver_sm, %{esm_class: 0, short_message: "MO"}, sequence: 92)))

    replies =
      for _ <- 1..3, reduce: {[], rest} do
        {acc, buf} ->
          {pdu, buf} = recv_pdu(s, buf)
          {acc ++ [pdu.command], buf}
      end

    {commands, _} = replies
    assert :enquire_link_resp in commands
    assert :generic_nack in commands
    assert :deliver_sm_resp in commands
    assert Load.wait_until(fn -> Stats.get(:resp_rejected) == 1 end, 1_000)

    :ok = :gen_tcp.send(s, Pdu.encode!(Pdu.new(:unbind, %{}, sequence: 93)))
    assert Load.wait_until(fn -> Stats.get(:disconnects) == 1 end, 2_000)
    assert Esme.info(pid).state == :connecting
  end
end
