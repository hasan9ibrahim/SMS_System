// Help center (§15.1 help): a guide to every page, what each field means and how things work, with
// search. Topics are static text; the URL keeps the open topic, section and search (?topic=&s=&q=).
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router";
import { HOME, PAGES } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import { usePageStatus, useTabNavigate, useTabTitle } from "../../shell/tabContext";
import { useOpener } from "../../shell/useOpener";
import { Icon } from "../../ui/Icon";
import { Button } from "../../ui/primitives";
import { GROUPS, TOPICS, TOPIC_BY_ID } from "./content";
import type { HelpBlock, HelpFigure, HelpTopic } from "./helpTypes";
import { buildIndex, search, tokens } from "./search";

const PAGE = PAGES.find((p) => p.key === "help")!;
const INDEX = buildIndex(TOPICS);
const pageOf = (key: string) => (key === "home" ? HOME : PAGES.find((p) => p.key === key));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Search words marked in plain text. */
function Marked({ text, hl }: { text: string; hl: RegExp | null }) {
  if (!hl) return <>{text}</>;
  const parts = text.split(hl);
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>))}</>;
}

/** **bold**, `code` and [[topic#section|label]] links. */
function Inline({ text, hl, go }: { text: string; hl: RegExp | null; go: (topic: string, s?: string) => void }) {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(<Marked key={last} text={text.slice(last, m.index)} hl={hl} />);
    const k = m.index!;
    if (m[1] !== undefined)
      out.push(
        <strong key={k}>
          <Marked text={m[1]} hl={hl} />
        </strong>,
      );
    else if (m[2] !== undefined) out.push(<code key={k}>{m[2]}</code>);
    else {
      const [topicId, sectionId] = m[3]!.split("#");
      const target = TOPIC_BY_ID.get(topicId!);
      const label = m[4] ?? target?.title ?? topicId!;
      out.push(
        target ? (
          <a
            key={k}
            href={`/help?topic=${topicId}`}
            onClick={(e) => {
              e.preventDefault();
              go(topicId!, sectionId);
            }}
          >
            {label}
          </a>
        ) : (
          <span key={k}>{label}</span>
        ),
      );
    }
    last = k + m[0].length;
  }
  if (last < text.length) out.push(<Marked key={last} text={text.slice(last)} hl={hl} />);
  return <>{out}</>;
}

/**
 * A help picture with numbered arrows (team trial round 6): each bubble points at its spot, and the legend under the
 * picture says what it is. Hovering a number in either place lights up both; clicking the picture opens it full size.
 */
