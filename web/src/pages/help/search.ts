// Help center search (§15.1 help). The help text is static and ships with the app, so it is
// searched here in the browser; it is not a data list and has no server endpoint (CLAUDE.md rule 3
// covers data lists).
import type { HelpBlock, HelpTopic } from "./helpTypes";

/** Inline markup removed: **bold**, `code`, [[id|label]] → label. */
export function plain(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

export function blockText(b: HelpBlock): string {
  switch (b.kind) {
    case "text":
    case "tip":
    case "warning":
      return plain(b.text);
    case "steps":
    case "list":
      return [b.title ?? "", ...b.items.map(plain)].join(" ");
    case "fields":
      return [b.title ?? "", ...b.fields.map((f) => `${f.name}: ${plain(f.what)} ${plain(f.values ?? "")}`)].join(" ");
    case "figure":
      return b.figure.marks.map((m) => `${m.label}: ${plain(m.text)}`).join(" ");
  }
}

/** Lower-case words of a query; quotes keep a phrase together. */
export function tokens(query: string): string[] {
  const out: string[] = [];
  for (const m of query.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2] ?? "").replace(/^[^\p{L}\p{N}%]+|[^\p{L}\p{N}%]+$/gu, "").trim();
    if (t) out.push(t);
  }
  return out;
}

interface Entry {
  topic: HelpTopic;
  sectionId?: string;
  sectionTitle?: string;
  topicTitle: string;
  keywords: string;
  heading: string;
  fieldNames: string;
  body: string;
}

export interface HelpIndex {
  entries: Entry[];
}

export function buildIndex(topics: HelpTopic[]): HelpIndex {
  const entries: Entry[] = [];
  for (const topic of topics) {
    const topicTitle = topic.title.toLowerCase();
    const keywords = [topic.group, ...(topic.keywords ?? [])].join(" ").toLowerCase();
    entries.push({
      topic,
      topicTitle,
      keywords,
      heading: "",
      fieldNames: "",
      body: plain(topic.summary).toLowerCase(),
    });
    for (const s of topic.sections) {
      entries.push({
        topic,
        sectionId: s.id,
        sectionTitle: s.title,
        topicTitle,
        keywords,
        heading: s.title.toLowerCase(),
        fieldNames: s.blocks
          .flatMap((b) => (b.kind === "fields" ? b.fields.map((f) => f.name) : []))
          .join(" | ")
          .toLowerCase(),
        body: s.blocks.map(blockText).join(" ").toLowerCase(),
      });
    }
  }
  return { entries };
}

export interface HelpHit {
  topic: HelpTopic;
  sectionId?: string;
  sectionTitle?: string;
  score: number;
  snippet: string;
}

const wordStart = (hay: string, t: string) => {
  let i = hay.indexOf(t);
  while (i >= 0) {
    if (i === 0 || !/[\p{L}\p{N}]/u.test(hay[i - 1]!)) return true;
    i = hay.indexOf(t, i + 1);
  }
  return false;
};

function snippetOf(body: string, original: string, toks: string[]): string {
  const at = toks.map((t) => body.indexOf(t)).filter((i) => i >= 0);
  const first = at.length ? Math.min(...at) : 0;
  const from = Math.max(0, first - 70);
  const to = Math.min(original.length, first + 150);
  return `${from > 0 ? "…" : ""}${original.slice(from, to).trim()}${to < original.length ? "…" : ""}`;
}

/**
 * Every section (and topic summary) that holds all query words, best first. A word matches the start
 * of a word in the text ("rat" finds "rates"); titles, search keywords and field names weigh most.
 */
export function search(index: HelpIndex, query: string, limit = 60): HelpHit[] {
  const toks = tokens(query);
  if (!toks.length) return [];
  const phrase = toks.join(" ");
  const hits: HelpHit[] = [];
  for (const e of index.entries) {
    let score = 0;
    let all = true;
    for (const t of toks) {
      let s = 0;
      if (wordStart(e.topicTitle, t)) s += e.sectionId ? 12 : 30;
      if (wordStart(e.heading, t)) s += 16;
      if (wordStart(e.fieldNames, t)) s += 14;
      if (wordStart(e.keywords, t)) s += e.sectionId ? 4 : 18;
      if (wordStart(e.body, t)) s += 4;
      if (!s) {
        all = false;
        break;
      }
      score += s;
    }
    if (!all) continue;
    if (toks.length > 1) {
      if (e.topicTitle.includes(phrase)) score += 40;
      if (e.heading.includes(phrase) || e.fieldNames.includes(phrase)) score += 25;
      if (e.body.includes(phrase)) score += 10;
    }
    if (e.topicTitle === phrase && !e.sectionId) score += 60;
    const original = e.sectionId
      ? e.topic.sections
          .find((s) => s.id === e.sectionId)!
          .blocks.map(blockText)
          .join(" ")
      : plain(e.topic.summary);
    hits.push({
      topic: e.topic,
      sectionId: e.sectionId,
      sectionTitle: e.sectionTitle,
      score,
      snippet: snippetOf(e.body, original, toks),
    });
  }
  hits.sort((a, b) => b.score - a.score || a.topic.title.localeCompare(b.topic.title));
  return hits.slice(0, limit);
}
