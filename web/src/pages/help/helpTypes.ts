// Help center content model (§15.1 help). Topics are static text bundled with the app; each page
// topic links to its screen by registry key, so the page header can open its own help.
//
// Inline text supports **bold**, `code` and links to other topics as [[topic-id]] or
// [[topic-id|label]] (topic-id may add #section-id).

/** One form field or column: what it is and what to put in it. */
export interface HelpField {
  name: string;
  /** What the field does / means. */
  what: string;
  /** What to enter: allowed values, format, default or an example. */
  values?: string;
}

export type HelpBlock =
  | { kind: "text"; text: string }
  | { kind: "steps"; title?: string; items: string[] }
  | { kind: "list"; title?: string; items: string[] }
  | { kind: "fields"; title?: string; fields: HelpField[] }
  | { kind: "tip"; text: string }
  | { kind: "warning"; text: string }
  | { kind: "figure"; figure: HelpFigure };

/** One numbered arrow on a help picture; positions are % of the picture (spot `x`,`y`; bubble `bx`,`by`). */
export interface HelpMark {
  label: string;
  text: string;
  x: number;
  y: number;
  bx: number;
  by: number;
}

/**
 * A screenshot with numbered arrows (team trial round 6). Made by web/scripts/help-figures.mjs into
 * content/figures.json; the arrows are drawn over the picture so they stay sharp.
 */
export interface HelpFigure {
  src: string;
  alt: string;
  width: number;
  height: number;
  marks: HelpMark[];
}

export interface HelpSection {
  /** Unique within the topic; used in links (#id). */
  id: string;
  title: string;
  blocks: HelpBlock[];
}

export interface HelpTopic {
  /** URL slug. Page topics use the page's registry key (nav/registry.ts). */
  id: string;
  title: string;
  /** Group in the help contents, e.g. "Getting started", "Enterprises", "Rates". */
  group: string;
  /** Registry key of the screen this topic explains ("Open page" button, context help). */
  pageKey?: string;
  /** One or two sentences: what it is for. */
  summary: string;
  /** Extra search words (synonyms, abbreviations, old-platform names). */
  keywords?: string[];
  sections: HelpSection[];
}
