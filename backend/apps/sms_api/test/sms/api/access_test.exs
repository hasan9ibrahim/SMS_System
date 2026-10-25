defmodule Sms.Api.AccessRulesTest do
  # The server-side check of GUI Access Groups (backend steps 9 and 10, product owner 2026-10-25): every call is
  # checked, reads too; Admin pages are for administrators or a group that names the page; and the password gate
  # (§13.28) before a call is forwarded.
  use ExUnit.Case, async: false
  alias Sms.Api.{Access, Operations}

  describe "the operation table" do
    test "paths match their operation; a literal segment wins over a parameter" do
      assert %{operation_id: "createEnterprise", module: "enterprises", action: "add"} =
               Operations.find("POST", "/enterprises")

      assert %{operation_id: "forcePasswordChange", action: "change_password"} =
               Operations.find("POST", "/users/force-password-change")

      assert %{operation_id: "setUserPassword"} = Operations.find("POST", "/users/12/password")

      assert %{operation_id: "queryEnterprises", action: nil} =
               Operations.find("POST", "/enterprises/query")

      assert Operations.find("GET", "/no-such-thing") == nil
      assert length(Operations.all()) > 500
    end

    test "every read of a page is checked; Admin pages are flagged; shared pages name their action" do
      for op <- Operations.all(), op.module != nil, do: assert(op.read_checked)

      assert %{admin: true} = Operations.find("POST", "/audit-log/query")
      assert %{admin: false} = Operations.find("POST", "/enterprises/query")

      assert %{also_on: also} = Operations.find("POST", "/edr-downloads")
      assert %{module: "edr-search", action: "export"} in also
    end
  end

  describe "effective access (as the mock computes it)" do
    test "the group's pages, the user's overrides on top; an empty override denies even the every-page grant" do
      group = %{"*" => ["view", "edit"], "enterprises" => ["view"]}

      a =
        Map.put(
          Access.effective(group, %{"enterprises" => ["view", "add"], "invoices" => []}),
          :admin,
          false
        )

      assert Access.allowed?(a, "enterprises", "add")
      assert Access.allowed?(a, "route-rules", "edit")
      refute Access.allowed?(a, "route-rules", "delete")
      refute Access.allowed?(a, "invoices", "view")
      assert Access.allowed?(%{admin: true}, "users", "delete")
    end

    test "the every-page grant never covers an Admin page; naming the page does" do
      a = %{admin: false, permissions: %{"*" => ["view"], "audit" => ["view"]}, denied: []}
      assert Access.allowed?(a, "route-rules", "view", false)
      refute Access.allowed?(a, "users", "view", true)
      assert Access.allowed?(a, "audit", "view", true)
    end

    test "open operations and plain reads need nothing" do
      assert Access.check(1, %{module: nil, action: "edit", read_checked: false}) == :ok
      assert Access.check(1, %{module: "enterprises", action: nil, read_checked: false}) == :ok
    end
  end
end
