defmodule Sms.Switch.Voice.Prompts do
  @moduledoc """
  Rules' own recordings (§8 SMS to voice, product owner 2026-10-31, docs/SMS_TO_VOICE.md "Custom recordings"): each is
  a WAV file Asterisk plays in place of the default phrase, at `<sounds dir>/en/custom/sms-voice-rule-<sha256>.wav` on
  each server (each has its own Asterisk). The rules carry only the SHA-256 (`prompt_wav_sha256`); the recording itself
  is read from PostgreSQL only when its file is missing.

    * `sync/3` writes the missing files (temp file and rename, mode 0640), checked against their SHA-256, and removes
      files of that pattern no rule uses any more.
    * `variable/2` is what a call passes as `PROMPT`: `custom/sms-voice-rule-<sha256>` when the file is there, else
      empty, so the dialplan plays the default phrase; a call never waits for a recording.
  """
  require Logger
  alias Sms.Switch.Voice.Files

  @file_pattern ~r/\Asms-voice-rule-([0-9a-f]{64})\.wav\z/
  @temp_prefix ".sms-voice-rule-"

  @typedoc "Reads a recording by its SHA-256: its bytes, `:none`, or why not."
  @type fetch :: (String.t() -> {:ok, binary()} | :none | {:error, term()})

  @doc "The directory of the switch's recordings."
  @spec dir(String.t()) :: String.t()
  def dir(sounds_dir), do: Path.join([sounds_dir, "en", "custom"])

  @doc "The file of a recording."
  @spec path(String.t(), String.t()) :: String.t()
  def path(sounds_dir, sha256), do: Path.join(dir(sounds_dir), "sms-voice-rule-#{sha256}.wav")

  @doc "The `PROMPT` variable of a call for a rule with recording `sha256` (nil: the default phrase)."
  @spec variable(String.t(), String.t() | nil) :: String.t()
  def variable(_sounds_dir, nil), do: ""

  def variable(sounds_dir, sha256) do
    if File.regular?(path(sounds_dir, sha256)) do
      "custom/sms-voice-rule-#{sha256}"
    else
      Logger.warning(
        "recording #{sha256} is not on this server yet: the call plays the default phrase"
      )

      ""
    end
  end

  @doc """
  Puts the recordings `sha256s` on disk (each fetched only when its file is missing) and removes the switch's other
  recordings. Answers what it wrote, what it could not write (with why) and what it removed.
  """
  @spec sync(String.t(), [String.t()], fetch()) :: %{
          written: [String.t()],
          failed: [{String.t(), term()}],
          removed: [String.t()]
        }
  def sync(sounds_dir, sha256s, fetch) do
    dir = dir(sounds_dir)
    wanted = MapSet.new(sha256s)
    _ = File.mkdir_p(dir)

    {written, failed} =
      wanted
      |> Enum.reject(&File.regular?(path(sounds_dir, &1)))
      |> Enum.reduce({[], []}, fn sha, {written, failed} ->
        case write(sounds_dir, sha, fetch) do
          :ok -> {[sha | written], failed}
          {:error, reason} -> {written, [{sha, reason} | failed]}
        end
      end)

    %{written: Enum.sort(written), failed: Enum.sort(failed), removed: remove_unused(dir, wanted)}
  end

  defp write(sounds_dir, sha, fetch) do
    with {:ok, wav} <- fetched(fetch.(sha)),
         :ok <- same_hash(wav, sha) do
      Files.write_atomic(path(sounds_dir, sha), wav)
    end
  end

  defp fetched({:ok, wav}) when is_binary(wav), do: {:ok, wav}
  defp fetched(:none), do: {:error, :not_in_database}
  defp fetched({:error, _} = error), do: error

  defp same_hash(wav, sha) do
    if Base.encode16(:crypto.hash(:sha256, wav), case: :lower) == sha,
      do: :ok,
      else: {:error, :sha256_mismatch}
  end

  # Files of the pattern no rule uses, and temp files a write left (writes run one at a time, in the caller).
  defp remove_unused(dir, wanted) do
    case File.ls(dir) do
      {:ok, names} ->
        names
        |> Enum.filter(&(unused?(&1, wanted) and File.rm(Path.join(dir, &1)) == :ok))
        |> Enum.sort()

      {:error, _} ->
        []
    end
  end

  defp unused?(name, wanted) do
    case Regex.run(@file_pattern, name) do
      [_, sha] -> not MapSet.member?(wanted, sha)
      nil -> String.starts_with?(name, @temp_prefix)
    end
  end
end
