// The app: the main window shell, a single tab in its own window (§13.5), the customer portal (§1), or the Set
// Password screen of an e-mailed link (§13.28).
import { lazy, Suspense } from "react";
import { Popout } from "./shell/Popout";
import { Shell } from "./shell/Shell";

// The customer portal is its own small app with its own sign-in; loaded only at /portal.
const PortalApp = lazy(() => import("./portal/PortalApp"));
// A set-password link's screen (team trial round 11): no sign-in, no shell.
const SetPasswordScreen = lazy(() => import("./shell/SetPassword").then((m) => ({ default: m.SetPasswordScreen })));

export function App() {
  if (location.pathname === "/portal" || location.pathname.startsWith("/portal/"))
    return (
      <Suspense fallback={null}>
        <PortalApp />
      </Suspense>
    );
  if (location.pathname === "/set-password")
    return (
      <Suspense fallback={null}>
        <SetPasswordScreen />
      </Suspense>
    );
  return location.pathname === "/popout" ? <Popout /> : <Shell />;
}
