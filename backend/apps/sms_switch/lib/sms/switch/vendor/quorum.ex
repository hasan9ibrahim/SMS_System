defmodule Sms.Switch.Vendor.Quorum do
  @moduledoc """
  Which servers share the vendor connections when the servers may have lost each other (backend step 8; load test
  step 7: with the link between the servers cut, each opened the connections it thought the other had lost, so
  vendors saw twice Max Connections; product owner 2026-10-25, decision 5).

  The cluster is the two servers and the witness VM (`SWITCH_PEERS`, with `SWITCH_WITNESS` naming the witness). The
  witness runs the release with no traffic and keeps the vendor side's process group, so it sees which servers run
  their vendor connections:

    * a server that reaches neither the other server nor the witness (fewer than 2 of the 3 machines) **opens no
      vendor connection**: the other side, which still has the majority, takes them over;
    * a server that lost the other one but still reaches the witness counts the other server as long as the witness
      still sees it: each keeps its own share and **nothing is opened twice**. Only once the witness has lost it too
      (the other server is really down) are its connections taken over.

  Without a witness configured (development, one server) the vendor nodes are the ones this node sees, as before.

  `cluster` is `config :sms_core, Sms.Core.Cluster` (`:peers`, `:witness`); tests also pass `:connected` (the nodes
  reached) and `:witness_view` (what the witness answers).
  """

  @scope :sms_vendor_sessions
  @group :vendor_nodes
  @timeout 500

  @doc """
  The vendor nodes to share the connections among, given those this node sees (`seen`, sorted); `[]` when this node
  is in the minority and must open none.
  """
  @spec nodes([node()], keyword()) :: [node()]
  def nodes(seen, cluster \\ Application.get_env(:sms_core, Sms.Core.Cluster, [])) do
    case witness(cluster) do
      nil ->
        seen

      witness ->
        connected = Keyword.get(cluster, :connected, Node.list())
        machines = Enum.uniq([node(), witness | Enum.map(peers(cluster), &to_node/1)])
        reached = Enum.count(machines, &(&1 == node() or &1 in connected))
        view = Keyword.get(cluster, :witness_view, &seen_by/1)

        cond do
          reached * 2 <= length(machines) -> []
          witness in connected -> Enum.sort(Enum.uniq(seen ++ view.(witness)))
          true -> seen
        end
    end
  end

  @doc "Whether a witness is configured (the manager then checks the quorum every few seconds)."
  @spec enabled?(keyword()) :: boolean()
  def enabled?(cluster \\ Application.get_env(:sms_core, Sms.Core.Cluster, [])),
    do: witness(cluster) != nil

  # The servers the witness sees running their vendor side; none if it does not answer in time.
  defp seen_by(witness) do
    witness
    |> :erpc.call(:pg, :get_members, [@scope, @group], @timeout)
    |> Enum.map(&node/1)
  catch
    _, _ -> []
  end

  defp witness(cluster) do
    case cluster[:witness] do
      name when name in [nil, ""] -> nil
      name -> to_node(name)
    end
  end

  defp peers(cluster), do: Keyword.get(cluster, :peers, [])

  defp to_node(name) when is_atom(name), do: name
  defp to_node(name) when is_binary(name), do: String.to_atom(name)
end
