// The app: the main window shell, a single tab in its own window (§13.5), or the customer portal (§1).
import { lazy, Suspense } from "react";
import { Popout } from "./shell/Popout";
import { Shell } from "./shell/Shell";

// The customer portal is its own small app with its own sign-in; loaded only at /portal.
const PortalApp = lazy(() => import("./portal/PortalApp"));

export function App() {
  if (location.pathname === "/portal" || location.pathname.startsWith("/portal/"))
    return (
      <Suspense fallback={null}>
        <PortalApp />
      </Suspense>
    );
  return location.pathname === "/popout" ? <Popout /> : <Shell />;
}
