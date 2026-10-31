defmodule Sms.Switch.Voice.RulesTest do
  # §8 SMS to voice (docs/SMS_TO_VOICE.md, S-6.9): which message becomes a call, the code read out, the gateway, the
  # caller ID and the number dialled. Fake data.
  use ExUnit.Case, async: true
  alias Sms.Switch.Voice.Rules

  defp rule(fields) do
    f = Map.new(fields)

    %{
      id: Map.get(f, :id, 1),
      sender: Rules.like(f[:sender]),
      receiver: Rules.like(f[:receiver]),
      prefix: f[:prefix],
      mccmnc: f[:mccmnc],
      repeat: Map.get(f, :repeat, 2),
      gateway_id: f[:gateway_id],
      prompt: f[:prompt]
    }
  end

  defp gateway(fields) do
    Map.merge(
      %{
        id: 1,
        priority: 1,
        caller_id_mode: :sender,
        fixed_caller_id: "4930000000",
        dial_prefix: ""
      },
      Map.new(fields)
    )
  end

  defp input(fields),
    do:
      Map.merge(
        %{
          sender: "FakeBank",
          receiver: "4915112345678",
          mccmnc: "26201",
          text: "Your code is 482913"
        },
        Map.new(fields)
      )

  describe "like/1 (the rule screens' wildcards)" do
    test "% is any characters, _ one, the whole value in any case; other characters are literal" do
      assert Regex.match?(Rules.like("fake%"), "FAKEBANK")
      assert Regex.match?(Rules.like("%bank"), "FakeBank")
      assert Regex.match?(Rules.like("Fake_ank"), "FakeBank")
      refute Regex.match?(Rules.like("Fake_ank"), "FakeBBank")
      refute Regex.match?(Rules.like("fake"), "FakeBank")
      # Regex characters in a pattern match themselves.
      assert Regex.match?(Rules.like("a.b+(c)"), "A.B+(C)")
      refute Regex.match?(Rules.like("a.b"), "axb")
      assert Regex.match?(Rules.like("4915%"), "4915112345678")
    end

    test "an empty pattern is no condition" do
      assert Rules.like(nil) == nil
      assert Rules.like("") == nil
    end
  end

  describe "match/2" do
    test "every field a rule sets must match; empty fields match anything; the lowest id first" do
      rules = [
        rule(id: 1, sender: "Other%"),
        rule(id: 2, receiver: "4916%"),
        rule(id: 3, prefix: "4917"),
        rule(id: 4, mccmnc: "26202"),
        rule(id: 5, sender: "fake%", prefix: "4915", mccmnc: "26201", receiver: "%678"),
        rule(id: 6)
      ]

      assert Rules.match(rules, input([])).id == 5
      assert Rules.match(rules, input(sender: "OtherBank")).id == 1
      assert Rules.match(rules, input(receiver: "4916000000")).id == 2
      assert Rules.match(rules, input(receiver: "4917000000", mccmnc: nil)).id == 3
      assert Rules.match(rules, input(mccmnc: "26202", receiver: "4930")).id == 4
      assert Rules.match(rules, input(mccmnc: "26203", receiver: "4930")).id == 6
      assert Rules.match([], input([])) == nil
    end

    test "a destination is compared with the network as routing found it; a missing sender matches only no sender condition" do
      assert Rules.match([rule(mccmnc: "26201")], input(mccmnc: nil)) == nil
      assert Rules.match([rule(sender: "%")], input(sender: nil)).id == 1
      assert Rules.match([rule(sender: "_%")], input(sender: nil)) == nil
    end
  end

  describe "code/1" do
    test "the first run of 4 to 8 digits; longer and shorter runs are not codes" do
      assert Rules.code("Your code is 482913") == "482913"
      assert Rules.code("1234") == "1234"
      assert Rules.code("12345678") == "12345678"
      assert Rules.code("Call 123456789 or use 4711") == "4711"
      assert Rules.code("Ref 12, code 0042-99") == "0042"
      assert Rules.code("PIN:9876.") == "9876"
      assert Rules.code("abc123def") == nil
      assert Rules.code("no digits") == nil
      assert Rules.code("") == nil
      assert Rules.code(nil) == nil
    end
  end

  describe "gateway/2" do
    test "the rule's own when active, else the active one with the lowest priority, then the lowest id" do
      gateways = %{
        1 => gateway(id: 1, priority: 5),
        2 => gateway(id: 2, priority: 1),
        3 => gateway(id: 3, priority: 1)
      }

      assert Rules.gateway(rule(gateway_id: 1), gateways).id == 1
      assert Rules.gateway(rule(gateway_id: nil), gateways).id == 2
      # Its gateway is not active (not loaded): the default one.
      assert Rules.gateway(rule(gateway_id: 9), gateways).id == 2
      assert Rules.gateway(rule([]), %{}) == nil
    end
  end

  describe "caller_id/2 and dial/2" do
    test "the sender when it is a number, else the gateway's fixed caller ID; fixed mode always the fixed one" do
      g = gateway([])
      assert Rules.caller_id(g, "4930123456") == "4930123456"
      assert Rules.caller_id(g, "+4930123456") == "+4930123456"
      assert Rules.caller_id(g, "FakeBank") == "4930000000"
      assert Rules.caller_id(g, "49 30") == "4930000000"
      assert Rules.caller_id(g, nil) == "4930000000"
      assert Rules.caller_id(gateway(fixed_caller_id: ""), "FakeBank") == nil
      assert Rules.caller_id(gateway(caller_id_mode: :fixed), "4930123456") == "4930000000"

      assert Rules.caller_id(gateway(caller_id_mode: :fixed, fixed_caller_id: nil), "4930123456") ==
               nil
    end

    test "the dial prefix and the receiver's digits; nothing else can reach the channel name" do
      assert Rules.dial(gateway(dial_prefix: "99#"), "4915112345678") == "99#4915112345678"
      assert Rules.dial(gateway(dial_prefix: "0@x/1,"), "+49 151") == "0149151"
      assert Rules.dial(gateway(dial_prefix: nil), "4915112345678") == "4915112345678"
    end
  end

  describe "plan/3" do
    test "a matching rule with a code and a gateway is a call: code, repeat, dialled number, caller ID, recording" do
      sha = String.duplicate("ab", 32)
      rules = [rule(id: 7, repeat: 3, prompt: sha)]
      gateways = %{4 => gateway(id: 4, dial_prefix: "00")}

      assert Rules.plan(rules, gateways, input(sender: "+4930123")) ==
               {:call,
                %{
                  rule_id: 7,
                  gateway_id: 4,
                  code: "482913",
                  repeat: 3,
                  dial: "004915112345678",
                  caller_id: "+4930123",
                  prompt: sha
                }}
    end

    test "why a message goes as an SMS: no rule, no code, no active gateway" do
      gateways = %{1 => gateway([])}
      assert Rules.plan([rule(sender: "Other")], gateways, input([])) == {:sms, :no_rule}
      assert Rules.plan([rule([])], gateways, input(text: "Hello")) == {:sms, :no_code}
      assert Rules.plan([rule([])], gateways, input(text: nil)) == {:sms, :no_code}
      assert Rules.plan([rule(id: 3)], %{}, input([])) == {:sms, {:no_gateway, 3}}
    end
  end
end
