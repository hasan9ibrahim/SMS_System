defmodule Sms.Api.Secret do
  @moduledoc """
  Secrets stored encrypted by the TypeScript service (backend step 12, mock/src/admin/passwords.ts `encryptSecret`):
  `enc:v1:` then base64 of a 12-byte IV, the 16-byte GCM tag and the AES-256-GCM ciphertext, keyed by SHA-256 of
  MOCK_SECRET_KEY. Authenticator secrets written before encryption are plain base32 and are returned as they are.
  The decryption is `Sms.Core.Secret`'s (the switch uses it for voice gateway passwords); the key is the API's own
  setting (`config :sms_api, Sms.Api.Secret, key: ...`).
  """

  alias Sms.Core.Secret, as: CoreSecret

  @doc "The plain secret, or nil when it cannot be decrypted (wrong key or damaged)."
  @spec reveal(String.t() | nil) :: String.t() | nil
  def reveal(stored), do: CoreSecret.reveal(stored, key())

  defp key do
    :sms_api
    |> Application.get_env(__MODULE__, [])
    |> Keyword.get(:key, "dev-only-not-a-real-key")
  end
end
