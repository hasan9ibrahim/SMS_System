defmodule Sms.Switch.Voice.Files do
  @moduledoc """
  Keeps this server's Asterisk files in step with the SMS-to-voice configuration (§8, docs/SMS_TO_VOICE.md). Each
  server has its own Asterisk, so each server writes its own files:

    * the gateways' PJSIP configuration (`SMS_ASTERISK_PJSIP_FILE`, `/etc/asterisk/pjsip_sms_voice.conf` by default,
      `Sms.Switch.Voice.Pjsip`): rewritten in place only when its content changes (`write_in_place/2`: the switch
      user may not create files in `/etc/asterisk`, and the file keeps the owner, group `asterisk` and mode the
      Ansible role gave it), then `module reload res_pjsip.so` through AMI, so Asterisk only reads it once it is
      whole; a reload that could not be sent (Asterisk not connected) is sent once it is;
    * the rules' own recordings under `SMS_ASTERISK_SOUNDS_DIR/en/custom` (`Sms.Switch.Voice.Prompts`, temp file
      and rename: that directory is the switch's to write, setgid group `asterisk`).

  It runs when the routing configuration changes (`changed/0`, from `Sms.Switch.Pipeline.Config.Server`) and every
  `:sync_ms` (10 s), which also retries what failed. A failure is logged once until it changes; it never stops calls
  (a missing recording plays the default phrase).
  """
  use GenServer
  require Logger
  alias Sms.Switch.Pipeline.Config
  alias Sms.Switch.Pipeline.Config.Loader
  alias Sms.Switch.Voice
  alias Sms.Switch.Voice.{AmiClient, Pjsip, Prompts}

  @reload "module reload res_pjsip.so"

  @doc """
  Options (else `config :sms_switch, Sms.Switch.Voice`): `:pjsip_file`, `:sounds_dir`, `:sync_ms`, `:loader` (reads a
  recording, `prompt_wav/1`; `Sms.Switch.Pipeline.Config.Loader` by default).
  """
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "The configuration changed: the files are brought in step now (no-op where voice is off)."
  @spec changed() :: :ok
  def changed, do: GenServer.cast(__MODULE__, :sync)

  @doc "Brings the files in step now and waits (tests, and after a save)."
  @spec sync(timeout()) :: :ok
  def sync(timeout \\ 30_000), do: GenServer.call(__MODULE__, :sync, timeout)

  @doc """
  Rewrites the existing file `path` in place (opened, truncated, written), so it keeps its owner, group and mode; a
  file that is not there yet is created with mode 0640.
  """
  @spec write_in_place(String.t(), iodata()) :: :ok | {:error, term()}
  def write_in_place(path, bytes) do
    existed = File.exists?(path)

    with :ok <- File.write(path, bytes) do
      if existed, do: :ok, else: File.chmod(path, 0o640)
    end
  end

  @doc """
  Writes `bytes` to `path` as a whole or not at all: a temp file in the same directory, mode 0640, renamed over it.
  """
  @spec write_atomic(String.t(), iodata()) :: :ok | {:error, term()}
  def write_atomic(path, bytes) do
    temp =
      Path.join(
        Path.dirname(path),
        "." <>
          Path.basename(path) <>
          ".tmp-" <> Base.encode16(:crypto.strong_rand_bytes(4), case: :lower)
      )

    with :ok <- File.write(temp, bytes),
         :ok <- File.chmod(temp, 0o640),
         :ok <- File.rename(temp, path) do
      :ok
    else
      error ->
        _ = File.rm(temp)
        error
    end
  end

  @impl true
  def init(opts) do
    config = Keyword.merge(Application.get_env(:sms_switch, Voice, []), opts)

    state = %{
      pjsip_file: Keyword.get(config, :pjsip_file, "/etc/asterisk/pjsip_sms_voice.conf"),
      sounds_dir: Keyword.get(config, :sounds_dir, Voice.sounds_dir()),
      sync_ms: Keyword.get(config, :sync_ms, 10_000),
      loader: Keyword.get(config, :loader, Loader),
      reload: false,
      problems: %{}
    }

    send(self(), :tick)
    {:ok, state}
  end

  @impl true
  def handle_call(:sync, _from, state), do: {:reply, :ok, run(state)}

  @impl true
  def handle_cast(:sync, state), do: {:noreply, run(state)}

  @impl true
  def handle_info(:tick, state) do
    Process.send_after(self(), :tick, state.sync_ms)
    {:noreply, run(state)}
  end

  defp run(state) do
    state =
      if Config.ready?() do
        voice = Config.voice()

        state
        |> pjsip(Map.values(voice.gateways))
        |> prompts(for(r <- voice.rules, r.prompt, do: r.prompt))
      else
        state
      end

    reload(state)
  end

  # ---------------------------------------------------------------- gateways

  defp pjsip(state, gateways) do
    content = Pjsip.render(gateways)

    case File.read(state.pjsip_file) do
      {:ok, ^content} ->
        solved(state, :pjsip)

      _ ->
        case write_in_place(state.pjsip_file, content) do
          :ok ->
            Logger.info(
              "voice gateways written to #{state.pjsip_file} (#{length(gateways)} active)"
            )

            %{solved(state, :pjsip) | reload: true}

          {:error, reason} ->
            problem(state, :pjsip, reason, "voice gateways not written to #{state.pjsip_file}")
        end
    end
  end

  defp reload(%{reload: true} = state) do
    if AmiClient.ready?() do
      case AmiClient.command(@reload) do
        {:ok, _output} ->
          Logger.info("Asterisk reloaded its PJSIP configuration (voice gateways)")
          %{solved(state, :reload) | reload: false}

        {:error, reason} ->
          problem(state, :reload, reason, "PJSIP reload not done, tried again")
      end
    else
      state
    end
  end

  defp reload(state), do: state

  # ---------------------------------------------------------------- recordings

  defp prompts(state, shas) do
    loader = state.loader
    result = Prompts.sync(state.sounds_dir, Enum.uniq(shas), &loader.prompt_wav/1)

    for sha <- result.written, do: Logger.info("recording #{sha} written for SMS to voice")
    for sha <- result.removed, do: Logger.info("recording file #{sha} removed: no rule uses it")

    failed = Map.new(result.failed)

    # Logged once per recording and reason; a recording written later is forgotten.
    state = Enum.reduce(result.written, state, &solved(&2, {:prompt, &1}))

    Enum.reduce(failed, state, fn {sha, reason}, state ->
      problem(
        state,
        {:prompt, sha},
        reason,
        "recording #{sha} not written (calls play the default phrase)"
      )
    end)
  end

  defp problem(state, key, reason, text) do
    if Map.get(state.problems, key) != reason, do: Logger.error("#{text}: #{inspect(reason)}")
    %{state | problems: Map.put(state.problems, key, reason)}
  end

  defp solved(state, key), do: %{state | problems: Map.delete(state.problems, key)}
end
