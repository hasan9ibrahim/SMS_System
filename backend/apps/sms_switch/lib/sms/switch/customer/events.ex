defmodule Sms.Switch.Customer.Events do
  @moduledoc """
  Session events on the bus, for Network Status (§13.1), bind alerts and Send Bind (§5.4), and the audit of failed
  binds (S-1.1):

  | Subject | When |
  | --- | --- |
  | `sms.session.customer.bound` | a bind succeeded |
  | `sms.session.customer.closed` | a bound session ended (unbind, timeout, error, trunk change) |
  | `sms.session.customer.bind_failed` | a bind was refused, with the reason (never the password) |

  Publishing runs in its own process so a slow bus never delays a session; a publish that fails is logged by the
  bus.
  """
  alias Sms.Core.Bus

  @task_supervisor Sms.Switch.Customer.Tasks

  @doc "Publishes `data` under `sms.session.customer.<what>` without waiting."
  @spec publish(:bound | :closed | :bind_failed, map()) :: :ok
  def publish(what, data) do
    subject = "sms.session.customer.#{what}"

    case Task.Supervisor.start_child(@task_supervisor, fn ->
           Bus.publish(subject, "session.customer.#{what}", data)
         end) do
      {:ok, _pid} -> :ok
      # The node is stopping (task supervisor gone): the event is lost, as the session itself is.
      {:error, _} -> :ok
    end
  catch
    :exit, _ -> :ok
  end
end
