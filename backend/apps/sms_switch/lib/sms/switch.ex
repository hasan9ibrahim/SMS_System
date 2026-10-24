defmodule Sms.Switch do
  @moduledoc """
  The SMPP switch (spec §2, §5, §13.1; docs/SMPP_SCENARIOS.md). Built in steps (docs/BACKEND_PLAN.md):

    1. SMPP 3.4 PDU encoding and decoding (done: `Sms.Switch.Smpp.Pdu`, `Sms.Switch.Smpp.Tlv`)
    2. Customer side: we are the SMPP server (binds, TLS, keep-alives, windows, shared TPS limits, session affinity)
    3. Vendor side: we connect out (connections split across the servers, reconnects, submit timeout and re-route)
    4. The message pipeline: checks, translation, routing, credit, queue, receipts, EDRs
  """
end
