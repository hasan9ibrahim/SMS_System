// E-mail templates as full designs (§11, team trial round 1): one pipeline from a template to the e-mail
// that is sent, plus how classic Outlook for Windows will show it.
//
//   template ──sanitise──▶ saved body ──fill placeholders──▶ body ──emailDocument──▶ e-mail as sent
//                                                                         │
//                                       outlookView (approximation) ◀─────┤
//                                       compatIssues (warnings)     ◀─────┘
//
// The e-mail as sent has its CSS inlined (Outlook and Gmail drop most <style> rules), an Outlook head
// (96 DPI, web-font fallback) and width attributes on images. Uploaded images stay as urls here so the
// system can show the e-mail; the sender embeds them inline (cid) — see embedImages.
import juice from "juice";
import * as cheerio from "cheerio";
import type { EmailClient, EmailCompatIssue } from "@sms/contract";

export const isHtml = (s: string) => /<[a-z][a-z0-9]*[\s/>]/i.test(s);
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const textToHtml = (s: string) => escapeHtml(s).replace(/\r?\n/g, "<br>");

/** Fonts every mail app has (Windows and Mac). Anything else is a web font: classic Outlook replaces it. */
export const SAFE_FONTS = new Set(
  [
    "arial",
    "helvetica",
    "helvetica neue",
    "verdana",
    "tahoma",
    "trebuchet ms",
    "georgia",
    "times new roman",
    "times",
    "courier new",
    "courier",
    "segoe ui",
    "calibri",
    "cambria",
    "candara",
    "garamond",
    "lucida sans unicode",
    "lucida grande",
    "palatino linotype",
    "book antiqua",
    "impact",
    "consolas",
    "sans-serif",
    "serif",
    "monospace",
    "system-ui",
    "-apple-system",
    "blinkmacsystemfont",
  ].map((f) => f.toLowerCase()),
);
const families = (stack: string) =>
  stack
    .split(",")
    .map((f) => f.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
const isSafe = (family: string) => SAFE_FONTS.has(family.toLowerCase());

// ---------------------------------------------------------------- sanitise (on save and before sending)

const DROP_TAGS = "script,iframe,frame,frameset,object,embed,applet,form,input,button,select,textarea,base,audio,video";
const URL_ATTRS = ["href", "src", "background", "action", "formaction", "xlink:href", "poster"];
const loadAny = (html: string) => {
  const doc = /<html[\s>]/i.test(html);
  return { $: doc ? cheerio.load(html) : cheerio.load(html, null, false), doc };
};

/**
 * Removes what must never be in a template: scripts, frames, forms, event handlers, javascript: urls,
 * CSS expressions and external stylesheets other than Google Fonts. Keeps every design feature (inline
 * styles, <style> blocks, tables, images, fonts) and Outlook conditional comments.
 */
export function sanitizeHtml(html: string): string {
  if (!isHtml(html)) return html;
  const { $ } = loadAny(html);
  $(DROP_TAGS).remove();
  $('meta[http-equiv="refresh" i]').remove();
  $("link").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!/^https:\/\/fonts\.googleapis\.com\//i.test(href)) $(el).remove();
  });
  $("*").each((_, el) => {
    if (el.type !== "tag") return;
    for (const name of Object.keys(el.attribs)) {
      const value = el.attribs[name] ?? "";
      if (/^on/i.test(name)) $(el).removeAttr(name);
      else if (URL_ATTRS.includes(name.toLowerCase()) && /^\s*(javascript|vbscript|data:text)/i.test(value))
        $(el).removeAttr(name);
      else if (name.toLowerCase() === "style" && /expression\s*\(|javascript:|behaviou?r\s*:|-moz-binding/i.test(value))
        $(el).removeAttr(name);
    }
  });
  $("style").each((_, el) => {
    const css = $(el).html() ?? "";
    if (/expression\s*\(|javascript:|behaviou?r\s*:|-moz-binding|@import/i.test(css))
      $(el).text(
        css.replace(/@import[^;]+;/gi, "").replace(/expression\s*\(|javascript:|behaviou?r\s*:|-moz-binding/gi, ""),
      );
  });
  return $.html();
}

// ---------------------------------------------------------------- placeholders

/** Placeholders whose value is HTML already (the company logo), and ones shown as fixed-width text. */
const RAW_KEYS = new Set(["company_logo"]);
const PRE_KEYS = new Set(["edrs", "summary", "trunks"]);

/**
 * Fills {placeholders}. In an HTML body values are escaped and line breaks kept (<br>), so a value can
 * never break the design; a plain-text body gets the values as they are. Unknown keys stay as written.
 */
export function fillBody(template: string, vars: Record<string, string>, unknown?: Set<string>): string {
  const html = isHtml(template);
  return template.replace(/\{([a-z_]+)\}/g, (m, key: string) => {
    const v = vars[key];
    if (v == null) {
      unknown?.add(key);
      return m;
    }
    if (!html) return RAW_KEYS.has(key) ? "" : v;
    if (RAW_KEYS.has(key)) return v;
    if (PRE_KEYS.has(key))
      return `<pre style="font-family:Consolas,'Courier New',monospace;font-size:12px;line-height:1.4;margin:0">${escapeHtml(v)}</pre>`;
    return textToHtml(v);
  });
}

/** Text placeholders only (subjects). */
export const fillText = (template: string, vars: Record<string, string>, unknown?: Set<string>) =>
  template.replace(/\{([a-z_]+)\}/g, (m, key: string) => {
    const v = vars[key];
    if (v == null) unknown?.add(key);
    return v == null || RAW_KEYS.has(key) ? (v == null ? m : "") : v.replace(/\s*\n\s*/g, " ");
  });

/** Adds generated text (lines, figures) under a body, in the body's own format. */
export const appendText = (body: string, text: string) =>
  isHtml(body)
    ? `${body}\n<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${textToHtml(text)}</p>`
    : `${body}\n\n${text}`;

/** The company logo placeholder: an image at 48 px high with its width, so Outlook sizes it right. */
export function logoTag(src: string, alt: string, width: number, height: number) {
  const h = Math.min(48, height);
  const w = Math.max(1, Math.round((width * h) / height));
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${w}" height="${h}" style="display:block;border:0;width:${w}px;height:${h}px">`;
}

// ---------------------------------------------------------------- the e-mail as sent

const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->`;
const PLAIN_STYLE = "font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937";

/** Every font-family stack used in inline styles. */
function fontStacks($: cheerio.CheerioAPI): string[] {
  const out: string[] = [];
  $("[style]").each((_, el) => {
    const m = /font-family\s*:\s*([^;]+)/i.exec($(el).attr("style") ?? "");
    if (m) out.push(m[1]!.replace(/!important/i, "").trim());
  });
  return out;
}

/**
 * The e-mail document as sent: plain text becomes simple HTML; a fragment gets a full document; CSS is
 * inlined (media queries, :hover and @font-face stay in <style>); images get width/height attributes and
 * border 0; web fonts get an Outlook fallback.
 */
export function emailDocument(body: string): string {
  let html = isHtml(body) ? sanitizeHtml(body) : textToHtml(body);
  // A fragment gets the editor's default font: without one, browsers and classic Outlook use Times New Roman,
  // and Outlook does not pass a font on into table cells, hence the Outlook-only rule.
  if (!/<html[\s>]/i.test(html))
    html = `<!DOCTYPE html><html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>${HEAD}<!--[if mso]><style>table, td, th, p, div, span, li { font-family: Arial, Helvetica, sans-serif; }</style><![endif]--></head><body style="margin:0;padding:0;word-spacing:normal"><div style="${PLAIN_STYLE}">${html}</div></body></html>`;
  else if (!/x-apple-disable-message-reformatting/i.test(html))
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${HEAD}`) : html;
  html = juice(html, {
    preserveMediaQueries: true,
    preserveFontFaces: true,
    preservePseudos: true,
    applyWidthAttributes: true,
    applyHeightAttributes: true,
    removeStyleTags: true,
    insertPreservedExtraCss: true,
  });
  const $ = cheerio.load(html);
  // Web-font stylesheets belong in the head (Apple Mail, iOS and new Outlook load them from there).
  $('body link[href^="https://fonts.googleapis.com/"]').each((_, el) => {
    $("head").append($(el).clone());
    $(el).remove();
  });
  $("img").each((_, el) => {
    const img = $(el);
    const style = img.attr("style") ?? "";
    for (const dim of ["width", "height"] as const) {
      const m = new RegExp(`(?:^|;)\\s*${dim}\\s*:\\s*(\\d+)px`, "i").exec(style);
      if (!img.attr(dim) && m) img.attr(dim, m[1]!);
    }
    if (img.attr("border") == null) img.attr("border", "0");
    if (img.attr("alt") == null) img.attr("alt", "");
  });
  // Classic Outlook shows Times New Roman for a web font: give it the template's own fallback instead.
  const web = fontStacks($).filter((s) => families(s)[0] && !isSafe(families(s)[0]!));
  if (web.length) {
    const fallback = web.flatMap(families).find(isSafe) ?? "Arial";
    const generic = /serif$/i.test(fallback) || fallback === "serif" ? "" : ", sans-serif";
    $("head").append(
      `<!--[if mso]><style>body, table, td, th, p, a, span, div, li, h1, h2, h3, h4, h5, h6 { font-family: ${/\s/.test(fallback) ? `'${fallback}'` : fallback}${generic} !important; }</style><![endif]-->`,
    );
  }
  return $.html();
}

