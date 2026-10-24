defmodule Sms.Switch.Rules.TranslationTest do
  # The translation engine (§6.4, §13.2): the mock's engine tests (mock/test/translationRules.test.ts) ported one for
  # one, so both engines give the same answers.
  use ExUnit.Case, async: true
  alias Sms.Switch.Rules.{Pattern, Translation}
  alias Sms.Switch.Rules.Translation.{Context, Rule}

  defp rule(id, fields \\ []), do: Rule.new([id: id, name: "R#{id}"] ++ fields)

  defp ctx(lists \\ %{1 => ["4479001"], 2 => ["BRAND{n}{n}"]}) do
    %Context{
      list_has?: fn id, value, match_case ->
        Enum.any?(Map.get(lists, id, []), &Translation.entry_matches?(&1, value, match_case))
      end,
      list_entries: &Map.get(lists, &1, []),
      mccmnc_of: fn r -> if String.starts_with?(r, "44"), do: "23415" end,
      now: ~U[2026-10-17 12:00:00Z],
      rand: fn -> 0.5 end
    }
  end

  @msg %{sender: "4479001", receiver: "0044712345678", text: "Your code is 1234"}

  test "conversions: strip, prepend, append, translation, regex replace" do
    assert Translation.convert(:left_strip, "2", "0044") == "44"
    assert Translation.convert(:right_strip, "1", "12345") == "1234"
    assert Translation.convert(:prepend, "+", "44") == "+44"
    assert Translation.convert(:append, "X", "AB") == "ABX"
    assert Translation.convert(:translation, "00=+", "0044") == "+44"
    assert Translation.convert(:translation, "00=+", "44") == "44"
    # The new value replaces what the conditions matched.
    assert Translation.convert(:translation, "BRAND", "INFO") == "BRAND"

    assert Translation.fill_content_template(
             "[OurBrand] code {code}",
             "Your PIN: 482913, valid 5 min"
           ) ==
             "[OurBrand] code 482913"

    assert Translation.fill_content_template("{text}", "hi") == "hi"
    assert Translation.convert(:regex_replace, "^0(\\d+)", "07123456", "44$1") == "447123456"

    assert Translation.convert(:regex_replace, "^(\\d{3})\\d{4}", "4471234567", "$1XXXX") ==
             "447XXXX567"

    # An empty replacement removes.
    assert Translation.convert(:regex_replace, "[^0-9]", "+44 7123", "") == "447123"
  end

  test "content rewrite: regex group, whole match, template" do
    r =
      rule(1,
        content_regex: "code is ([0-9]+)",
        content_regex_index: 1,
        content_replacement: "****"
      )

    assert Translation.rewrite_text(r, @msg.text) == "Your code is ****"

    assert Translation.rewrite_text(
             rule(1, content_regex: "code is ([0-9]+)", content_replacement: "****"),
             @msg.text
           ) ==
             "Your ****"

    # Message Text reuses the pattern's groups (team trial round 2): extract the code into a new text.
    pin = [content_regex: "^.*?([0-9]{4,8}).*$", content_replacement: "PIN $1 for you"]

    assert Translation.rewrite_text(rule(2, pin), "Your code is 482913. FREE gift at bit.ly/x") ==
             "PIN 482913 for you"

    tpl =
      rule(2,
        content_regex: "^.*?([0-9]{4,8}).*$",
        content_replacement: "$1",
        msg_template: "PIN {text} for you"
      )

    assert Translation.rewrite_text(tpl, "Your code is 482913. FREE gift at bit.ly/x") ==
             "PIN 482913 for you"

    assert Translation.rewrite_text(rule(2, msg_template: "[ACME] {text}"), "hi") == "[ACME] hi"
  end

  test "rules run in order, Not Match, lists, network, Stop and block" do
    res =
      Translation.run(
        [
          rule(1,
            receiver_pattern: "^00",
            receiver_conversion: :left_strip,
            receiver_conversion_value: "2"
          ),
          rule(2, mccmncs: ["234", "23415"], sender_list_id: 1, dest_ton: 1, dest_npi: 1),
          rule(3, sender_pattern: "^44", sender_pattern_negate: true, action: :block),
          {rule(4, sender_conversion: :sender_id_template, sender_conversion_list_id: 2), false},
          rule(5, action: :block)
        ],
        Map.put(@msg, :dlr_status, "UNKNOWN"),
        ctx()
      )

    assert res.after.receiver == "44712345678"
    # The network follows the converted receiver.
    assert res.after.mccmnc == "23415"
    assert res.after.dest_ton == 1
    # Not Match on a matching sender.
    assert Enum.at(res.steps, 2).matched == false
    assert res.after.sender == "BRAND55"
    # Rule 4 matched with Stop, so rule 5 never ran.
    assert length(res.steps) == 4
    assert res.blocked == false
  end

  test "block, length guards, time window and DLR conversion" do
    assert Translation.run([rule(1, action: :block, content_pattern: "code")], @msg, ctx()).blocked
    # The guard fails, so the rule does not match.
    refute Translation.run([rule(1, action: :block, sender_min_length: 10)], @msg, ctx()).blocked

    refute Translation.run(
             [rule(1, action: :block, starts_at: ~U[2027-01-01 00:00:00Z])],
             @msg,
             ctx()
           ).blocked

    refute Translation.run(
             [rule(1, action: :block, stops_at: ~U[2026-10-17 12:00:00Z])],
             @msg,
             ctx()
           ).blocked

    assert Translation.run(
             [rule(1, action: :block, stops_at: ~U[2026-10-17 12:00:01Z])],
             @msg,
             ctx()
           ).blocked

    dlr =
      Translation.run(
        [
          rule(1,
            dlr_map: [
              %{from_status: "unknown", from_error: nil, to_status: "UNDELIV", to_error: "001"}
            ]
          )
        ],
        Map.merge(@msg, %{dlr_status: "UNKNOWN", dlr_error: "000"}),
        ctx()
      )

    assert {dlr.after.dlr_status, dlr.after.dlr_error} == {"UNDELIV", "001"}
  end

  test "match lists of any type; a template entry's {n} matches one digit" do
    assert Translation.entry_matches?("4479001", "4479001")
    assert Translation.entry_matches?("SHOP{n}{n}", "SHOP42")
    refute Translation.entry_matches?("SHOP{n}{n}", "SHOP4")
    # Other characters are literal.
    refute Translation.entry_matches?("A.B{n}", "AXB1")

    assert Translation.run(
             [rule(1, sender_list_id: 2, action: :block)],
             %{@msg | sender: "BRAND07"},
             ctx()
           ).blocked
  end

  test "Match case for the Sender ID conditions: exact capitals when on, any case when off (team trial round 1)" do
    lists = ctx(%{3 => ["BANK", "SHOP{n}"]})

    blocked = fn fields, sender ->
      Translation.run([rule(1, [action: :block] ++ fields)], %{@msg | sender: sender}, lists).blocked
    end

    assert blocked.([sender_pattern: "^BANK$"], "BANK")
    # On by default.
    refute blocked.([sender_pattern: "^BANK$"], "Bank")
    refute blocked.([sender_pattern: "^BANK$", sender_match_case: true], "Bank")
    assert blocked.([sender_pattern: "^BANK$", sender_match_case: false], "Bank")

    refute blocked.(
             [sender_pattern: "^BANK$", sender_pattern_negate: true, sender_match_case: false],
             "bank"
           )

    refute blocked.([sender_list_id: 3], "bank")
    assert blocked.([sender_list_id: 3, sender_match_case: false], "bank")
    refute blocked.([sender_list_id: 3], "shop1")
    assert blocked.([sender_list_id: 3, sender_match_case: false], "shop1")

    assert Translation.entry_matches?("BANK", "Bank", false) and
             not Translation.entry_matches?("BANK", "Bank")

    # Receiver and content patterns keep exact case.
    refute Translation.run(
             [rule(1, action: :block, sender_match_case: false, content_pattern: "CODE")],
             %{@msg | sender: "x"},
             lists
           ).blocked

    [step] =
      Translation.run(
        [rule(1, sender_pattern: "^BANK$", sender_match_case: false)],
        %{@msg | sender: "bank"},
        lists
      ).steps

    assert hd(step.checks).detail =~ "any case"
  end

  test "content words: replace or remove words as typed (team trial round 1)" do
    words = fn list -> rule(1, content_words: list).compiled.words end
    rw = fn text, list -> Translation.replace_words(text, words.(list)) end

    assert rw.("Your code is 1234. Call now!", [%{find: "now", replace: ""}]) ==
             "Your code is 1234. Call!"

    assert rw.("Bitcoin bit BIT", [%{find: "bit", replace: "piece"}]) == "Bitcoin piece BIT"

    assert rw.("Bitcoin bit BIT", [%{find: "bit", replace: "piece", match_case: false}]) ==
             "Bitcoin piece piece"

    assert rw.("Bitcoin bit", [%{find: "bit", replace: "x", whole_word: false, match_case: false}]) ==
             "xcoin x"

    assert rw.("Bit bit", [%{find: "bit", replace: "x", match_case: true}]) == "Bit x"

    assert rw.("Visit www.a.com (a.com)", [%{find: "a.com", replace: "b.org"}]) ==
             "Visit www.b.org (b.org)"

    assert rw.("رمزك 1234 الآن", [%{find: "الآن", replace: ""}]) == "رمزك 1234"
  end

  describe "beyond the mock's tests" do
    test "MCCMNC list or pattern, Not Match, unknown network" do
      run = fn fields, receiver ->
        Translation.run(
          [rule(1, [action: :block] ++ fields)],
          %{@msg | receiver: receiver},
          ctx()
        )
      end

      assert run.([mccmncs: ["23415"]], "4471").blocked
      refute run.([mccmncs: ["23415"]], "3371").blocked
      assert run.([mccmnc_pattern: "^234"], "4471").blocked
      refute run.([mccmncs: ["23415"], mccmnc_negate: true], "4471").blocked
      assert run.([mccmncs: ["23415"], mccmnc_negate: true], "3371").blocked

      assert hd(hd(run.([mccmnc_pattern: "(bad"], "4471").steps).checks).detail =~
               "invalid pattern"
    end

    test "an invalid pattern never matches and never raises" do
      res = Translation.run([rule(1, action: :block, sender_pattern: "(unclosed")], @msg, ctx())
      refute res.blocked
      assert hd(hd(res.steps).checks).detail == "invalid pattern (unclosed"
      assert Translation.convert(:regex_replace, "(bad", "keep", "x") == "keep"
    end

    test "random number and sender templates, changes and fired" do
      lists = ctx(%{7 => ["111", "222", "333"], 8 => ["SHOP{n}"]})

      [step] =
        Translation.run(
          [rule(1, sender_conversion: :random_number, sender_conversion_list_id: 7)],
          @msg,
          lists
        ).steps

      assert step.fired and step.changes == [%{field: :sender, before: "4479001", after: "222"}]

      templated = %{lists | templates: fn 8, "SHOP{n}" -> ["Code {code} from SHOP"] end}

      res =
        Translation.run(
          [rule(1, sender_conversion: :sender_id_template, sender_conversion_list_id: 8)],
          @msg,
          templated
        )

      assert res.after.sender == "SHOP5"
      assert res.after.text == "Code 1234 from SHOP"
      # An empty list changes nothing.
      [step] =
        Translation.run(
          [rule(1, sender_conversion: :random_number, sender_conversion_list_id: 99)],
          @msg,
          lists
        ).steps

      assert step.matched and not step.fired
    end

    test "TON / NPI, billing type and registered delivery; a rule changing nothing has not fired" do
      res =
        Translation.run(
          [
            rule(1,
              sender_ton: 5,
              sender_npi: 0,
              billing_type: "delivery",
              registered_delivery: 1
            )
          ],
          Map.merge(@msg, %{sender_ton: 1, sender_npi: 1}),
          ctx()
        )

      assert Map.take(res.after, [:sender_ton, :sender_npi, :billing_type, :registered_delivery]) ==
               %{sender_ton: 5, sender_npi: 0, billing_type: "delivery", registered_delivery: 1}

      [step] =
        Translation.run([rule(1, sender_ton: 1)], Map.put(@msg, :sender_ton, 1), ctx()).steps

      assert step.matched and not step.fired
    end

    test "the trunk's Continue setting overrides the rule's" do
      rules = [{rule(1, continue_after: true), false}, rule(2, action: :block)]
      refute Translation.run(rules, @msg, ctx()).blocked
      rules = [{rule(1, continue_after: false), true}, rule(2, action: :block)]
      assert Translation.run(rules, @msg, ctx()).blocked
      # nil keeps the rule's own.
      assert Translation.run([{rule(1), nil}, rule(2, action: :block)], @msg, ctx()).blocked
    end

    test "regex group index on a group that did not take part leaves the match" do
      r = rule(1, content_regex: "code (x)?is", content_regex_index: 1, content_replacement: "Z")
      assert Translation.rewrite_text(r, "my code is 1") == "my code is 1"
    end
  end

  describe "Pattern (JavaScript-compatible regular expressions)" do
    test "sender keywords" do
      assert Pattern.match?(Pattern.compile("\\Numeric"), "+44712")
      refute Pattern.match?(Pattern.compile("\\numeric"), "44A")
      assert Pattern.match?(Pattern.compile(" \\ALPHA "), "4A")
      refute Pattern.match?(Pattern.compile("\\Alpha"), "447")
    end

    test "JavaScript replacement strings" do
      re = Pattern.compile("(\\d)(\\d)")
      assert Pattern.replace_js(re, "a12b34", "[$2$1]") == "a[21]b[43]"
      assert Pattern.replace_js(re, "12", "$$-$&-$`-$'-$3-$0") == "$-12---$3-$0"
      assert Pattern.replace_js(Pattern.compile("(a)|(b)"), "b", "<$1|$2>") == "<|b>"
      # Two-digit group numbers when the group exists, else one digit and the rest as typed.
      assert Pattern.replace_js(re, "12", "$10") == "10"
    end

    test "empty matches move on one character, Unicode text" do
      assert Pattern.replace_js(Pattern.compile("x*"), "abc", "-") == "-a-b-c-"
      assert Pattern.replace_js(Pattern.compile("é"), "café é", "e") == "cafe e"
      assert Pattern.replace_js(Pattern.compile(""), "😀a", "|") == "|😀|a|"
    end

    test "case-insensitive on request; invalid patterns" do
      assert Pattern.match?(Pattern.compile("^bank$", match_case: false), "BANK")
      refute Pattern.match?(Pattern.compile("^bank$"), "BANK")
      assert Pattern.compile("[") == :invalid
      refute Pattern.match?(:invalid, "anything")
      assert Pattern.replace_js(:invalid, "same", "x") == "same"
    end

    test "lengths in UTF-16 units" do
      assert Pattern.js_length("abc") == 3
      assert Pattern.js_length("😀") == 2
      assert Pattern.js_length("é") == 1
    end
  end
end
