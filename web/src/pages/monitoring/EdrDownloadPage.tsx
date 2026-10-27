// EDR Download (§9.2): background EDR exports with status, file, file type, progress, request start /
// end time, error and who asked. New requests come from EDR Search (Export).
import { pageForPath } from "../../nav/registry";
import { useTabNavigate } from "../../shell/tabContext";
import { Button } from "../../ui/primitives";
import { DownloadsList } from "./parts";

const page = pageForPath("/monitoring/edr-download")!;

export function EdrDownloadPage() {
  const navigate = useTabNavigate();
  return (
    <DownloadsList
      kind="edr"
      page={page}
      above={
        <div className="deck-above">
          <span className="fb-spacer" />
          <Button small icon="search" onClick={() => navigate("/monitoring/edr")}>
            EDR Search
          </Button>
        </div>
      }
    />
  );
}
