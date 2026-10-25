defmodule Sms.Switch.Test.FakeHlr do
  @moduledoc """
  A fake HLR provider client (fake data): `script/1` sets the answer per provider id (`{:ok, found}`,
  `{:error, :timeout}`, `{:error, reason}`); every request is recorded and sent to the test process that scripted it.
  """
  @behaviour Sms.Switch.Pipeline.Hlr.Client

  @key {__MODULE__, :script}

  @doc "Answers per provider id; a provider not named answers with an error. Installs this client for the test."
  def script(answers) do
    :persistent_term.put(@key, {self(), answers})
    previous = Application.get_env(:sms_switch, Sms.Switch.Pipeline.Hlr, [])

    Application.put_env(
      :sms_switch,
      Sms.Switch.Pipeline.Hlr,
      Keyword.put(previous, :client, __MODULE__)
    )

    ExUnit.Callbacks.on_exit(fn ->
      Application.put_env(:sms_switch, Sms.Switch.Pipeline.Hlr, previous)
    end)
  end

  @doc "A successful answer."
  def found(mccmnc, ported \\ false),
    do: {:ok, %{accomplished: true, mccmnc: mccmnc, ported: ported, error_code: 0}}

  @impl true
  def request(provider, number) do
    {test, answers} = :persistent_term.get(@key)
    send(test, {:hlr_request, provider.id, number})
    Map.get(answers, provider.id, {:error, :not_scripted})
  end
end
