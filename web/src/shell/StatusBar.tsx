// Status bar (§15.1): row counts, keyboard shortcuts, autosave state, server time (UTC).
import { useEffect, useState } from "react";
import { useServerOffset } from "../api/hooks";
import { useLive } from "../live/store";
import { usePageStatusStore } from "./tabContext";

function ServerClock() {
  const { data, isError } = useServerOffset();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (isError) return <span className="status-warn">Server not reachable</span>;
  const time = new Date(now + (data?.offset ?? 0)).toISOString().slice(11, 19);
  return (
    <span title={data ? `Answered by the ${data.backend} backend, contract ${data.contract}` : undefined}>
      Server UTC <span className="num">{time}</span>
    </span>
  );
}

export function StatusBar({ tabId }: { tabId: string }) {
  const status = usePageStatusStore((s) => s.byTab[tabId]);
  const connected = useLive((s) => s.connected);
  return (
    <footer className="statusbar">
      <span className="status-rows">{status?.rows ?? ""}</span>
      <span className="status-keys">
        {status?.shortcuts ?? "Ctrl K jump to · middle-click a tab to close · drag a tab out for a new window"}
      </span>
      <span className="status-right">
        <span className={connected ? "" : "status-warn"}>{connected ? "Live" : "Live offline"}</span>
        <span>Autosave on</span>
        <ServerClock />
      </span>
    </footer>
  );
}
