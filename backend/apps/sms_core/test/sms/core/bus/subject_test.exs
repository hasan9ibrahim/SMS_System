defmodule Sms.Core.Bus.SubjectTest do
  use ExUnit.Case, async: true
  use ExUnitProperties
  alias Sms.Core.Bus.Subject

  test "publish subjects: sms. plus tokens, no wildcards, no empty tokens" do
    assert Subject.valid_publish?("sms.msg.accepted")
    assert Subject.valid_publish?("sms.x")
    refute Subject.valid_publish?("sms")
    refute Subject.valid_publish?("sms.")
    refute Subject.valid_publish?("other.msg")
    refute Subject.valid_publish?("sms..x")
    refute Subject.valid_publish?("sms.*")
    refute Subject.valid_publish?("sms.msg.>")
    refute Subject.valid_publish?("sms.a b")
    refute Subject.valid_publish?(nil)
  end

  test "filters: > only as the last token" do
    assert Subject.valid_filter?("sms.>")
    assert Subject.valid_filter?("sms.*.accepted")
    refute Subject.valid_filter?("sms.>.x")
    refute Subject.valid_filter?("sms.")
    refute Subject.valid_filter?(42)
  end

  test "matching: * is one token, > is one or more" do
    assert Subject.matches?("sms.>", "sms.msg.accepted")
    refute Subject.matches?("sms.>", "sms")
    assert Subject.matches?("sms.*.accepted", "sms.msg.accepted")
    refute Subject.matches?("sms.*", "sms.msg.accepted")
    refute Subject.matches?("sms.msg.accepted", "sms.msg.rejected")
  end

  defp token, do: StreamData.string(:alphanumeric, min_length: 1, max_length: 8)

  property "every publish subject matches itself, sms.> and a * in any position" do
    check all(
            tokens <- StreamData.list_of(token(), min_length: 1, max_length: 5),
            i <- StreamData.integer(0..10)
          ) do
      subject = Enum.join(["sms" | tokens], ".")
      assert Subject.valid_publish?(subject)
      assert Subject.matches?(subject, subject)
      assert Subject.matches?("sms.>", subject)
      parts = String.split(subject, ".")
      pos = rem(i, length(parts))
      assert Subject.matches?(parts |> List.replace_at(pos, "*") |> Enum.join("."), subject)
    end
  end

  property "a filter of only * never matches a subject with a different number of tokens" do
    check all(
            a <- StreamData.list_of(token(), min_length: 1, max_length: 4),
            extra <- StreamData.list_of(token(), min_length: 1, max_length: 3),
            longer? <- StreamData.boolean()
          ) do
      {filter_tokens, subject_tokens} = if longer?, do: {a, a ++ extra}, else: {a ++ extra, a}
      filter = Enum.join(["sms" | Enum.map(filter_tokens, fn _ -> "*" end)], ".")
      refute Subject.matches?(filter, Enum.join(["sms" | subject_tokens], "."))
    end
  end
end
