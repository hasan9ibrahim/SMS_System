defmodule Sms.Switch.Voice.FilesTest do
  # §8 SMS to voice: this server's Asterisk files follow the configuration: the gateways' PJSIP file (written only when
  # it changes, then reloaded through AMI) and the rules' own recordings (written when missing, removed when unused).
  use ExUnit.Case, async: false
  @moduletag capture_log: true

  import ExUnit.CaptureLog
  import Sms.Switch.Test.CustomerCase, only: [assert_eventually: 1]
  alias Sms.Switch.Pipeline.Config
  alias Sms.Switch.Test.{FakeAmi, PipelineConfig}
  alias Sms.Switch.Voice.{AmiClient, Files, Prompts}

  @tmp "tmp/voice_files_test"

  setup do
    dir = Path.expand(Path.join(@tmp, "#{System.unique_integer([:positive])}"))
    File.mkdir_p!(Path.join(dir, "etc"))
    on_exit(fn -> File.rm_rf!(dir) end)

    %{
      dir: dir,
      pjsip: Path.join([dir, "etc", "pjsip_sms_voice.conf"]),
      sounds: Path.join(dir, "sounds")
    }
  end

  defp wav(text), do: "RIFF" <> text
  defp sha(bytes), do: Base.encode16(:crypto.hash(:sha256, bytes), case: :lower)

  defp config(opts) do
    PipelineConfig.put(opts)

    case Process.whereis(Config.Server) do
      nil -> start_supervised!({Config.Server, loader: PipelineConfig})
      _ -> :ok = Config.Server.refresh()
    end

    assert_eventually(&Config.ready?/0)
  end

  defp start_files(ctx, opts \\ []) do
    start_supervised!(
      {Files,
       Keyword.merge(
         [
           pjsip_file: ctx.pjsip,
           sounds_dir: ctx.sounds,
           sync_ms: 3_600_000,
           loader: PipelineConfig
         ],
         opts
       )}
    )
  end

  describe "the gateways' PJSIP file" do
    test "rewritten in place when it changes (its mode kept), then reloaded through AMI; unchanged, neither",
         ctx do
      ami = FakeAmi.start()
      on_exit(fn -> if Process.alive?(ami), do: FakeAmi.stop(ami) end)
      start_supervised!({AmiClient, FakeAmi.client_opts(ami)})
      assert_eventually(&AmiClient.ready?/0)

      # As the Ansible role leaves it: there, empty, its own mode.
      File.write!(ctx.pjsip, "")
      File.chmod!(ctx.pjsip, 0o660)
      %{inode: inode} = File.stat!(ctx.pjsip)

      config(voice_gateways: [PipelineConfig.voice_gateway(id: 3)])
      start_files(ctx)
      :ok = Files.sync()

      assert File.read!(ctx.pjsip) =~ "[smsvoice-gw3]"
      # The same file, written in place: its mode (and owner, group) as they were.
      assert %{inode: ^inode, mode: mode} = File.stat!(ctx.pjsip)
      assert Bitwise.band(mode, 0o777) == 0o660
      assert_receive {:ami, "command", %{"command" => "module reload res_pjsip.so"}}, 2_000

      # Nothing changed: not written again, not reloaded.
      %{mtime: mtime} = File.stat!(ctx.pjsip, time: :posix)
      :ok = Files.sync()
      refute_receive {:ami, "command", _}, 100
      assert File.stat!(ctx.pjsip, time: :posix).mtime == mtime
      # No temp file is left.
      assert File.ls!(Path.dirname(ctx.pjsip)) == ["pjsip_sms_voice.conf"]

      # A new gateway: written and reloaded; a changed configuration is picked up when told (`changed/0`).
      config(
        voice_gateways: [PipelineConfig.voice_gateway(id: 3), PipelineConfig.voice_gateway(id: 4)]
      )

      assert_receive {:ami, "command", _}, 2_000
      assert File.read!(ctx.pjsip) =~ "[smsvoice-gw4]"
    end

    test "a reload Asterisk refuses, or one it cannot take now, is sent again later", ctx do
      ami = FakeAmi.start()
      on_exit(fn -> if Process.alive?(ami), do: FakeAmi.stop(ami) end)
      FakeAmi.set(ami, :command, {:error, "Fake no such module"})
      start_supervised!({AmiClient, FakeAmi.client_opts(ami)})
      assert_eventually(&AmiClient.ready?/0)

      config(voice_gateways: [PipelineConfig.voice_gateway([])])

      log =
        capture_log(fn ->
          start_files(ctx)
          :ok = Files.sync()
        end)

      assert log =~ "PJSIP reload not done"
      # Refused on each run until it is done (the first run at start, then the sync).
      assert_receive {:ami, "command", _}, 2_000
      assert_receive {:ami, "command", _}, 2_000

      FakeAmi.set(ami, :command, :ok)
      :ok = Files.sync()
      assert_receive {:ami, "command", _}, 2_000
      :ok = Files.sync()
      refute_receive {:ami, "command", _}, 100
    end

    test "without Asterisk the file is still written; a file that cannot be written is logged once",
         ctx do
      config(voice_gateways: [PipelineConfig.voice_gateway([])])
      bad = Path.join([ctx.dir, "missing", "dir", "pjsip.conf"])

      # A file not there yet is created, mode 0640.
      start_supervised!(
        {Files, pjsip_file: ctx.pjsip, sounds_dir: ctx.sounds, sync_ms: 3_600_000},
        id: :other
      )

      :ok = Files.sync()
      assert File.stat!(ctx.pjsip).mode |> Bitwise.band(0o777) == 0o640
      stop_supervised!(:other)

      log =
        capture_log(fn ->
          start_files(ctx, pjsip_file: bad)
          :ok = Files.sync()
          :ok = Files.sync()
        end)

      assert length(String.split(log, "voice gateways not written")) == 2
      refute AmiClient.ready?()
    end
  end

  describe "the rules' own recordings" do
    test "each written once when missing (checked by its hash, mode 0640); unused ones removed",
         ctx do
      one = wav("fake recording one")
      two = wav("fake recording two")
      old = sha(wav("an old one"))
      custom = Prompts.dir(ctx.sounds)
      File.mkdir_p!(custom)
      File.write!(Path.join(custom, "sms-voice-rule-#{old}.wav"), "old")
      File.write!(Path.join(custom, ".sms-voice-rule-#{old}.wav.tmp-dead"), "left by a crash")
      File.write!(Path.join(custom, "someone-elses.wav"), "kept")

      config(
        voice_gateways: [PipelineConfig.voice_gateway([])],
        voice_rules: [
          PipelineConfig.voice_rule(id: 1, prompt_wav_sha256: sha(one)),
          PipelineConfig.voice_rule(id: 2, prompt_wav_sha256: String.upcase(sha(two))),
          PipelineConfig.voice_rule(id: 3, prompt_wav_sha256: sha(one))
        ],
        prompt_wavs: %{sha(one) => one, sha(two) => two}
      )

      start_files(ctx)
      :ok = Files.sync()

      assert File.read!(Prompts.path(ctx.sounds, sha(one))) == one
      assert File.read!(Prompts.path(ctx.sounds, sha(two))) == two
      assert File.stat!(Prompts.path(ctx.sounds, sha(one))).mode |> Bitwise.band(0o777) == 0o640

      assert Enum.sort(File.ls!(custom)) ==
               Enum.sort([
                 "sms-voice-rule-#{sha(one)}.wav",
                 "sms-voice-rule-#{sha(two)}.wav",
                 "someone-elses.wav"
               ])

      # The rule with recording two goes: its file goes too.
      config(
        voice_gateways: [PipelineConfig.voice_gateway([])],
        voice_rules: [PipelineConfig.voice_rule(id: 1, prompt_wav_sha256: sha(one))],
        prompt_wavs: %{}
      )

      :ok = Files.sync()
      refute File.exists?(Prompts.path(ctx.sounds, sha(two)))
      # Recording one is on disk already: not read again (the database no longer has it here).
      assert File.read!(Prompts.path(ctx.sounds, sha(one))) == one
    end

    test "a recording that cannot be read or does not match its hash is not written, logged once",
         ctx do
      good = wav("fake good")
      missing = sha(wav("nowhere"))
      broken = sha(wav("expected"))
      failing = sha(wav("db down"))

      config(
        voice_rules: [
          PipelineConfig.voice_rule(id: 1, prompt_wav_sha256: missing),
          PipelineConfig.voice_rule(id: 2, prompt_wav_sha256: broken),
          PipelineConfig.voice_rule(id: 3, prompt_wav_sha256: failing),
          PipelineConfig.voice_rule(id: 4, prompt_wav_sha256: sha(good)),
          # Not a SHA-256: no recording (the default phrase).
          PipelineConfig.voice_rule(id: 5, prompt_wav_sha256: "not-a-hash")
        ],
        prompt_wavs: %{
          broken => wav("something else"),
          failing => {:error, :fake_down},
          sha(good) => good
        }
      )

      log =
        capture_log(fn ->
          start_files(ctx)
          :ok = Files.sync()
          :ok = Files.sync()
        end)

      assert log =~
               "recording #{missing} not written (calls play the default phrase): :not_in_database"

      assert log =~
               "recording #{broken} not written (calls play the default phrase): :sha256_mismatch"

      assert log =~ "recording #{failing} not written (calls play the default phrase): :fake_down"
      assert length(String.split(log, "recording #{missing} not written")) == 2
      assert File.ls!(Prompts.dir(ctx.sounds)) == ["sms-voice-rule-#{sha(good)}.wav"]
    end

    test "a call's PROMPT: the recording when its file is there, else empty (the default phrase), logged",
         ctx do
      good = wav("fake")
      assert Prompts.variable(ctx.sounds, nil) == ""

      log = capture_log(fn -> assert Prompts.variable(ctx.sounds, sha(good)) == "" end)
      assert log =~ "not on this server yet"

      File.mkdir_p!(Prompts.dir(ctx.sounds))
      File.write!(Prompts.path(ctx.sounds, sha(good)), good)
      assert Prompts.variable(ctx.sounds, sha(good)) == "custom/sms-voice-rule-#{sha(good)}"
    end

    test "a directory that cannot be listed or written: nothing written, nothing removed", ctx do
      File.write!(Path.join(ctx.dir, "sounds"), "a file where the directory should be")
      result = Prompts.sync(ctx.sounds, [sha("x")], fn _ -> {:ok, "x"} end)
      assert %{written: [], removed: [], failed: [{_, _}]} = result
    end
  end

  test "nothing happens before the configuration is loaded", ctx do
    start_files(ctx)
    :ok = Files.sync()
    refute File.exists?(ctx.pjsip)
  end
end
