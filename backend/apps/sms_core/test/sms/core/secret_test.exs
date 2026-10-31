defmodule Sms.Core.SecretTest do
  # Secrets as the TypeScript service stores them (backend step 12; §8 voice gateway passwords): the vector was written
  # by mock/src/admin/passwords.ts encryptSecret("JBSWY3DPEHPK3PXP", 12 bytes of 7) with the development key.
  use ExUnit.Case, async: false
  alias Sms.Core.Secret

  @stored "enc:v1:BwcHBwcHBwcHBwcHnkM7Xlb17VZPnaHIB/iX7T0BVfUuZBm6ZPujfnvqb2k="

  setup do
    previous = Application.get_env(:sms_core, Secret)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:sms_core, Secret, previous),
        else: Application.delete_env(:sms_core, Secret)
    end)
  end

  test "decrypts what the TypeScript service encrypted, with the configured key or the development default" do
    Application.delete_env(:sms_core, Secret)
    assert Secret.reveal(@stored) == "JBSWY3DPEHPK3PXP"

    Application.put_env(:sms_core, Secret, key: "dev-only-not-a-real-key")
    assert Secret.reveal(@stored) == "JBSWY3DPEHPK3PXP"
  end

  test "another key gives nothing, never the stored text" do
    Application.put_env(:sms_core, Secret, key: "fake-other-key")
    assert Secret.reveal(@stored) == nil
    assert Secret.reveal(@stored, "dev-only-not-a-real-key") == "JBSWY3DPEHPK3PXP"
  end

  test "plain text is returned as it is; a damaged or unknown format gives nothing" do
    assert Secret.reveal("fake-plain-secret") == "fake-plain-secret"
    <<head::binary-20, _::binary-4, tail::binary>> = @stored
    assert Secret.reveal(head <> "AAAA" <> tail) == nil
    assert Secret.reveal("enc:v1:not base64!") == nil
    assert Secret.reveal("enc:v9:abc") == nil
    assert Secret.reveal(nil) == nil
  end
end
