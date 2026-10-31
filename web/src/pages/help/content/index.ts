// Every help topic, in contents order (§15.1 help). Each area's text lives in its own file.
import type { HelpFigure, HelpTopic } from "../helpTypes";
import figures from "./figures.json";
import { topics as admin } from "./admin";
import { topics as basics } from "./basics";
import { topics as enterprises } from "./enterprises";
import { topics as finance } from "./finance";
import { topics as monitoring } from "./monitoring";
import { topics as rates } from "./rates";
import { topics as reports } from "./reports";
import { topics as routing } from "./routing";
import { topics as switching } from "./switch";

/** Contents groups, in menu order. */
export const GROUPS = [
  "Getting started",
  "Dashboard & live",
  "Enterprises",
  "Finance",
  "Rates",
  "Routing",
  "Switch",
  "Monitoring",
  "Reports",
  "Admin",
];

/** Help pictures (§15.1 help): figure id -> the topic whose "Quick tour" opens with it. */
const TOUR_TOPIC: Record<string, string> = { grids: "grids-and-filters" };
const FIGURES = figures as Record<string, HelpFigure>;

/** A topic with a picture starts with a "Quick tour": the screenshot with numbered arrows. */
function withTour(t: HelpTopic): HelpTopic {
  const ids = Object.keys(FIGURES).filter((f) => (TOUR_TOPIC[f] ?? f) === t.id);
  if (!ids.length) return t;
  const blocks = ids.map((id) => ({ kind: "figure" as const, figure: FIGURES[id]! }));
  return { ...t, sections: [{ id: "tour", title: "Quick tour", blocks }, ...t.sections] };
}

/** Topics by group, in the order each area's file lists them. */
export const TOPICS: HelpTopic[] = [basics, enterprises, finance, rates, routing, switching, monitoring, reports, admin]
  .flat()
  .map(withTour)
  .map((t, i) => ({ t, i }))
  .sort((a, b) => (GROUPS.indexOf(a.t.group) + 1 || 99) - (GROUPS.indexOf(b.t.group) + 1 || 99) || a.i - b.i)
  .map(({ t }) => t);

export const TOPIC_BY_ID = new Map(TOPICS.map((t) => [t.id, t]));
