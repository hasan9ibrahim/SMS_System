defmodule Sms.Api.TotpTest do
  # Authenticator codes (RFC 6238, §13.28).
  use ExUnit.Case, async: true
  alias Sms.Api.Totp

  # RFC 6238 appendix B: the SHA-1 seed "12345678901234567890" (base32 below); the 6 low digits of each code.
  @secret "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

  test "RFC 6238 vectors" do
    assert Totp.code_at(@secret, 59) == "287082"
    assert Totp.code_at(@secret, 1_111_111_109) == "081804"
    assert Totp.code_at(@secret, 1_234_567_890) == "005924"
    assert Totp.code_at(@secret, 2_000_000_000) == "279037"
  end

  test "the current step and one either side are accepted, others not" do
    now = 1_234_567_890
    assert Totp.valid?(@secret, Totp.code_at(@secret, now), now)
    assert Totp.valid?(@secret, Totp.code_at(@secret, now - 30), now)
    assert Totp.valid?(@secret, Totp.code_at(@secret, now + 30), now)
    refute Totp.valid?(@secret, Totp.code_at(@secret, now - 90), now)
    # Lower case and spaces in the secret are read the same.
    assert Totp.valid?("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", Totp.code_at(@secret, now), now)
  end

  test "bad secrets and codes" do
    refute Totp.valid?(nil, "123456")
    refute Totp.valid?("not-base32-!!", "123456")
    refute Totp.valid?("", "123456")
    refute Totp.valid?(@secret, "12345")
    refute Totp.valid?(@secret, "1234567")
    refute Totp.valid?(@secret, nil)
    assert Totp.step(@secret, nil) == :error
  end

  test "the step a code belongs to, which the sign-in remembers so the code works once (§13.28)" do
    now = 1_700_000_015
    step = div(now, 30)
    assert Totp.step(@secret, Totp.code_at(@secret, now), now) == {:ok, step}
    assert Totp.step(@secret, Totp.code_at(@secret, now - 30), now) == {:ok, step - 1}
    assert Totp.step(@secret, Totp.code_at(@secret, now + 30), now) == {:ok, step + 1}
    assert Totp.step(@secret, Totp.code_at(@secret, now + 60), now) == :error
  end
end