function Figure({ f, hl, go }: { f: HelpFigure; hl: RegExp | null; go: (topic: string, s?: string) => void }) {
  const [on, setOn] = useState<number | null>(null);
  const [big, setBig] = useState(false);
  const pic = (large: boolean) => (
    <div className={`help-fig-pic${large ? " large" : ""}`}>
      <img src={f.src} alt={f.alt} width={f.width} height={f.height} loading="lazy" />
      <svg viewBox={`0 0 ${f.width} ${f.height}`} aria-hidden="true">
        <defs>
          <marker id="help-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0L10 5L0 10z" />
          </marker>
        </defs>
        {f.marks.map((m, i) => {
          const [x, y, bx, by] = [m.x, m.y, m.bx, m.by].map((v, k) => (v / 100) * (k % 2 ? f.height : f.width));
          // The arrow starts at the bubble's edge and stops just short of the spot.
          const len = Math.hypot(x! - bx!, y! - by!) || 1;
          const [ux, uy] = [(x! - bx!) / len, (y! - by!) / len];
          return (
            <g key={i} className={on === i ? "on" : ""} onMouseEnter={() => setOn(i)} onMouseLeave={() => setOn(null)}>
              <line x1={bx! + ux * 15} y1={by! + uy * 15} x2={x! - ux * 4} y2={y! - uy * 4} markerEnd="url(#help-arrow)" />
              <circle cx={x} cy={y} r="5" className="help-fig-spot" />
              <circle cx={bx} cy={by} r="14" />
              <text x={bx} y={by! + 5} textAnchor="middle">
                {i + 1}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
  return (
    <figure className="help-fig">
      <button type="button" className="help-fig-open" title="Open full size" onClick={() => setBig(true)}>
        {pic(false)}
      </button>
      <ol className="help-fig-legend">
        {f.marks.map((m, i) => (
          <li key={i} className={on === i ? "on" : ""} onMouseEnter={() => setOn(i)} onMouseLeave={() => setOn(null)}>
            <span className="help-fig-num">{i + 1}</span>
            <span>
              <strong>{m.label}</strong> <Inline text={m.text} hl={hl} go={go} />
            </span>
          </li>
        ))}
      </ol>
      {big &&
        createPortal(
          <div className="help-fig-zoom" role="dialog" aria-label={f.alt} onClick={() => setBig(false)}>
            {pic(true)}
          </div>,
          document.body,
        )}
    </figure>
  );
}

function Block({ b, hl, go }: { b: HelpBlock; hl: RegExp | null; go: (topic: string, s?: string) => void }) {
  const I = (t: string) => <Inline text={t} hl={hl} go={go} />;
  switch (b.kind) {
    case "text":
      return <p>{I(b.text)}</p>;
    case "tip":
      return (
        <div className="help-note tip">
          <strong>Tip</strong>
          <span>{I(b.text)}</span>
        </div>
      );
    case "warning":
      return (
        <div className="help-note warn">
          <Icon name="alert" size={14} />
          <span>{I(b.text)}</span>
        </div>
      );
    case "steps":
    case "list": {
      const items = b.items.map((it, i) => <li key={i}>{I(it)}</li>);
      return (
        <>
          {b.title && <h4>{b.title}</h4>}
          {b.kind === "steps" ? <ol className="help-steps">{items}</ol> : <ul>{items}</ul>}
        </>
      );
    }
    case "fields": {
      // Column lists have nothing to enter: drop the third column when no row fills it.
      const withValues = b.fields.some((f) => f.values);
      return (
        <>
          {b.title && <h4>{b.title}</h4>}
          <table className={`help-fields${withValues ? "" : " two"}`}>
            <thead>
              <tr>
                <th>{withValues ? "Field" : "Name"}</th>
                <th>What it does</th>
                {withValues && <th>What to enter</th>}
              </tr>
            </thead>
            <tbody>
              {b.fields.map((f, i) => (
                <tr key={i}>
                  <td className="help-field-name">
                    <Marked text={f.name} hl={hl} />
                  </td>
                  <td>{I(f.what)}</td>
                  {withValues && <td>{f.values ? I(f.values) : <span className="muted">—</span>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      );
    }
    case "figure":
      return <Figure f={b.figure} hl={hl} go={go} />;
  }
}

function TopicView({
  topic,
  hl,
  go,
  backToResults,
}: {
  topic: HelpTopic;
  hl: RegExp | null;
  go: (topic: string, s?: string) => void;
  backToResults?: () => void;
}) {
  const open = useOpener();
  const page = topic.pageKey ? pageOf(topic.pageKey) : undefined;
  return (
    <article className="help-article">
      {backToResults && (
        <button type="button" className="help-back" onClick={backToResults}>
          <Icon name="arrowLeft" size={13} /> Back to search results
        </button>
      )}
      <div className="help-crumb muted small">{topic.group}</div>
      <div className="help-title-row">
        <h2>{topic.title}</h2>
        {page && (
          <Button icon="external" small onClick={() => open(page.path, { ctrlKey: true })}>
            Open {page.label}
          </Button>
        )}
      </div>
      <p className="help-summary">
        <Inline text={topic.summary} hl={hl} go={go} />
      </p>
      {topic.sections.length > 2 && (
        <nav className="help-toc" aria-label="On this page">
          <span className="muted small">On this page</span>
          {topic.sections.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                go(topic.id, s.id);
              }}
            >
              {s.title}
            </a>
          ))}
        </nav>
      )}
      {topic.sections.map((s) => (
        <section key={s.id} data-help-section={s.id} className="help-section">
          <h3>
            <Marked text={s.title} hl={hl} />
          </h3>
          {s.blocks.map((b, i) => (
            <Block key={i} b={b} hl={hl} go={go} />
          ))}
        </section>
      ))}
    </article>
  );
}

function Welcome({ go }: { go: (topic: string, s?: string) => void }) {
  return (
    <article className="help-article">
      <h2>Help center</h2>
      <p className="help-summary">
        A guide to every page of the platform: what it is for, what each column and field means, what to enter, and
        step-by-step how to do common jobs. Search above, or pick a topic. New here? Start with{" "}
        <a
          href="/help?topic=getting-started"
          onClick={(e) => {
            e.preventDefault();
            go("getting-started");
          }}
        >
          Getting started
        </a>
        . On any page, the <Icon name="help" size={13} /> button next to the title opens that page's help.
      </p>
      <div className="help-cards">
        {GROUPS.map((g) => {
          const list = TOPICS.filter((t) => t.group === g);
          if (!list.length) return null;
          return (
            <div key={g} className="help-card">
              <h3>{g}</h3>
              <ul>
                {list.map((t) => (
                  <li key={t.id}>
                    <a
                      href={`/help?topic=${t.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        go(t.id);
                      }}
                    >
                      {t.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </article>
  );
}

export function HelpPage() {
  const location = useLocation();
  const navigate = useTabNavigate();
  const params = new URLSearchParams(location.search);
  const topicId = params.get("topic") ?? "";
  const sectionId = params.get("s") ?? "";
  const q = params.get("q") ?? "";
  const topic = topicId ? TOPIC_BY_ID.get(topicId) : undefined;
  const [text, setText] = useState(q);
  const mainRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useTabTitle(topic ? `Help · ${topic.title}` : PAGE.label);
  usePageStatus({ rows: `${TOPICS.length} help topics`, shortcuts: "/ search" });

  const setUrl = (next: { topic?: string; s?: string; q?: string }, replace = false) => {
    const p = new URLSearchParams();
    if (next.topic) p.set("topic", next.topic);
    if (next.s) p.set("s", next.s);
    if (next.q) p.set("q", next.q);
    navigate(`/help${p.size ? `?${p}` : ""}`, { replace });
  };
  const go = (t: string, s?: string) => setUrl({ topic: t, s, q: t === topicId ? q : "" });

  // Typing searches as you go (the URL keeps the words, so Back returns to the results).
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    if (text === q) return;
    const id = setTimeout(() => setUrl({ q: text.trim() ? text : "" }, true), 180);
    return () => clearTimeout(id);
  }, [text]);

  const hits = useMemo(() => (q && !topic ? search(INDEX, q) : []), [q, topic]);
  const hl = useMemo(() => {
    const toks = tokens(q);
    return toks.length ? new RegExp(`(${toks.map(escapeRe).join("|")})`, "gi") : null;
  }, [q]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const el = sectionId ? main.querySelector<HTMLElement>(`[data-help-section="${CSS.escape(sectionId)}"]`) : null;
    if (el) el.scrollIntoView({ block: "start" });
    else main.scrollTop = 0;
  }, [topicId, sectionId, q]);

  useEffect(() => {
    mainRef.current?.parentElement
      ?.querySelector<HTMLElement>(".help-contents .help-link.current")
      ?.scrollIntoView({ block: "nearest" });
  }, [topicId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || !mainRef.current?.offsetParent) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Results grouped by topic, best topic first.
  const grouped = useMemo(() => {
    const m = new Map<string, typeof hits>();
    for (const h of hits) m.set(h.topic.id, [...(m.get(h.topic.id) ?? []), h]);
    return [...m.values()];
  }, [hits]);

  return (
    <div className="page help-page">
      <PageHeader page={PAGE} />
      <div className="help-body">
        <aside className="help-nav">
          <div className="help-search">
            <Icon name="search" size={14} />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search help (press /)"
              aria-label="Search help"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setUrl({ q: text.trim() ? text : "" }, true);
                if (e.key === "Escape") {
                  setText("");
                  setUrl({ topic: topicId, s: sectionId }, true);
                }
              }}
            />
          </div>
          <nav className="help-contents" aria-label="Help contents">
            <button type="button" className={`help-link${!topic && !q ? " current" : ""}`} onClick={() => setUrl({})}>
              <Icon name="home" size={13} /> Help home
            </button>
            {GROUPS.map((g) => {
              const list = TOPICS.filter((t) => t.group === g);
              if (!list.length) return null;
              const shut = collapsed.has(g) && topic?.group !== g;
              return (
                <div key={g} className="help-group">
                  <button
                    type="button"
                    className="help-group-head"
                    aria-expanded={!shut}
                    onClick={() =>
                      setCollapsed((c) => {
                        const n = new Set(c);
                        if (n.has(g)) n.delete(g);
                        else n.add(g);
                        return n;
                      })
                    }
                  >
                    <Icon name={shut ? "chevronRight" : "chevronDown"} size={12} />
                    {g}
                  </button>
                  {!shut &&
                    list.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={`help-link${t.id === topicId ? " current" : ""}`}
                        aria-current={t.id === topicId ? "page" : undefined}
                        onClick={() => setUrl({ topic: t.id })}
                      >
                        {t.title}
                      </button>
                    ))}
                </div>
              );
            })}
          </nav>
        </aside>
        <div className="help-main" ref={mainRef}>
          {topic ? (
            <TopicView topic={topic} hl={hl} go={go} backToResults={q ? () => setUrl({ q }) : undefined} />
          ) : q ? (
            <div className="help-article">
              <h2>{hits.length ? `Results for “${q}”` : `Nothing found for “${q}”`}</h2>
              {!hits.length && (
                <p className="muted">
                  Try fewer or different words, e.g. a field name, a button label or an abbreviation (TPS, DLR, RN).
                </p>
              )}
              {grouped.map((list) => {
                const t = list[0]!.topic;
                return (
                  <div key={t.id} className="help-hit-group">
                    <div className="help-hit-topic">
                      <span className="muted small">{t.group} ›</span>{" "}
                      <a
                        href={`/help?topic=${t.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          setUrl({ topic: t.id, q });
                        }}
                      >
                        <Marked text={t.title} hl={hl} />
                      </a>
                    </div>
                    {list.slice(0, 4).map((h) => (
                      <button
                        key={h.sectionId ?? "_"}
                        type="button"
                        className="help-hit"
                        onClick={() => setUrl({ topic: t.id, s: h.sectionId, q })}
                      >
                        <span className="help-hit-title">
                          <Marked text={h.sectionTitle ?? "Overview"} hl={hl} />
                        </span>
                        <span className="help-hit-snippet">
                          <Marked text={h.snippet} hl={hl} />
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : topicId ? (
            <div className="help-article">
              <h2>Topic not found</h2>
              <p className="muted">There is no help topic “{topicId}” yet. Try searching for it.</p>
            </div>
          ) : (
            <Welcome go={go} />
          )}
        </div>
      </div>
    </div>
  );
}