/** An uploaded image or a company logo, as referenced by templates. */
const ASSET_SRC =
  /(?:https?:\/\/[^"'\s]+)?\/api\/v1\/(email-assets\/(\d+)\/file|business-companies\/(\d+)\/files\/logo)/;

/**
 * The document as the mail server sends it: uploaded images and company logos become inline parts
 * (cid), so the reader sees them without allowing remote content.
 */
export function embedImages(doc: string): {
  html: string;
  images: { cid: string; assetId: number | null; companyId: number | null }[];
} {
  const $ = cheerio.load(doc);
  const images: { cid: string; assetId: number | null; companyId: number | null }[] = [];
  $("img[src]").each((_, el) => {
    const m = ASSET_SRC.exec($(el).attr("src") ?? "");
    if (!m) return;
    const cid = m[2] ? `asset-${m[2]}@sms.local` : `logo-${m[3]}@sms.local`;
    if (!images.some((i) => i.cid === cid))
      images.push({ cid, assetId: m[2] ? Number(m[2]) : null, companyId: m[3] ? Number(m[3]) : null });
    $(el).attr("src", `cid:${cid}`);
  });
  return { html: $.html(), images };
}

// ---------------------------------------------------------------- classic Outlook for Windows

const DROP_PROPS =
  /^(border(-top|-bottom)?(-left|-right)?-radius|box-shadow|text-shadow|background-image|position|top|left|right|bottom|z-index|transform|transition|animation|opacity|max-width|min-width|max-height|min-height|object-fit|filter|backdrop-filter|overflow|gap|row-gap|column-gap|justify-content|align-items|align-content|align-self|flex|flex-[a-z-]+|grid|grid-[a-z-]+|order|clip-path|mix-blend-mode)$/i;
const COLOR =
  /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black|red|green|blue|gray|grey|silver|navy|teal|maroon|orange|yellow|purple|transparent)\b/i;

const parseStyle = (style: string) =>
  style
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(":");
      return i < 0 ? null : ([d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()] as [string, string]);
    })
    .filter((d): d is [string, string] => d !== null);

