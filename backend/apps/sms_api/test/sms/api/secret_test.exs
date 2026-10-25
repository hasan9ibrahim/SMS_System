defmodule Sms.Api.SecretTest do
  # Authenticator secrets as the TypeScript service stores them (backend step 12): the vector was written by
  # mock/src/admin/passwords.ts encryptSecret("JBSWY3DPEHPK3PXP", 12 bytes of 7) with the development key.
  use ExUnit.Case, async: false
  alias Sms.Api.Secret

  setup do
    previous = Application.get_env(:sms_api, Secret)
    Application.put_env(:sms_api, Secret, key: "dev-only-not-a-real-key")

    on_exit(fn ->
      if previous,
        do: Application.put_env(:sms_api, Secret, previous),
        else: Application.delete_env(:sms_api, Secret)
    end)
  end

  @stored "enc:v1:BwcHBwcHBwcHBwcHnkM7Xlb17VZPnaHIB/iX7T0BVfUuZBm6ZPujfnvqb2k="

  test "decrypts what the TypeScript service encrypted" do
    assert Secret.reveal(@stored) == "JBSWY3DPEHPK3PXP"
  end

  test "a secret written before encryption is used as it is" do
    assert Secret.reveal("JBSWY3DPEHPK3PXP") == "JBSWY3DPEHPK3PXP"
  end

  test "a damaged or unknown format gives nothing, never the stored text" do
    <<head::binary-20, _::binary-4, tail::binary>> = @stored
    assert Secret.reveal(head <> "AAAA" <> tail) == nil
    assert Secret.reveal("enc:v1:not base64!") == nil
    assert Secret.reveal("enc:v9:abc") == nil
    assert Secret.reveal(nil) == nil
  end
end
