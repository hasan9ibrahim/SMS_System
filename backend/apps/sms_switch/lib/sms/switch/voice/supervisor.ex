defmodule Sms.Switch.Voice.Supervisor do
  @moduledoc """
  SMS to voice on this server (§8, `Sms.Switch.Voice`): the AMI connection to the server's Asterisk, the Asterisk
  files (gateways, recordings) and the calls' queues. Started with the pipeline's consumers once the routing
  configuration is loaded, only where voice is on (`SMS_ASTERISK_AMI_HOST` set).
  """
  use Supervisor
  alias Sms.Switch.Voice

  def start_link(opts \\ []), do: Supervisor.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    children = [
      {Voice.AmiClient, Keyword.get(opts, :ami, [])},
      {Voice.Files, Keyword.get(opts, :files, [])},
      {Voice.Calls, Keyword.get(opts, :calls, [])}
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
