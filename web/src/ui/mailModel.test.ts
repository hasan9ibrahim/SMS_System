import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buttonHtml,
  googleFontHref,
  hasLayout,
  imageHtml,
  plainToHtml,
  tableHtml,
  withFontLink,
  withLayout,
} from "./mailModel";

describe("e-mail designer snippets (§11)", () => {
  test("plain text becomes paragraphs, escaped", () => {
    assert.equal(plainToHtml("Dear <A>,\nline\n\nBye"), "<p>Dear &lt;A&gt;,<br>line</p>\n<p>Bye</p>");
  });
  test("buttons, tables and images are Outlook-safe: table cells, bgcolor, width attributes", () => {
    const b = buttonHtml("Pay now", "https://pay.example/?a=1&b=2", "#16a34a");
    assert.match(b, /<td bgcolor="#16a34a" style="background-color:#16a34a;/);
    assert.match(b, /href="https:\/\/pay\.example\/\?a=1&amp;b=2"/);
    assert.equal((tableHtml(2, 3).match(/<td /g) ?? []).length, 6);
    const img = imageHtml("/api/v1/email-assets/4/file", "Banner", 1200, 400);
    assert.match(img, /width="600" height="200"/, "scaled to 600 px with its width attribute");
  });
  test("web fonts get their stylesheet once; layout wraps once and recolours after", () => {
    const once = withFontLink("<p>x</p>", "Open Sans");
    assert.ok(once.startsWith(`<link rel="stylesheet" href="${googleFontHref("Open Sans").replace(/&/g, "&amp;")}">`));
    assert.equal(withFontLink(once, "Open Sans"), once);
    const framed = withLayout(once, "#000000", "#ffffff");
    assert.ok(hasLayout(framed));
    assert.ok(framed.startsWith("<link"), "font links stay first");
    assert.match(framed, /width="600"/);
    const recoloured = withLayout(framed, "#111111", "#fafafa");
    assert.equal((recoloured.match(/data-mail-layout/g) ?? []).length, 1);
    assert.match(recoloured, /bgcolor="#111111"/);
    assert.match(recoloured, /data-mail-card="1"[^>]*bgcolor="#fafafa"/);
  });
});
