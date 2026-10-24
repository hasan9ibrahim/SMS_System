defmodule Sms.Core do
  @moduledoc """
  The platform's shared core (spec §14, docs/BACKEND_PLAN.md): the data stores (PostgreSQL for configuration,
  ClickHouse for EDRs, Redis for live counters), the event bus between services (NATS JetStream) and, from step 4,
  the domain: rating, routing, billing.

  Every other app talks to the data stores and the bus only through the modules here.
  """
end
