// Every help topic, in contents order (§15.1 help). Each area's text lives in its own file.
import type { HelpTopic } from "../helpTypes";
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

/** Topics by group, in the order each area's file lists them. */
export const TOPICS: HelpTopic[] = [basics, enterprises, finance, rates, routing, switching, monitoring, reports, admin]
  .flat()
  .map((t, i) => ({ t, i }))
  .sort((a, b) => (GROUPS.indexOf(a.t.group) + 1 || 99) - (GROUPS.indexOf(b.t.group) + 1 || 99) || a.i - b.i)
  .map(({ t }) => t);

export const TOPIC_BY_ID = new Map(TOPICS.map((t) => [t.id, t]));
