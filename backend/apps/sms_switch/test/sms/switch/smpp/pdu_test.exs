defmodule Sms.Switch.Smpp.PduTest do
  use ExUnit.Case, async: true
  alias Sms.Switch.Smpp.{Command, Pdu, Status}
  alias Sms.Switch.Smpp.Pdu.Error

  defp header(len, id, status, seq), do: <<len::32, id::32, status::32, seq::32>>

  defp frame(id, body, seq \\ 7, status \\ 0),
    do: header(16 + byte_size(body), id, status, seq) <> body

  defp c(s), do: s <> <<0>>

  defp submit_body(opts \\ []) do
    c(Keyword.get(opts, :service, "")) <>
      <<1, 1>> <>
      c(Keyword.get(opts, :src, "447700900123")) <>
      <<1, 1>> <>
      c(Keyword.get(opts, :dst, "61412345678")) <>
      <<0, 0, 0>> <>
      c(Keyword.get(opts, :sched, "")) <>
      c("") <>
      <<1, 0, 0, 0>> <>
      Keyword.get(opts, :sm, <<5, "hello">>)
  end

  describe "byte vectors (spec §4)" do
    test "enquire_link and its response are a bare 16-octet header" do
      bin = <<0, 0, 0, 16, 0, 0, 0, 0x15, 0, 0, 0, 0, 0, 0, 0, 1>>

      assert {:ok, %Pdu{command: :enquire_link, sequence: 1, fields: %{}, tlvs: []}, ""} =
               Pdu.decode(bin)

      assert Pdu.encode!(Pdu.new(:enquire_link, %{}, sequence: 1)) == bin

      resp = Pdu.response(%Pdu{command: :enquire_link, sequence: 1})
      assert Pdu.encode!(resp) == <<0, 0, 0, 16, 0x80, 0, 0, 0x15, 0, 0, 0, 0, 0, 0, 0, 1>>
    end

    test "bind_transmitter" do
      body = c("smppclient1") <> c("password") <> c("") <> <<0x34, 0, 0>> <> c("")
      bin = frame(0x02, body, 1)

      fields = %{
        system_id: "smppclient1",
        password: "password",
        system_type: "",
        interface_version: 0x34,
        addr_ton: 0,
        addr_npi: 0,
        address_range: ""
      }

      assert {:ok, %Pdu{command: :bind_transmitter, fields: ^fields}, ""} = Pdu.decode(bin)
      assert Pdu.encode!(Pdu.new(:bind_transmitter, fields, sequence: 1)) == bin
    end

    test "submit_sm, and its response with the message id" do
      bin = frame(0x04, submit_body())
      assert {:ok, %Pdu{command: :submit_sm, sequence: 7, fields: f}, ""} = Pdu.decode(bin)
      assert f.source_addr == "447700900123"
      assert f.destination_addr == "61412345678"
      assert f.registered_delivery == 1
      assert f.short_message == "hello"
      assert Pdu.encode!(%Pdu{command: :submit_sm, sequence: 7, fields: f}) == bin

      resp = Pdu.response(%Pdu{command: :submit_sm, sequence: 7}, :esme_rok, %{message_id: "abc"})
      assert Pdu.encode!(resp) == frame(0x80000004, c("abc"))
    end

    test "deliver_sm receipt with TLVs; receipted_message_id without its NUL is accepted" do
      tlvs = <<0x001E::16, 3::16, "abc", 0x0427::16, 1::16, 2, 0x0423::16, 3::16, 3, 0, 1>>
      bin = frame(0x05, submit_body(sm: <<0>>) <> tlvs)
      assert {:ok, %Pdu{command: :deliver_sm, tlvs: decoded}, ""} = Pdu.decode(bin)

      assert decoded == [
               receipted_message_id: "abc",
               message_state: 2,
               network_error_code: <<3, 0, 1>>
             ]

      {:ok, again} =
        Pdu.encode(%Pdu{
          command: :deliver_sm,
          sequence: 7,
          fields: elem(Pdu.decode(bin), 1).fields,
          tlvs: decoded
        })

      assert {:ok, %Pdu{tlvs: ^decoded}, ""} = Pdu.decode(again)
    end

    test "generic_nack" do
      assert {:ok, %Pdu{command: :generic_nack, status: 3, sequence: 9}, ""} =
               Pdu.decode(header(16, 0x80000000, 3, 9))

      assert Pdu.encode!(Pdu.generic_nack(9, :esme_rinvcmdid)) == header(16, 0x80000000, 3, 9)
    end
  end

  describe "framing (S-1.8, S-1.9)" do
    test "fewer bytes than the frame: incomplete, with how many are missing" do
      bin = frame(0x04, submit_body())

      for n <- 0..(byte_size(bin) - 1) do
        expected = if n < 4, do: 4 - n, else: byte_size(bin) - n
        assert Pdu.decode(binary_part(bin, 0, n)) == {:incomplete, expected}
      end
    end

    test "two PDUs in one read: the first, then the rest" do
      a = frame(0x15, "", 1)
      b = frame(0x15, "", 2)
      assert {:ok, %Pdu{sequence: 1}, ^b} = Pdu.decode(a <> b)
    end

    test "command_length below 16 or above the maximum is fatal" do
      assert {:error,
              %Error{status: :esme_rinvcmdlen, fatal: true, reason: {:command_length, 15}}, ""} =
               Pdu.decode(header(15, 0x15, 0, 1))

      assert {:error, %Error{fatal: true, sequence: 3, command: :submit_sm}, ""} =
               Pdu.decode(header(1_000_000, 0x04, 0, 3))

      assert {:error, %Error{fatal: true}, ""} =
               Pdu.decode(header(100, 0x04, 0, 3), max_length: 64)

      assert {:error, %Error{fatal: true, sequence: nil}, ""} = Pdu.decode(<<0, 0, 0, 2, 9>>)

      assert %Pdu{command: :generic_nack, status: 2} =
               Pdu.error_reply(elem(Pdu.decode(header(15, 0x15, 0, 1)), 1))
    end
  end

  describe "errors inside a well-framed PDU: precise status, same sequence, stream continues" do
    test "unknown command_id (S-1.10): generic_nack 0x03 with the same sequence" do
      next = frame(0x15, "", 2)

      assert {:error, %Error{status: :esme_rinvcmdid, sequence: 5} = e, ^next} =
               Pdu.decode(header(16, 0xFFFF, 0, 5) <> next)

      assert %Pdu{command: :generic_nack, status: 3, sequence: 5} = Pdu.error_reply(e)
      assert Exception.message(e) =~ "esme_rinvcmdid"
    end

    test "a field longer than the spec allows is answered with that field's status" do
      cases = [
        {submit_body(src: String.duplicate("1", 21)), :esme_rinvsrcadr, 0x0A},
        {submit_body(dst: String.duplicate("1", 21)), :esme_rinvdstadr, 0x0B},
        {submit_body(service: "TOOLONG"), :esme_rinvsertyp, 0x15},
        {submit_body(sched: "not a time"), :esme_rinvsched, 0x61},
        {submit_body(sm: <<200, "short">>), :esme_rinvmsglen, 0x01},
        {submit_body(sm: <<255>> <> String.duplicate("x", 255)), :esme_rinvmsglen, 0x01}
      ]

      for {body, status, code} <- cases do
        assert {:error, %Error{status: ^status, command: :submit_sm, sequence: 7} = e, ""} =
                 Pdu.decode(frame(0x04, body))

        assert %Pdu{command: :submit_sm_resp, status: ^code, sequence: 7} = Pdu.error_reply(e)
      end
    end

    test "a truncated body is a length error" do
      assert {:error, %Error{status: :esme_rinvcmdlen, reason: {:source_addr, :unterminated}}, ""} =
               Pdu.decode(frame(0x04, c("") <> <<1, 1, "4477">>))

      for cut <- [
            c(""),
            c("") <> <<1, 1>> <> c("1") <> <<1, 1>> <> c("2") <> <<0, 0, 0, 0, 0, 1, 0, 0, 0>>
          ] do
        assert {:error, %Error{status: :esme_rinvcmdlen}, ""} = Pdu.decode(frame(0x04, cut))
      end
    end

    test "valid schedule and validity times pass; relative times end in R" do
      for t <- ["261024120000000+", "261024120000004-", "000001000000000R"] do
        assert {:ok, %Pdu{fields: %{schedule_delivery_time: ^t}}, ""} =
                 Pdu.decode(frame(0x04, submit_body(sched: t)))
      end
    end

    test "TLV stream errors: broken stream, wrong length for a known tag" do
      assert {:error, %Error{status: :esme_rinvoptparstream}, ""} =
               Pdu.decode(frame(0x04, submit_body() <> <<0x02, 0x0C>>))

      assert {:error, %Error{status: :esme_rinvparlen}, ""} =
               Pdu.decode(frame(0x04, submit_body() <> <<0x020C::16, 1::16, 9>>))

      assert {:error, %Error{status: :esme_rinvoptparstream}, ""} =
               Pdu.decode(frame(0x04, submit_body() <> <<0x0424::16, 10::16, "abc">>))
    end

    test "unknown and vendor-specific TLVs are kept and encoded back unchanged" do
      tlvs = <<0x1401::16, 2::16, "ab", 0x0424::16, 0::16>>
      {:ok, pdu, ""} = Pdu.decode(frame(0x04, submit_body(sm: <<0>>) <> tlvs))
      assert pdu.tlvs == [{0x1401, "ab"}, {:message_payload, ""}]
      assert Pdu.encode!(pdu) == frame(0x04, submit_body(sm: <<0>>) <> tlvs)
    end

    test "submit_multi destination lists" do
      head = c("") <> <<1, 1>> <> c("4477")
      tail = <<0, 0, 0>> <> c("") <> c("") <> <<0, 0, 0, 0, 2, "hi">>
      dests = <<2, 1, 1, 1>> <> c("6141") <> <<2>> <> c("staff")
      assert {:ok, %Pdu{fields: f}, ""} = Pdu.decode(frame(0x21, head <> dests <> tail))

      assert f.dest_addresses == [
               %{dest_flag: 1, ton: 1, npi: 1, address: "6141"},
               %{dest_flag: 2, dl_name: "staff"}
             ]

      assert {:error, %Error{status: :esme_rinvnumdests}, ""} =
               Pdu.decode(frame(0x21, head <> <<0>> <> tail))

      assert {:error, %Error{status: :esme_rinvdestflag}, ""} =
               Pdu.decode(frame(0x21, head <> <<1, 3>> <> tail))

      assert {:error, %Error{status: :esme_rinvcmdlen}, ""} =
               Pdu.decode(frame(0x21, head <> <<1, 1, 1>>))

      assert {:error, %Error{status: :esme_rinvdlname}, ""} =
               Pdu.decode(frame(0x21, head <> <<1, 2>> <> String.duplicate("x", 22)))
    end

    test "submit_multi_resp lists the destinations that failed" do
      body = c("m1") <> <<1, 1, 1>> <> c("6141") <> <<0x0B::32>>

      assert {:ok, %Pdu{fields: %{unsuccess_smes: [%{address: "6141", error_status_code: 0x0B}]}},
              ""} =
               Pdu.decode(frame(0x80000021, body))

      assert {:error, %Error{status: :esme_rinvcmdlen}, ""} =
               Pdu.decode(frame(0x80000021, c("m1") <> <<1, 1, 1>> <> c("6141")))

      assert {:error, %Error{status: :esme_rinvcmdlen}, ""} =
               Pdu.decode(frame(0x80000021, c("m1") <> <<2, 1>>))

      assert {:error, %Error{status: :esme_rinvcmdlen}, ""} =
               Pdu.decode(frame(0x80000021, c("m1")))
    end

    test "responses with an empty body decode with empty fields; a broken response is never answered" do
      assert {:ok, %Pdu{command: :submit_sm_resp, status: 0x45, fields: %{}}, ""} =
               Pdu.decode(frame(0x80000004, "", 7, 0x45))

      assert {:ok, %Pdu{command: :bind_transceiver_resp, fields: %{}}, ""} =
               Pdu.decode(frame(0x80000009, "", 1, 0x0E))

      {:error, e, ""} = Pdu.decode(frame(0x80000004, String.duplicate("x", 70)))
      assert e.status == :esme_rinvmsgid
      assert Pdu.error_reply(e) == nil
    end

    test "a request with no response of its own is answered with generic_nack" do
      {:error, e, ""} = Pdu.decode(frame(0x0B, "x"))
      assert e.command == :outbind
      assert %Pdu{command: :generic_nack, sequence: 7} = Pdu.error_reply(e)
    end
  end

  describe "encoding checks every field" do
    test "invalid values are named, never sent" do
      bad = [
        {%{source_addr: String.duplicate("1", 21)},
         {:invalid_field, :source_addr, String.duplicate("1", 21)}},
        {%{source_addr: "a" <> <<0>>}, {:invalid_field, :source_addr, "a" <> <<0>>}},
        {%{short_message: String.duplicate("x", 255)},
         {:invalid_field, :short_message, String.duplicate("x", 255)}},
        {%{esm_class: 256}, {:invalid_field, :esm_class, 256}},
        {%{validity_period: "tomorrow"}, {:invalid_field, :validity_period, "tomorrow"}},
        {%{validity_period: 5}, {:invalid_field, :validity_period, 5}},
        {%{sourceaddr: "typo"}, {:unknown_fields, [:sourceaddr]}}
      ]

      for {fields, reason} <- bad,
          do: assert(Pdu.encode(Pdu.new(:submit_sm, fields)) == {:error, reason})

      assert Pdu.encode(%Pdu{command: :submit_sm, fields: [a: 1]}) ==
               {:error, {:fields_must_be_a_map, [a: 1]}}

      assert Pdu.encode(Pdu.new(:submit_sm, %{}, sequence: -1)) ==
               {:error, {:invalid_sequence, -1}}

      assert Pdu.encode(Pdu.new(:submit_sm, %{}, sequence: 0x80000000)) ==
               {:error, {:invalid_sequence, 0x80000000}}

      # A peer that sends a sequence above the spec's range still gets its answer, with that sequence.
      assert {:ok, _} = Pdu.encode(Pdu.generic_nack(0xB9EE09D7, :esme_rinvcmdid))

      assert Pdu.encode(Pdu.generic_nack(0x1_0000_0000, :esme_rinvcmdid)) ==
               {:error, {:invalid_sequence, 0x1_0000_0000}}

      assert Pdu.encode(%Pdu{command: :submit_sm, status: :no_such}) ==
               {:error, {:invalid_status, :no_such}}

      assert Pdu.encode(%Pdu{command: :submit_sm, status: "0"}) ==
               {:error, {:invalid_status, "0"}}

      assert Pdu.encode(%Pdu{command: :nope}) == {:error, {:unknown_command, :nope}}

      assert_raise ArgumentError, ~r/invalid submit_sm/, fn ->
        Pdu.encode!(Pdu.new(:submit_sm, %{esm_class: -1}))
      end
    end

    test "short_message and message_payload are never both sent" do
      pdu = Pdu.new(:submit_sm, %{short_message: "hi"}, tlvs: [message_payload: "long text"])
      assert Pdu.encode(pdu) == {:error, :short_message_and_message_payload}
      assert {:ok, _} = Pdu.encode(%{pdu | fields: %{}})
    end

    test "TLVs are checked too" do
      assert Pdu.encode(Pdu.new(:submit_sm, %{}, tlvs: [sar_total_segments: 256])) ==
               {:error, {:invalid_tlv, :sar_total_segments, 256}}

      assert Pdu.encode(Pdu.new(:submit_sm, %{}, tlvs: [made_up: 1])) ==
               {:error, {:unknown_tlv, :made_up}}

      assert Pdu.encode(Pdu.new(:submit_sm, %{}, tlvs: [{0x020C, <<1, 2>>}])) ==
               {:error, {:use_tlv_name, 0x020C}}

      assert Pdu.encode(Pdu.new(:submit_sm, %{}, tlvs: [:oops])) ==
               {:error, {:invalid_tlv, :oops}}

      assert Pdu.encode(Pdu.new(:submit_sm, %{}, tlvs: [{0x1400, :binary.copy(<<0>>, 70_000)}])) ==
               {:error, {:tlv_too_long, 0x1400}}
    end

    test "submit_sm_resp with an error carries no body; bind responses keep theirs" do
      resp =
        Pdu.response(%Pdu{command: :submit_sm, sequence: 4}, :esme_rthrottled, %{message_id: "x"})

      assert Pdu.encode!(resp) == header(16, 0x80000004, 0x58, 4)

      bind =
        Pdu.response(%Pdu{command: :bind_transceiver, sequence: 1}, :esme_rinvpaswd, %{
          system_id: "SMSC"
        })

      assert Pdu.encode!(bind) == frame(0x80000009, c("SMSC"), 1, 0x0E)
    end

    test "only requests with a response can be answered" do
      assert_raise ArgumentError, fn -> Pdu.response(%Pdu{command: :outbind, sequence: 1}) end

      assert_raise ArgumentError, fn ->
        Pdu.response(%Pdu{command: :submit_sm_resp, sequence: 1})
      end
    end

    test "submit_multi destinations and failures are checked" do
      fields = %{dest_addresses: [%{dest_flag: 3}]}

      assert {:error, {:invalid_field, :dest_addresses, _}} =
               Pdu.encode(Pdu.new(:submit_multi, fields))

      assert {:error, {:invalid_field, :dest_addresses, []}} =
               Pdu.encode(Pdu.new(:submit_multi, %{dest_addresses: []}))

      assert {:error, {:invalid_field, :unsuccess_smes, _}} =
               Pdu.encode(Pdu.new(:submit_multi_resp, %{unsuccess_smes: [%{ton: 1}]}))

      assert {:ok, _} = Pdu.encode(Pdu.new(:submit_multi_resp, %{message_id: "m"}))
    end
  end

  test "command and status tables" do
    assert Command.response(:submit_sm) == :submit_sm_resp
    assert Command.response(:submit_sm_resp) == nil
    assert Command.response(:alert_notification) == nil
    assert Command.response?(:generic_nack)
    assert Command.name(0x12345) == :error
    assert length(Command.all()) == 27
    assert Status.code(:esme_rthrottled) == 0x58
    assert Status.code(0x401) == 0x401
    assert Status.name(0x0A) == :esme_rinvsrcadr
    assert Status.name(0x401) == 0x401
  end
end