/** A web font replaced the way classic Outlook does: by the next installed font, else Times New Roman. */
export function outlookFont(stack: string): string {
  const list = families(stack.replace(/!important/i, ""));
  if (!list.length || isSafe(list[0]!)) return stack;
  const rest = list.filter(isSafe);
  return rest.length ? rest.map((f) => (/\s/.test(f) ? `'${f}'` : f)).join(", ") : "'Times New Roman', serif";
}

/**
 * An approximation of classic Outlook for Windows (Word engine): conditional comments for Outlook are
 * applied, the CSS it ignores is removed, web fonts fall back, images take their width attribute, and
 * SVG / data: images show as a broken-image box. Not pixel-exact — a test e-mail is the final check.
 */
export function outlookView(doc: string): string {
  const applied = doc
    .replace(/<!--\[if !mso\]><!-->[\s\S]*?<!--<!\[endif\]-->/gi, "")
    .replace(/<!--\[if [^\]]*mso[^\]]*\]>([\s\S]*?)<!\[endif\]-->/gi, (_, inner: string) =>
      /<xml>/i.test(inner) ? "" : inner,
    );
  const $ = cheerio.load(applied);
  $("style, link").remove();
  $("[background]").removeAttr("background");
  $("[style]").each((_, el) => {
    const tag = el.type === "tag" ? el.name.toLowerCase() : "";
    const out: string[] = [];
    for (const [prop, value] of parseStyle($(el).attr("style") ?? "")) {
      if (DROP_PROPS.test(prop)) continue;
      if ((tag === "div" || tag === "span") && /^(padding|margin)(-|$)/.test(prop)) continue;
      if (prop === "display" && /flex|grid/i.test(value)) {
        out.push("display: block");
        continue;
      }
      if (prop === "background") {
        const color = COLOR.exec(value);
        if (color) out.push(`background-color: ${color[0]}`);
        continue;
      }
      if (prop === "font-family") {
        out.push(`font-family: ${outlookFont(value)}`);
        continue;
      }
      out.push(`${prop}: ${value}`);
    }
    $(el).attr("style", out.join("; "));
  });
  $("img").each((_, el) => {
    const img = $(el);
    const src = img.attr("src") ?? "";
    if (/^data:|\.svg(\?|$)|\.webp(\?|$)/i.test(src)) {
      img.replaceWith(
        `<span style="display:inline-block;border:1px solid #c8c8c8;padding:4px 6px;color:#888;font:11px Arial,sans-serif">✕ ${escapeHtml(img.attr("alt") || "Picture can't be displayed")}</span>`,
      );
      return;
    }
    // Word sizes images by the width attribute only; without one the picture shows at its file size.
    const style = parseStyle(img.attr("style") ?? "").filter(([p]) => p !== "width" && p !== "height");
    const w = img.attr("width");
    const h = img.attr("height");
    if (w && /^\d+$/.test(w)) style.push(["width", `${w}px`]);
    if (h && /^\d+$/.test(h)) style.push(["height", `${h}px`]);
    img.attr("style", style.map(([p, v]) => `${p}: ${v}`).join("; "));
  });
  return $.html();
}

