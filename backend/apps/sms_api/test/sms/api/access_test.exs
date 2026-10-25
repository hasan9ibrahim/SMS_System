defmodule Sms.Api.AccessRulesTest do
  # The server-side check of GUI Access Groups (backend step 9, product owner 2026-10-25): changes are checked, reads
  # stay open, Admin pages need View even to read; and the password gate (§13.28) before a call is forwarded.
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

    test "every page in the table offers its action" do
      for op <- Operations.all(), op.module != nil, do: assert(is_boolean(op.read_checked))
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

    test "open operations and plain reads need nothing" do
      assert Access.check(1, %{module: nil, action: "edit", read_checked: false}) == :ok
      assert Access.check(1, %{module: "enterprises", action: nil, read_checked: false}) == :ok
    end
  end
end
