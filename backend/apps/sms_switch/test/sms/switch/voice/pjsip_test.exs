defmodule Sms.Switch.Voice.PjsipTest do
  # §8 SMS to voice: the voice gateways as PJSIP configuration, one endpoint / aor / auth per active gateway named
  # smsvoice-gw<id>. Fake hosts and secrets.
  use ExUnit.Case, async: true
  import ExUnit.CaptureLog
  alias Sms.Switch.Voice.Pjsip

  defp gateway(fields) do
    Map.merge(
      %{
        id: 1,
        host: "voice-gw1.example.net",
        port: 5060,
        transport: :udp,
        username: nil,
        password: nil,
        from_domain: nil,
        codecs: ["alaw", "ulaw"]
      },
      Map.new(fields)
    )
  end

  test "a gateway without a username: endpoint and aor only, its codecs, contact with its transport" do
    conf = Pjsip.render([gateway([])])

    assert conf =~ "; SMS to voice (§8)"

    assert conf =~ """
           [smsvoice-gw1]
           type=endpoint
           transport=transport-udp
           disallow=all
           allow=alaw,ulaw
           aors=smsvoice-gw1
           direct_media=no

           [smsvoice-gw1]
           type=aor
           contact=sip:voice-gw1.example.net:5060\\;transport=udp
           """

    refute conf =~ "outbound_auth"
    refute conf =~ "type=auth"
    refute conf =~ "from_domain"
    # No dialplan for calls coming in from a gateway.
    refute conf =~ "context"
  end

  test "with a username: outbound auth with the password, the From domain; gateways in id order" do
    conf =
      Pjsip.render([
        gateway(
          id: 7,
          host: "voice-gw2.example.net",
          port: 5061,
          transport: :tls,
          codecs: ["ulaw"]
        ),
        gateway(
          username: "fake-user",
          password: "fake;secret",
          from_domain: "example.net",
          transport: :tcp
        )
      ])

    assert conf =~ """
           [smsvoice-gw1]
           type=endpoint
           transport=transport-tcp
           disallow=all
           allow=alaw,ulaw
           aors=smsvoice-gw1
           outbound_auth=smsvoice-gw1
           from_domain=example.net
           direct_media=no

           [smsvoice-gw1]
           type=aor
           contact=sip:voice-gw1.example.net:5060\\;transport=tcp

           [smsvoice-gw1]
           type=auth
           auth_type=userpass
           username=fake-user
           password=fake\\;secret
           """

    assert conf =~
             "type=endpoint\ntransport=transport-tls\ndisallow=all\nallow=ulaw\naors=smsvoice-gw7"

    assert conf =~ "contact=sip:voice-gw2.example.net:5061\\;transport=tls"
    {first, _} = :binary.match(conf, "[smsvoice-gw1]")
    {second, _} = :binary.match(conf, "[smsvoice-gw7]")
    assert first < second
  end

  test "an IPv6 address is bracketed; no valid codec falls back to alaw,ulaw; no value spans lines" do
    conf =
      Pjsip.render([
        gateway(
          host: "2001:db8::10",
          codecs: ["Bad Codec", nil],
          username: "u\nx",
          password: "p\r\n[evil]"
        )
      ])

    assert conf =~ "contact=sip:[2001:db8::10]:5060\\;transport=udp"
    assert conf =~ "allow=alaw,ulaw\n"
    assert conf =~ "username=ux\n"
    assert conf =~ "password=p[evil]\n"
    refute conf =~ "\n[evil]"
  end

  test "a gateway whose host is not a host name or address is left out and logged" do
    log =
      capture_log(fn ->
        conf =
          Pjsip.render([
            gateway(id: 2, host: "bad host;\n[x]"),
            gateway(id: 3, host: nil),
            gateway(id: 4)
          ])

        refute conf =~ "smsvoice-gw2"
        refute conf =~ "smsvoice-gw3"
        assert conf =~ "smsvoice-gw4"
      end)

    assert log =~ "voice gateway 2 left out"
  end

  test "no gateway: only the header" do
    assert Pjsip.render([]) =~ ~r/\A; SMS to voice/
    refute Pjsip.render([]) =~ "["
    assert Pjsip.name(12) == "smsvoice-gw12"
  end
end
