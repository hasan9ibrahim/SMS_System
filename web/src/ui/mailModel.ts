// E-mail design editor helpers (§11, team trial round 1): fonts that are safe in mail apps, and the HTML
// snippets the toolbar inserts. Everything is inline-styled and table-based, because that is what
// classic Outlook for Windows (Word engine) and Gmail keep.

export const isHtml = (s: string) => /<[a-z][a-z0-9]*[\s/>]/i.test(s);
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
/** A plain-text body as HTML, so it can be edited visually. */
export const plainToHtml = (s: string) =>
  s
    .split(/\r?\n\r?\n/)
    .map((p) => `<p>${escapeHtml(p).replace(/\r?\n/g, "<br>")}</p>`)
    .join("\n");

export interface FontChoice {
  label: string;
  /** The CSS stack, fallback included. */
  stack: string;
  /** Google Fonts family name for web fonts; classic Outlook shows the fallback instead. */
  google?: string;
}
export const SAFE_FONTS: FontChoice[] = [
  { label: "Arial", stack: "Arial, Helvetica, sans-serif" },
  { label: "Helvetica", stack: "Helvetica, Arial, sans-serif" },
  { label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  { label: "Tahoma", stack: "Tahoma, Geneva, sans-serif" },
  { label: "Trebuchet MS", stack: "'Trebuchet MS', Helvetica, sans-serif" },
  { label: "Segoe UI", stack: "'Segoe UI', Arial, sans-serif" },
  { label: "Calibri", stack: "Calibri, Arial, sans-serif" },
  { label: "Georgia", stack: "Georgia, 'Times New Roman', serif" },
  { label: "Times New Roman", stack: "'Times New Roman', Times, serif" },
  { label: "Courier New", stack: "'Courier New', Courier, monospace" },
];
export const WEB_FONTS: FontChoice[] = [
  { label: "Inter", stack: "Inter, Arial, sans-serif", google: "Inter" },
  { label: "Roboto", stack: "Roboto, Arial, sans-serif", google: "Roboto" },
  { label: "Open Sans", stack: "'Open Sans', Arial, sans-serif", google: "Open Sans" },
  { label: "Lato", stack: "Lato, Arial, sans-serif", google: "Lato" },
  { label: "Montserrat", stack: "Montserrat, Arial, sans-serif", google: "Montserrat" },
  { label: "Poppins", stack: "Poppins, Arial, sans-serif", google: "Poppins" },
  { label: "Playfair Display", stack: "'Playfair Display', Georgia, serif", google: "Playfair Display" },
];
export const FONT_SIZES = [10, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40];

/** The Google Fonts stylesheet for a web font (kept by the sanitiser; mail apps that allow it load it). */
export const googleFontHref = (family: string) =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;700&display=swap`;

/** Adds the font's stylesheet link once, at the top of the body (moved into the head when sent). */
export function withFontLink(html: string, family: string): string {
  const href = googleFontHref(family);
  if (html.includes(href.split("&")[0]!)) return html;
  return `<link rel="stylesheet" href="${escapeHtml(href)}">\n${html}`;
}

/** A button that looks the same in Outlook: a coloured table cell with a link in it ("bulletproof"). */
export function buttonHtml(label: string, href: string, background = "#2563eb", color = "#ffffff"): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:12px 0"><tr><td bgcolor="${escapeHtml(background)}" style="background-color:${escapeHtml(background)};border-radius:6px;padding:10px 22px"><a href="${escapeHtml(href)}" style="color:${escapeHtml(color)};text-decoration:none;font-weight:bold;font-family:Arial,Helvetica,sans-serif;font-size:14px;display:inline-block">${escapeHtml(label)}</a></td></tr></table>`;
}

/** A simple table: full width, collapsed borders, padding on cells (what every mail app keeps). */
export function tableHtml(rows: number, cols: number): string {
  const cell =
    '<td style="border:1px solid #d1d5db;padding:8px;font-family:Arial,Helvetica,sans-serif;font-size:14px">&nbsp;</td>';
  const row = `<tr>${cell.repeat(cols)}</tr>`;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin:12px 0">${row.repeat(rows)}</table>`;
}

export const dividerHtml = '<hr style="border:0;border-top:1px solid #e5e7eb;margin:16px 0">';

/** An uploaded image at most 600 px wide, with its width attribute (classic Outlook sizes by it). */
export function imageHtml(src: string, alt: string, width: number, height: number): string {
  const w = Math.min(600, width);
  const h = Math.round((height * w) / width);
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${w}" height="${h}" style="display:block;border:0;width:${w}px;max-width:100%;height:auto">`;
}

const LAYOUT_MARK = 'data-mail-layout="1"';
export const hasLayout = (html: string) => html.includes(LAYOUT_MARK);

/**
 * Puts the body in the usual e-mail frame: a page background and a centred 600 px card. A table, so
 * classic Outlook keeps the width and the colours. A second call changes the colours only.
 */
export function withLayout(html: string, page = "#f3f4f6", card = "#ffffff"): string {
  if (hasLayout(html))
    return html
      .replace(/(data-mail-layout="1"[^>]*?bgcolor=")[^"]*(")/, `$1${page}$2`)
      .replace(/(data-mail-layout="1"[^>]*?background-color:)[^;"]*/, `$1${page}`)
      .replace(/(data-mail-card="1"[^>]*?bgcolor=")[^"]*(")/, `$1${card}$2`)
      .replace(/(data-mail-card="1"[^>]*?background-color:)[^;"]*/, `$1${card}`);
  const fonts = (html.match(/<link [^>]*fonts\.googleapis[^>]*>\n?/g) ?? []).join("");
  const inner = html.replace(/<link [^>]*fonts\.googleapis[^>]*>\n?/g, "");
  return `${fonts}<table role="presentation" ${LAYOUT_MARK} width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${page}" style="background-color:${page}"><tr><td align="center" style="padding:24px 12px"><table role="presentation" data-mail-card="1" width="600" cellspacing="0" cellpadding="0" border="0" bgcolor="${card}" style="width:600px;max-width:100%;background-color:${card}"><tr><td style="padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937">${inner}</td></tr></table></td></tr></table>`;
}

/** Mail app names for the compatibility list. */
export const CLIENT_LABEL: Record<string, string> = {
  outlook_windows: "Outlook for Windows (classic)",
  outlook_new: "New Outlook / Outlook web",
  outlook_mobile: "Outlook phone",
  gmail: "Gmail",
  apple_mail: "Apple Mail",
};
