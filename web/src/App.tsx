// The app: the main window shell, or a single tab in its own window (§13.5).
import { Popout } from "./shell/Popout";
import { Shell } from "./shell/Shell";

export function App() {
  return location.pathname === "/popout" ? <Popout /> : <Shell />;
}
