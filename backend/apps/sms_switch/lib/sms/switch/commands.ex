defmodule Sms.Switch.Commands do
  @moduledoc """
  Commands from the platform's screens to the switch servers (backend step 11c): Network Status bind stop and start,
  Test SMS, EDR Repush, signaling captures and the traffic recording (PCAP), and Network Diagnosis (spec §9.2).

  The TypeScript service asks over plain NATS request/reply (not JetStream: these subjects are outside the `sms.>`
  stream, so nothing is stored and no stream answers in the switch's place). Each switch server listens on:

    * `smscmd.all.<command>`: every server answers (e.g. a capture runs on both, each records its own traffic);
    * `smscmd.any.<command>`: one server answers (queue group), e.g. Test SMS;
    * `smscmd.node.<node id>.<command>`: that server only, e.g. reading a file it holds.

  The request body is a JSON object; the answer is `{"ok": true, "node": id, "data": {...}}` or
  `{"ok": false, "node": id, "error": "..."}`. A server that has nothing to do with an `all` command (e.g. a
  diagnosis from another server's address) answers `{"ok": true, "skip": true}`.
  """
  use Gnat.Server
  require Logger
  alias Sms.Switch.Commands.{Diagnose, Inject}

  @prefix "smscmd"
  @queue_group "sms-switch"

  @doc "The supervisor that subscribes to the command subjects on the bus connection (re-subscribed after a reconnect)."
  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(_opts) do
    %{
      id: __MODULE__,
      start:
        {Gnat.ConsumerSupervisor, :start_link,
         [
           %{
             connection_name: Sms.Core.Bus.Nats.connection(),
             module: __MODULE__,
             subscription_topics: [
               %{topic: "#{@prefix}.all.>"},
               %{topic: "#{@prefix}.any.>", queue_group: @queue_group},
               %{topic: "#{@prefix}.node.#{node_id()}.>"}
             ]
           }
         ]}
    }
  end

  @doc "This server's id in subjects and answers: its node name with anything but letters, digits, `_` and `-` as `_`."
  @spec node_id() :: String.t()
  def node_id, do: node() |> Atom.to_string() |> String.replace(~r/[^A-Za-z0-9_-]/, "_")

  @impl Gnat.Server
  def request(%{topic: topic, body: body}) do
    {:reply, Jason.encode!(answer(command(topic), body))}
  end

  @impl Gnat.Server
  def error(_message, error) do
    Logger.error("switch command failed: #{inspect(error)}")

    {:reply,
     Jason.encode!(%{ok: false, node: node_id(), error: "the command failed on #{node_id()}"})}
  end

  @doc false
  # The command name: the subject's last part.
  @spec command(String.t()) :: String.t()
  def command(topic), do: topic |> String.split(".") |> List.last()

  @doc "The answer to one command (`body` is the request's JSON)."
  @spec answer(String.t(), binary()) :: map()
  def answer(name, body) do
    with {:ok, data} when is_map(data) <- decode(body),
         {:ok, result} <- handle(name, data) do
      case result do
        :skip -> %{ok: true, node: node_id(), skip: true}
        map -> %{ok: true, node: node_id(), data: map}
      end
    else
      {:ok, _} -> %{ok: false, node: node_id(), error: "the request must be a JSON object"}
      {:error, reason} -> %{ok: false, node: node_id(), error: message(reason)}
    end
  end

  defp decode(""), do: {:ok, %{}}
  defp decode(body), do: with({:error, _} <- Jason.decode(body), do: {:error, :bad_json})

  @doc "Runs one command."
  @spec handle(String.t(), map()) :: {:ok, map() | :skip} | {:error, term()}
  def handle("ping", _data), do: {:ok, %{version: version()}}

  # Network Status Stop / Start (§9.2): the service has already marked the trunk in `trunk_binds`; the trunk stores and
  # the routing snapshot re-read it now instead of within their 5 s refresh.
  def handle("bind", %{"side" => side}) when side in ["customer", "vendor"] do
    reload(side)
    {:ok, %{reloaded: side}}
  end

  def handle("bind", _), do: {:error, {:bad_input, "side must be customer or vendor"}}
  def handle("diagnose", data), do: Diagnose.run(data)
  def handle("test_sms", data), do: Inject.test_sms(data)
  def handle("repush", data), do: Inject.repush(data)
  def handle(name, _), do: {:error, {:unknown_command, name}}

  defp reload("customer") do
    if enabled?(Sms.Switch.Customer), do: Sms.Switch.Customer.reload_trunks()
  end

  defp reload("vendor") do
    if enabled?(Sms.Switch.Vendor), do: Sms.Switch.Vendor.reload_trunks()
    if enabled?(Sms.Switch.Pipeline), do: Sms.Switch.Pipeline.Config.Server.nudge()
  end

  defp enabled?(side),
    do: :sms_switch |> Application.get_env(side, []) |> Keyword.get(:enabled, false)

  defp version, do: :sms_switch |> Application.spec(:vsn) |> to_string()

  defp message({:bad_input, text}), do: text
  defp message({:unknown_command, name}), do: "unknown command #{inspect(name)}"
  defp message(:bad_json), do: "the request is not JSON"
  defp message(text) when is_binary(text), do: text
  defp message(other), do: inspect(other)
end
