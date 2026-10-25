defmodule Sms.Switch.Vendor.QuorumTest do
  # The witness decides who keeps the vendor connections when the servers lose each other (backend step 8).
  use ExUnit.Case, async: true
  alias Sms.Switch.Vendor.Quorum

  @b :"sms@server-b"
  @w :sms@witness
  @cluster [peers: ["sms@server-b", "sms@witness"], witness: "sms@witness"]

  defp nodes(seen, connected, view \\ fn _ -> [] end),
    do: Quorum.nodes(seen, @cluster ++ [connected: connected, witness_view: view])

  test "without a witness the nodes seen share the connections" do
    assert Quorum.nodes([node()], peers: ["sms@server-b"]) == [node()]
    assert Quorum.nodes([node()], []) == [node()]
    refute Quorum.enabled?(peers: ["sms@server-b"], witness: "")
    assert Quorum.enabled?(@cluster)
  end

  test "all three reached: the nodes seen, and those the witness sees" do
    seen = Enum.sort([node(), @b])
    assert nodes(seen, [@b, @w], fn @w -> seen end) == seen
  end

  test "the link to the other server cut: the witness still sees it, so each keeps its own share" do
    assert nodes([node()], [@w], fn @w -> [@b] end) == Enum.sort([node(), @b])
  end

  test "the other server really down: the witness lost it too, so its connections are taken over" do
    assert nodes([node()], [@w], fn @w -> [node()] end) == [node()]
  end

  test "the witness unreachable but the other server there: a majority, shared as before" do
    seen = Enum.sort([node(), @b])
    assert nodes(seen, [@b]) == seen
  end

  test "alone (neither the other server nor the witness): no vendor connection here" do
    assert nodes([node()], []) == []
  end

  test "a witness that does not answer counts as seeing nothing" do
    # Not a reachable node: the real lookup gives up and returns none.
    assert Quorum.nodes([node()], @cluster ++ [connected: [@w]]) == [node()]
  end
end
