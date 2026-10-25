defmodule Sms.Api.Secret do
  @moduledoc """
  Secrets stored encrypted by the TypeScript service (backend step 12, mock/src/admin/passwords.ts `encryptSecret`):
  `enc:v1:` then base64 of a 12-byte IV, the 16-byte GCM tag and the AES-256-GCM ciphertext, keyed by SHA-256 of
  MOCK_SECRET_KEY. Authenticator secrets written before encryption are plain base32 and are returned as they are.
  """

  @doc "The plain secret, or nil when it cannot be decrypted (wrong key or damaged)."
  @spec reveal(String.t() | nil) :: String.t() | nil
  def reveal("enc:v1:" <> encoded) do
    with {:ok, <<iv::binary-12, tag::binary-16, body::binary>>} <- Base.decode64(encoded),
         plain when is_binary(plain) <-
           :crypto.crypto_one_time_aead(:aes_256_gcm, key(), iv, body, "", tag, false) do
      plain
    else
      _ -> nil
    end
  end

  def reveal("enc:" <> _), do: nil
  def reveal(plain) when is_binary(plain), do: plain
  def reveal(_), do: nil

  defp key do
    secret =
      :sms_api
      |> Application.get_env(__MODULE__, [])
      |> Keyword.get(:key, "dev-only-not-a-real-key")

    :crypto.hash(:sha256, secret)
  end
end
