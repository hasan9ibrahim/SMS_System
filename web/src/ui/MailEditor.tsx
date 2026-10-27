// E-mail design editor (§11, team trial round 1): Visual (what you see is the e-mail) or HTML (the full
// source, for designs made elsewhere). The visual editor is a sandboxed frame in design mode: template
// scripts never run, and the template's own <style> stays out of the app. Toolbar output is inline
// styles and tables, which is what Outlook and Gmail keep.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EmailAsset, EmailPlaceholder } from "@sms/contract";
import { useEmailAssets, useUploadEmailAsset } from "../api/admin";
import { problemText } from "../pages/routing/dialogs";
import { toBase64 } from "../pages/switch/tools/toolsModel";
import { toast } from "./feedback";
import {
  FONT_SIZES,
  SAFE_FONTS,
  WEB_FONTS,
  buttonHtml,
  dividerHtml,
  hasLayout,
  imageHtml,
  isHtml,
  plainToHtml,
  tableHtml,
  withFontLink,
  withLayout,
} from "./mailModel";

type Mode = "visual" | "html";

const EDITOR_CSS = `<style data-mail-editor="1">
  html, body { margin: 0; }
  body { padding: 12px; min-height: 260px; font: 14px/1.5 Arial, Helvetica, sans-serif; color: #1f2937; background: #ffffff; }
  body:focus { outline: none; }
  td, th { outline: 1px dashed rgba(100, 116, 139, 0.35); outline-offset: -1px; }
  img { cursor: default; }
  img.mail-selected { outline: 2px solid #2563eb; }
</style>`;

