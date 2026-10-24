defmodule Sms.Switch.Vendor.Events do
  @moduledoc """
  Vendor session events on the bus, for Network Status (§13.1), the Bind Down Alert (§5.5, §13.6) and the
  possible-duplicate flag (S-5.2, decision D4):

  | Subject | When |
  | --- | --- |
  | `sms.session.vendor.bound` | a connection bound to the vendor |
  | `sms.session.vendor.closed` | a bound connection ended (unbind, timeout, error, trunk change) |
  | `sms.session.vendor.bind_failed` | a connect or bind attempt failed, with the reason and the wait before the next one |
  | `sms.session.vendor.bind_down` | a connection has been down for the trunk's Bind Alert time (once per outage) |
  | `sms.session.vendor.bind_up` | that connection bound again after a `bind_down` |
  | `sms.session.vendor.late_response` | a `submit_sm_resp` arrived after the submit had timed out |

  Publishing runs in its own process so a slow bus never delays a session.
  """
  alias Sms.Core.Bus

  @task_supervisor Sms.Switch.Vendor.Tasks

  @type what :: :bound | :closed | :bind_failed | :bind_down | :bind_up | :late_response

  @doc "Publishes `data` under `sms.session.vendor.<what>` without waiting."
  @spec publish(what(), map()) :: :ok
  def publish(what, data) do
    subject = "sms.session.vendor.#{what}"

    case Task.Supervisor.start_child(@task_supervisor, fn ->
           Bus.publish(subject, "session.vendor.#{what}", data)
         end) do
      {:ok, _pid} -> :ok
      # The node is stopping (task supervisor gone): the event is lost, as the session itself is.
      {:error, _} -> :ok
    end
  catch
    :exit, _ -> :ok
  end
end