// ---------------------------------------------------------------- compatibility report

const OUTLOOK: EmailClient[] = ["outlook_windows"];

/**
 * What will look different, and where: classic Outlook for Windows first (it is the strictest), then
 * Gmail and phones. `template` is the body before inlining (for @media and <style> checks).
 */
export function compatIssues(doc: string, template: string): EmailCompatIssue[] {
  const $ = cheerio.load(doc);
  const issues = new Map<string, EmailCompatIssue>();
  const add = (feature: string, level: "warning" | "info", clients: EmailClient[], message: string) => {
    const was = issues.get(feature);
    if (was) was.count++;
    else issues.set(feature, { feature, level, clients, message, count: 1 });
  };
  const fonts = new Map<string, string>();
  $("[style]").each((_, el) => {
    const tag = el.type === "tag" ? el.name.toLowerCase() : "";
    const decls = parseStyle($(el).attr("style") ?? "");
    const has = (re: RegExp) => decls.some(([p, v]) => re.test(`${p}:${v}`));
    if (has(/^border(-[a-z]+)*-radius:\s*[1-9]/))
      add("border_radius", "info", OUTLOOK, "Rounded corners show square in classic Outlook for Windows.");
    if (has(/^(box|text)-shadow:(?!\s*none)/))
      add("shadow", "info", OUTLOOK, "Shadows are not shown in classic Outlook for Windows.");
    if (has(/^background(-image)?:.*url\(/)) {
      const color = decls.some(([p, v]) => p === "background-color" || (p === "background" && COLOR.test(v)));
      add(
        "background_image",
        color ? "info" : "warning",
        OUTLOOK,
        color
          ? "Background images are not shown in classic Outlook for Windows; the background colour shows instead."
          : "Background images are not shown in classic Outlook for Windows, and there is no background colour to fall back to.",
      );
    }
    if (has(/^display:\s*(inline-)?(flex|grid)/))
      add(
        "flex_grid",
        "warning",
        OUTLOOK,
        "Flex and grid layouts are not supported in classic Outlook for Windows: the parts stack. Use a table for columns.",
      );
    if (has(/^position:\s*(absolute|fixed|relative)/))
      add(
        "position",
        "warning",
        [...OUTLOOK, "gmail"],
        "Positioned elements (position: absolute / relative) are ignored by classic Outlook and Gmail.",
      );
    // A fixed width next to it (the usual width="600" + max-width:100%) is what Outlook uses; only flag it alone.
    const fixed = /^\d+$/.test($(el).attr("width") ?? "") || decls.some(([p, v]) => p === "width" && /^\d+px/.test(v));
    if (has(/^max-width:/) && tag !== "img" && !fixed)
      add(
        "max_width",
        "info",
        OUTLOOK,
        "max-width is ignored by classic Outlook for Windows: the block stretches. Give the main table a fixed width (e.g. 600).",
      );
    if ((tag === "div" || tag === "span") && has(/^(padding|margin)(-[a-z]+)?:\s*[1-9]/))
      add(
        "div_spacing",
        "info",
        OUTLOOK,
        "Padding and margin on <div> and <span> are ignored by classic Outlook for Windows; put spacing on table cells.",
      );
    const ff = decls.find(([p]) => p === "font-family");
    if (ff) {
      const first = families(ff[1])[0];
      if (first && !isSafe(first)) fonts.set(first, outlookFont(ff[1]));
    }
    const width = decls.find(([p]) => p === "width")?.[1];
    if (width && /^\d+px/.test(width) && parseInt(width, 10) > 700)
      add(
        "wide",
        "info",
        ["outlook_mobile", "gmail", "apple_mail"],
        "Content wider than 700 px: readers on phones scroll sideways. 600 px is the usual e-mail width.",
      );
  });
  for (const [font, fallback] of fonts)
    add(
      `web_font:${font}`,
      /Times New Roman/.test(fallback) ? "warning" : "info",
      OUTLOOK,
      `Font "${font}" is not installed for most readers: classic Outlook for Windows shows ${fallback.replace(/'/g, "")}${
        /Times New Roman/.test(fallback) ? " — add a fallback such as Arial after it" : ""
      }. New Outlook, Apple Mail and Gmail show "${font}" only if it is loaded from Google Fonts or installed.`,
    );
  $("img").each((_, el) => {
    const src = $(el).attr("src") ?? "";
    if (/^data:/i.test(src))
      add(
        "data_image",
        "warning",
        ["outlook_windows", "outlook_new", "gmail"],
        "Images pasted as data: are blocked by Outlook and Gmail. Upload the image instead.",
      );
    else if (/\.svg(\?|$)/i.test(src))
      add(
        "svg_image",
        "warning",
        ["outlook_windows", "gmail"],
        "SVG images are not shown by classic Outlook and Gmail. Use PNG or JPEG.",
      );
    else if (/\.webp(\?|$)/i.test(src))
      add(
        "webp_image",
        "warning",
        OUTLOOK,
        "WebP images are not shown by classic Outlook for Windows. Use PNG or JPEG.",
      );
    else if (/^https?:/i.test(src) && !ASSET_SRC.test(src))
      add(
        "external_image",
        "warning",
        ["outlook_windows", "outlook_new", "outlook_mobile", "gmail", "apple_mail"],
        'Images from other websites are hidden until the reader clicks "Download pictures". Upload them instead: uploaded images are embedded in the e-mail.',
      );
    if (/\.gif(\?|$)/i.test(src))
      add("gif", "info", OUTLOOK, "Animated GIFs show only their first frame in classic Outlook for Windows.");
    if (!$(el).attr("width"))
      add(
        "image_width",
        "warning",
        OUTLOOK,
        "Images without a width show at their full file size in classic Outlook for Windows. Set a width on each image.",
      );
    if (!$(el).attr("alt"))
      add(
        "image_alt",
        "info",
        ["outlook_windows", "outlook_new", "outlook_mobile", "gmail", "apple_mail"],
        "Images without alternative text show nothing while pictures are off (Outlook's default for new senders).",
      );
  });
  const css = (template.match(/<style[\s\S]*?<\/style>/gi) ?? []).join("\n");
  if (/@media/i.test(css))
    add(
      "media_query",
      "info",
      OUTLOOK,
      "Responsive rules (@media) are ignored by classic Outlook for Windows; Outlook for iOS / Android, Apple Mail and Gmail apply them.",
    );
  if (/:hover/i.test(css))
    add("hover", "info", ["outlook_windows", "outlook_mobile", "gmail"], "Hover effects work only in some mail apps.");
  if (Buffer.byteLength(doc) > 102_000)
    add(
      "size",
      "warning",
      ["gmail"],
      `The e-mail is ${Math.round(Buffer.byteLength(doc) / 1024)} KB: Gmail cuts off messages over 102 KB ("[Message clipped]").`,
    );
  return [...issues.values()]
    .map((i) => ({ ...i, feature: i.feature.replace(/:.*/, "") }))
    .sort((a, b) => (a.level === b.level ? 0 : a.level === "warning" ? -1 : 1));
}

// ---------------------------------------------------------------- images

/** Type and size of an uploaded PNG, JPEG or GIF from its header; null for anything else. */
export function imageInfo(
  buf: Buffer,
): { type: "image/png" | "image/jpeg" | "image/gif"; width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47)
    return { type: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString("ascii", 0, 4) === "GIF8")
    return { type: "image/gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { type: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}
