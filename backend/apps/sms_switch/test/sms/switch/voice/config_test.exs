defmodule Sms.Switch.Voice.ConfigTest do
  # §8 SMS to voice: the rules and gateways in the routing snapshot (migrations 105, 106): active rules in order of id
  # with their patterns compiled and only their recording's hash, active gateways with their password decrypted as the
  # mailbox passwords are. Fake data.
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog
  import Sms.Switch.Test.CustomerCase, only: [assert_eventually: 1]
  alias Sms.Switch.Pipeline.Config
  alias Sms.Switch.Test.PipelineConfig

  # mock/src/admin/passwords.ts encryptSecret("JBSWY3DPEHPK3PXP", 12 bytes of 7) with the development key.
  @password_enc "enc:v1:BwcHBwcHBwcHBwcHnkM7Xlb17VZPnaHIB/iX7T0BVfUuZBm6ZPujfnvqb2k="

  defp load(opts) do
    PipelineConfig.put(opts)
    start_supervised!({Config.Server, loader: PipelineConfig})
    assert_eventually(&Config.ready?/0)
    Config.voice()
  end

  test "rules in order of id, patterns compiled, empty fields no condition, the recording by a valid hash only" do
    sha = String.duplicate("0a", 32)

    voice =
      load(
        voice_rules: [
          PipelineConfig.voice_rule(
            id: 9,
            sender_id: "",
            receiver_id: nil,
            prefix: "",
            mccmnc: ""
          ),
          PipelineConfig.voice_rule(
            id: 2,
            sender_id: "Fake%",
            receiver_id: "4915_%",
            prefix: "4915",
            mccmnc: "26201",
            repeat_count: 3,
            gateway_id: 5,
            prompt_wav_sha256: String.upcase(sha)
          ),
          PipelineConfig.voice_rule(id: 4, prompt_wav_sha256: "not a sha256", repeat_count: 9)
        ]
      )

    assert [two, four, nine] = voice.rules
    assert {two.id, four.id, nine.id} == {2, 4, 9}
    assert Regex.match?(two.sender, "FAKEBANK")
    assert Regex.match?(two.receiver, "4915112345678")
    assert %{prefix: "4915", mccmnc: "26201", repeat: 3, gateway_id: 5, prompt: ^sha} = two
    assert %{prompt: nil, repeat: 5} = four
    assert %{sender: nil, receiver: nil, prefix: nil, mccmnc: nil, gateway_id: nil} = nine
  end

  test "gateways with their settings and decrypted password; one whose password does not decrypt is left out" do
    log =
      capture_log(fn ->
        voice =
          load(
            voice_gateways: [
              PipelineConfig.voice_gateway(
                id: 1,
                username: "fake-user",
                password_enc: @password_enc,
                transport: "tls",
                caller_id_mode: "fixed",
                from_domain: "",
                dial_prefix: nil,
                codecs: nil
              ),
              PipelineConfig.voice_gateway(
                id: 2,
                username: "fake-user",
                password_enc: "enc:v1:AAAA"
              ),
              PipelineConfig.voice_gateway(id: 3, transport: "sctp"),
              PipelineConfig.voice_gateway(id: 4, username: "", password_enc: nil)
            ]
          )

        assert Map.keys(voice.gateways) |> Enum.sort() == [1, 4]

        assert %{
                 host: "voice-gw1.example.net",
                 port: 5060,
                 transport: :tls,
                 username: "fake-user",
                 password: "JBSWY3DPEHPK3PXP",
                 from_domain: nil,
                 caller_id_mode: :fixed,
                 fixed_caller_id: "4930000000",
                 dial_prefix: "",
                 codecs: [],
                 max_calls: 10,
                 ring_timeout_s: 30,
                 retry_delay_s: 60,
                 priority: 1
               } = voice.gateways[1]

        assert %{username: nil, password: nil, transport: :udp, caller_id_mode: :sender} =
                 voice.gateways[4]

        assert Config.voice_gateway(4) == voice.gateways[4]
        assert Config.voice_gateway(2) == nil
      end)

    assert log =~ "voice gateway 2 not loaded: its password cannot be decrypted"
    assert log =~ "voice gateway 3 not loaded"
  end

  test "no voice configuration: no rules, no gateways" do
    assert load([]) == %{rules: [], gateways: %{}}
    Config.put_snapshot(%{platform_currency: "EUR"})
    assert Config.voice() == %{rules: [], gateways: %{}}
  end
end
