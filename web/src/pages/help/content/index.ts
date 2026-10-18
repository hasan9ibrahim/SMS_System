// Every help topic, in contents order (§15.1 help). Each area's text lives in its own file
// (being written: the topics arrive in the next commit).
import type { HelpTopic } from "../helpTypes";

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

export const TOPICS: HelpTopic[] = [];

export const TOPIC_BY_ID = new Map(TOPICS.map((t) => [t.id, t]));
