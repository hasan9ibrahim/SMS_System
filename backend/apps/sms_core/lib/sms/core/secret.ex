defmodule Sms.Core.Secret do
  @moduledoc """
  Secrets stored encrypted by the TypeScript service (backend step 12, mock/src/admin/passwords.ts `encryptSecret`):
  `enc:v1:` then base64 of a 12-byte IV, the 16-byte GCM tag and the AES-256-GCM ciphertext, keyed by SHA-256 of
  MOCK_SECRET_KEY. Used for authenticator secrets (the API, §13.28), mailbox passwords and voice gateway passwords
  (the switch, §8 SMS to voice). A value written before encryption is plain text and is returned as it is.

  The key: `config :sms_core, Sms.Core.Secret, key: ...` (MOCK_SECRET_KEY, config/runtime.exs).
  """

  @dev_key "dev-only-not-a-real-key"

  @doc "The plain secret, or nil when it cannot be decrypted (wrong key or damaged), with the configured key."
  @spec reveal(String.t() | nil) :: String.t() | nil
  def reveal(stored), do: reveal(stored, configured_key())

  @doc "The plain secret, or nil when it cannot be decrypted with `key` (MOCK_SECRET_KEY's value)."
  @spec reveal(String.t() | nil, String.t()) :: String.t() | nil
  def reveal("enc:v1:" <> encoded, key) do
    with {:ok, <<iv::binary-12, tag::binary-16, body::binary>>} <- Base.decode64(encoded),
         plain when is_binary(plain) <-
           :crypto.crypto_one_time_aead(
             :aes_256_gcm,
             :crypto.hash(:sha256, key),
             iv,
             body,
             "",
             tag,
             false
           ) do
      plain
    else
      _ -> nil
    end
  end

  def reveal("enc:" <> _, _key), do: nil
  def reveal(plain, _key) when is_binary(plain), do: plain
  def reveal(_, _key), do: nil

  defp configured_key,
    do: :sms_core |> Application.get_env(__MODULE__, []) |> Keyword.get(:key, @dev_key)
end