/** The editable document: the template itself, or a fragment in a body. */
function frameDoc(value: string) {
  const html = value.trim() === "" ? "<p><br></p>" : isHtml(value) ? value : plainToHtml(value);
  if (/<html[\s>]/i.test(html))
    return /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${EDITOR_CSS}`) : html;
  return `<!doctype html><html><head><meta charset="utf-8">${EDITOR_CSS}</head><body>${html}</body></html>`;
}

/** The template back from the frame: the whole document when it was one, else the body. */
function serialize(doc: Document, wasDocument: boolean) {
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[data-mail-editor]").forEach((n) => n.remove());
  clone.querySelectorAll(".mail-selected").forEach((n) => {
    n.classList.remove("mail-selected");
    if (!n.getAttribute("class")) n.removeAttribute("class");
  });
  clone.querySelector("body")?.removeAttribute("contenteditable");
  if (wasDocument) return `<!DOCTYPE html>\n${clone.outerHTML}`;
  return (clone.querySelector("body")?.innerHTML ?? "").trim();
}

function Tool({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  );
}

function ImagePicker({
  companyId,
  onPick,
  onClose,
}: {
  companyId: number | null;
  onPick: (a: { url: string; name: string; width: number; height: number }) => void;
  onClose: () => void;
}) {
  const assets = useEmailAssets(companyId);
  const upload = useUploadEmailAsset();
  const [url, setUrl] = useState("");
  const pickFile = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) return toast({ tone: "error", message: "The image must be at most 2 MB" });
    const contentBase64 = toBase64(new Uint8Array(await file.arrayBuffer()));
    upload.mutate(
      { name: file.name, contentBase64, businessCompanyId: companyId },
      { onSuccess: (a: EmailAsset) => onPick(a), onError: (e) => toast({ tone: "error", message: problemText(e) }) },
    );
  };
  return (
    <div className="mail-popover" role="dialog" aria-label="Insert image">
      <div className="mail-popover-head">
        <strong>Insert image</strong>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <label className="mail-upload">
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif"
          onChange={(e) => e.target.files?.[0] && void pickFile(e.target.files[0])}
        />
        {upload.isPending ? "Uploading…" : "Upload PNG, JPEG or GIF (up to 2 MB)"}
      </label>
      <div className="mail-assets">
        {(assets.data?.items ?? []).map((a) => (
          <button key={a.id} type="button" title={`${a.name} · ${a.width}×${a.height}`} onClick={() => onPick(a)}>
            <img src={a.url} alt={a.name} />
          </button>
        ))}
        {assets.data && !assets.data.items.length && <span className="muted small">No images uploaded yet.</span>}
      </div>
      <div className="mail-url">
        <input
          type="url"
          placeholder="…or an image address (https://)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          type="button"
          disabled={!/^https:\/\//i.test(url)}
          onClick={() => onPick({ url, name: "", width: 600, height: 300 })}
        >
          Insert
        </button>
      </div>
    </div>
  );
}

export interface MailEditorProps {
  value: string;
  onChange: (html: string) => void;
  /** Placeholder chips that insert {key} at the caret. */
  placeholders?: EmailPlaceholder[];
  /** Images are uploaded for this business company (null = shared). */
  businessCompanyId?: number | null;
  label?: string;
}

export function MailEditor({ value, onChange, placeholders = [], businessCompanyId = null, label }: MailEditorProps) {
  const [mode, setMode] = useState<Mode>("visual");
  const frame = useRef<HTMLIFrameElement>(null);
  const source = useRef<HTMLTextAreaElement>(null);
  const emitted = useRef<string | null>(null);
  const wasDocument = useRef(/<html[\s>]/i.test(value));
  const [picker, setPicker] = useState(false);
  const [color, setColor] = useState("#1f2937");
  const [fill, setFill] = useState("#fff3c4");
  const [cellColor, setCellColor] = useState("#eff6ff");
  const savedRange = useRef<Range | null>(null);

  const changed = useRef(onChange);
  changed.current = onChange;
  const doc = () => frame.current?.contentDocument ?? null;
  const emit = () => {
    const d = doc();
    if (!d) return;
    const html = serialize(d, wasDocument.current);
    emitted.current = html;
    changed.current(html);
  };

  // Loads the template into the frame when it changes from outside (HTML mode, a placeholder, a reset).
  useEffect(() => {
    if (mode !== "visual" || value === emitted.current) return;
    const f = frame.current;
    if (!f) return;
    const load = () => {
      const d = f.contentDocument;
      if (!d) return;
      wasDocument.current = /<html[\s>]/i.test(value);
      d.open();
      d.write(frameDoc(value));
      d.close();
      d.designMode = "on";
      try {
        d.execCommand("styleWithCSS", false, "true");
        d.execCommand("defaultParagraphSeparator", false, "p");
      } catch {
        /* older engines */
      }
      d.addEventListener("input", emit);
      d.addEventListener("keydown", (e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          d.execCommand(e.shiftKey ? "outdent" : "indent");
        }
      });
      d.addEventListener("click", (e) => {
        d.querySelectorAll(".mail-selected").forEach((n) => n.classList.remove("mail-selected"));
        if (e.target instanceof d.defaultView!.HTMLImageElement) e.target.classList.add("mail-selected");
      });
      emitted.current = value;
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, mode]);

  const keepSelection = () => {
    const sel = doc()?.getSelection();
    savedRange.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  };
  const restoreSelection = () => {
    const d = doc();
    const sel = d?.getSelection();
    if (d && sel && savedRange.current) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
    frame.current?.contentWindow?.focus();
  };
  const run = (cmd: string, arg?: string) => {
    const d = doc();
    if (!d) return;
    restoreSelection();
    d.execCommand(cmd, false, arg);
    emit();
  };
  const insert = (html: string) => run("insertHTML", html);

  const setFont = (stack: string) => {
    if (!stack) return;
    run("fontName", stack);
    const web = WEB_FONTS.find((f) => f.stack === stack);
    if (web?.google) {
      const html = withFontLink(serialize(doc()!, wasDocument.current), web.google);
      emitted.current = null;
      onChange(html);
    }
  };
  const setSize = (px: string) => {
    const d = doc();
    if (!d || !px) return;
    restoreSelection();
    d.execCommand("fontSize", false, "7");
    d.querySelectorAll<HTMLElement>('font[size="7"], span[style*="xxx-large"]').forEach((el) => {
      if (el.tagName === "FONT") {
        const span = d.createElement("span");
        span.style.fontSize = `${px}px`;
        span.innerHTML = el.innerHTML;
        el.replaceWith(span);
      } else el.style.fontSize = `${px}px`;
    });
    emit();
  };
  /** Background of the table cell (or block) the caret is in: sections, buttons, highlights. */
  const setBlockColor = (c: string) => {
    const d = doc();
    restoreSelection();
    let n: Node | null | undefined = d?.getSelection()?.anchorNode;
    while (n && !(n instanceof d!.defaultView!.HTMLElement && /^(TD|TH|DIV|P|H1|H2|H3)$/.test(n.tagName)))
      n = n.parentNode;
    if (!n || !(n instanceof d!.defaultView!.HTMLElement))
      return toast({ tone: "info", message: "Put the cursor in a table cell or paragraph first" });
    n.style.backgroundColor = c;
    if (n.tagName === "TD" || n.tagName === "TH") n.setAttribute("bgcolor", c);
    emit();
  };
  const addLink = () => {
    const href = window.prompt("Link address (https://… or mailto:…)", "https://");
    if (href && /^(https?:|mailto:|tel:|\{)/i.test(href)) run("createLink", href);
  };
  const addButton = () => {
    const text = window.prompt("Button text", "View invoice");
    if (!text) return;
    const href = window.prompt("Button link (https://… or a {placeholder})", "https://");
    if (!href) return;
    insert(buttonHtml(text, href, cellColor === "#eff6ff" ? "#2563eb" : cellColor, "#ffffff"));
  };
  const addTable = () => {
    const spec = window.prompt("Rows × columns", "2 × 2");
    const m = /(\d+)\D+(\d+)/.exec(spec ?? "");
    if (m) insert(tableHtml(Math.min(30, Number(m[1])), Math.min(8, Number(m[2]))));
  };
  const layout = () => {
    const page = window.prompt("Page background colour", "#f3f4f6");
    if (!page) return;
    const card = window.prompt("Content (card) background colour", "#ffffff") ?? "#ffffff";
    const html = withLayout(value && isHtml(value) ? value : plainToHtml(value), page, card);
    emitted.current = null;
    onChange(html);
  };
  const imageWidth = () => {
    const img = doc()?.querySelector<HTMLImageElement>("img.mail-selected");
    if (!img) return toast({ tone: "info", message: "Click an image first" });
    const w = Number(window.prompt("Image width in pixels", img.getAttribute("width") ?? String(img.naturalWidth)));
    if (!w || w < 1) return;
    const ratio = img.naturalWidth ? img.naturalHeight / img.naturalWidth : 0;
    img.setAttribute("width", String(Math.round(w)));
    if (ratio) img.setAttribute("height", String(Math.round(w * ratio)));
    img.style.width = `${Math.round(w)}px`;
    img.style.height = "auto";
    emit();
  };
  const imageAlign = (how: "left" | "center" | "right") => {
    const img = doc()?.querySelector<HTMLImageElement>("img.mail-selected");
    if (!img) return toast({ tone: "info", message: "Click an image first" });
    img.style.display = "block";
    img.style.marginLeft = how === "left" ? "0" : "auto";
    img.style.marginRight = how === "right" ? "0" : "auto";
    img.setAttribute("align", how === "center" ? "middle" : how);
    if (how === "center") img.removeAttribute("align");
    emit();
  };
  const insertPlaceholder = (key: string) => {
    const token = `{${key}}`;
    if (mode === "visual") return run("insertText", token);
    const el = source.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const importFile = async (file: File) => {
    const text = await file.text();
    emitted.current = null;
    onChange(text);
  };

  return (
    <div className="mail-editor">
      <div className="mail-editor-head">
        {label && <span className="ff-label">{label}</span>}
        <div className="segmented small" role="tablist" aria-label="Editor mode">
          {(["visual", "html"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? "on" : ""}
              onClick={() => {
                if (m === "visual") emitted.current = null;
                setMode(m);
              }}
            >
              {m === "visual" ? "Visual" : "HTML"}
            </button>
          ))}
        </div>
        <label className="link small mail-import" title="Use a design made in another tool (an .html file)">
          <input
            type="file"
            accept=".html,.htm,text/html"
            onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])}
          />
          Import HTML file
        </label>
      </div>
      {mode === "visual" && (
        <div className="mail-toolbar" role="toolbar" aria-label="Formatting" onMouseDown={keepSelection}>
          <select
            title="Paragraph style"
            defaultValue=""
            onChange={(e) => (run("formatBlock", e.target.value), (e.target.value = ""))}
          >
            <option value="" disabled>
              Style
            </option>
            <option value="p">Paragraph</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            <option value="h3">Heading 3</option>
            <option value="blockquote">Quote</option>
          </select>
          <select title="Font" defaultValue="" onChange={(e) => (setFont(e.target.value), (e.target.value = ""))}>
            <option value="" disabled>
              Font
            </option>
            <optgroup label="Every mail app">
              {SAFE_FONTS.map((f) => (
                <option key={f.label} value={f.stack}>
                  {f.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Web fonts (fallback in classic Outlook)">
              {WEB_FONTS.map((f) => (
                <option key={f.label} value={f.stack}>
                  {f.label}
                </option>
              ))}
            </optgroup>
          </select>
          <select title="Size" defaultValue="" onChange={(e) => (setSize(e.target.value), (e.target.value = ""))}>
            <option value="" disabled>
              Size
            </option>
            {FONT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s} px
              </option>
            ))}
          </select>
          <span className="mail-sep" />
          <Tool title="Bold" onClick={() => run("bold")}>
            <b>B</b>
          </Tool>
          <Tool title="Italic" onClick={() => run("italic")}>
            <i>I</i>
          </Tool>
          <Tool title="Underline" onClick={() => run("underline")}>
            <u>U</u>
          </Tool>
          <Tool title="Strikethrough" onClick={() => run("strikeThrough")}>
            <s>S</s>
          </Tool>
          <label className="mail-color" title="Text colour">
            <span style={{ borderBottom: `3px solid ${color}` }}>A</span>
            <input
              type="color"
              value={color}
              onChange={(e) => (setColor(e.target.value), run("foreColor", e.target.value))}
            />
          </label>
          <label className="mail-color" title="Highlight">
            <span style={{ background: fill }}>ab</span>
            <input
              type="color"
              value={fill}
              onChange={(e) => (setFill(e.target.value), run("hiliteColor", e.target.value))}
            />
          </label>
          <label className="mail-color" title="Background of the cell or paragraph (sections, buttons)">
            <span style={{ background: cellColor, padding: "0 4px" }}>▦</span>
            <input
              type="color"
              value={cellColor}
              onChange={(e) => (setCellColor(e.target.value), setBlockColor(e.target.value))}
            />
          </label>
          <span className="mail-sep" />
          <Tool title="Align left" onClick={() => run("justifyLeft")}>
            ⯇
          </Tool>
          <Tool title="Centre" onClick={() => run("justifyCenter")}>
            ≡
          </Tool>
          <Tool title="Align right" onClick={() => run("justifyRight")}>
            ⯈
          </Tool>
          <Tool title="Bulleted list" onClick={() => run("insertUnorderedList")}>
            •
          </Tool>
          <Tool title="Numbered list" onClick={() => run("insertOrderedList")}>
            1.
          </Tool>
          <span className="mail-sep" />
          <Tool title="Link" onClick={addLink}>
            🔗
          </Tool>
          <Tool title="Remove link" onClick={() => run("unlink")}>
            ⛓̸
          </Tool>
          <Tool title="Image" onClick={() => setPicker((p) => !p)}>
            🖼
          </Tool>
          <Tool title="Image width (click an image first)" onClick={imageWidth}>
            ↔
          </Tool>
          <Tool title="Centre the image" onClick={() => imageAlign("center")}>
            ⧉
          </Tool>
          <Tool title="Button" onClick={addButton}>
            ▭
          </Tool>
          <Tool title="Table" onClick={addTable}>
            ▦
          </Tool>
          <Tool title="Divider" onClick={() => insert(dividerHtml)}>
            ―
          </Tool>
          <Tool
            title={
              hasLayout(value) ? "Change the page and card colours" : "E-mail layout: page background and a 600 px card"
            }
            onClick={layout}
          >
            ▣
          </Tool>
          <span className="mail-sep" />
          <Tool title="Clear formatting" onClick={() => run("removeFormat")}>
            ⌫
          </Tool>
          <Tool title="Undo" onClick={() => run("undo")}>
            ↶
          </Tool>
          <Tool title="Redo" onClick={() => run("redo")}>
            ↷
          </Tool>
        </div>
      )}
      {picker && mode === "visual" && (
        <ImagePicker
          companyId={businessCompanyId}
          onClose={() => setPicker(false)}
          onPick={(a) => {
            setPicker(false);
            insert(imageHtml(a.url, a.name.replace(/\.[a-z]+$/i, ""), a.width, a.height));
          }}
        />
      )}
      {mode === "visual" ? (
        <iframe ref={frame} className="mail-canvas" title="E-mail body (visual editor)" sandbox="allow-same-origin" />
      ) : (
        <textarea
          ref={source}
          className="tpl-body mail-source"
          rows={20}
          spellCheck={false}
          value={value}
          maxLength={500000}
          aria-label="E-mail HTML"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {placeholders.length > 0 && (
        <div className="tpl-chips" aria-label="Placeholders">
          {placeholders.map((p) => (
            <button
              key={p.key}
              type="button"
              className="chip"
              title={`${p.description} – e.g. ${p.sample}`}
              onMouseDown={(e) => {
                e.preventDefault();
                keepSelection();
              }}
              onClick={() => insertPlaceholder(p.key)}
            >
              {`{${p.key}}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
