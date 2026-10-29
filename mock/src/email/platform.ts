// The platform's own e-mails (team trial round 11): sign-in codes, password reminders and set-up links, credential
// codes, alerts and job summaries, sent from the platform mailbox, go out with the Xpert logo on top and a short
// footer; the plain text stays as the text part. E-mails sent as a business company keep that company's design.
import { emailDocument, escapeHtml } from "./html.js";
import { XPERT_LOGO_PNG, XPERT_LOGO_SIZE } from "./xpertLogo.js";

export const XPERT_LOGO_CID = "xpert-logo@xpert";

/** Plain text as HTML: blank lines make paragraphs, line breaks stay, web addresses become links. */
function paragraphs(text: string): string {
  return text
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .map((p) => {
      const html = escapeHtml(p)
        .replace(/\r?\n/g, "<br>")
        .replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" style="color:#0b56c9">${url}</a>`);
      return `<p style="margin:0 0 14px">${html}</p>`;
    })
    .join("");
}

/** The e-mail document: logo, the message, then the footer. */
export function platformDocument(text: string): string {
  const { width, height } = XPERT_LOGO_SIZE;
  return emailDocument(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f5f9">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e3e7ee;border-radius:8px">
<tr><td style="padding:22px 28px 14px;border-bottom:1px solid #eef1f5;background:#ffffff">
<img src="cid:${XPERT_LOGO_CID}" alt="Xpert" width="${width}" height="${height}" style="display:block;border:0;width:${width}px;height:${height}px">
</td></tr>
<tr><td style="padding:22px 28px 10px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1f2937">${paragraphs(text)}</td></tr>
</table>
<p style="margin:14px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#6b7280">Sent automatically by the Xpert platform.</p>
</td></tr>
</table>`);
}

/** The logo as an inline part of the message. */
export const platformLogoPart = () => ({
  cid: XPERT_LOGO_CID,
  filename: "xpert.png",
  content: XPERT_LOGO_PNG,
  contentType: "image/png",
});
