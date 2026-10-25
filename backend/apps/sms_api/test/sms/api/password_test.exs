defmodule Sms.Api.PasswordTest do
  # scrypt hashes in the mock's format (backend step 9, §13.28).
  use ExUnit.Case, async: true
  alias Sms.Api.Password

  test "RFC 7914 test vectors" do
    assert Base.encode16(Password.scrypt("", "", 16, 1, 1, 64), case: :lower) ==
             "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442" <>
               "fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906"

    assert Base.encode16(Password.scrypt("password", "NaCl", 1024, 8, 16, 64), case: :lower) ==
             "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162" <>
               "2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640"
  end

  test "a hash written by the mock verifies (same password, NFKC, salt and cost)" do
    # Written by Node's scryptSync as mock/src/admin/passwords.ts does: hashPassword("demo-password-2026", salt =
    # 16 bytes of 0x01), N = 4096.
    stored = "scrypt$4096$AQEBAQEBAQEBAQEBAQEBAQ==$48NrAFdIkH0r8l8XSKuaC2rkq7LsRI5xQ7CU1CM9TnA="
    assert Password.verify?("demo-password-2026", stored)
    refute Password.verify?("demo-password-2027", stored)
  end

  test "new hashes verify; other formats and costs are refused" do
    stored = Password.hash("ｆｕｌｌ-width-pass", 1024)
    assert stored =~ ~r/^scrypt\$1024\$/
    # NFKC: full-width letters are the same password as their plain form.
    assert Password.verify?("full-width-pass", stored)
    refute Password.verify?("other", stored)
    refute Password.verify?("x", nil)
    refute Password.verify?("x", "bcrypt$10$abc")
    refute Password.verify?("x", "scrypt$1000$AAAA$AAAA")
    refute Password.verify?("x", "scrypt$4096$not base64!$AAAA")
  end
end
