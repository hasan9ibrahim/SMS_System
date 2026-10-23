// Excel rate sheets for incoming RNs (team trial round 2): a protected first sheet is read, dates from date
// cells, the header row is found or taken as given, a partner's "all networks" code becomes the MCC, and a
// workbook that needs a password to open is refused with a clear message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { zip } from "./xlsxFixture.js";
import { readSheet, toCountryCode, fromCountryCode } from "../src/rn/parse.js";
import { readXlsx, SheetFileError } from "../src/rn/xlsx.js";

const strings = [
  "Vendor rate sheet – protected",
  "MCCMNC",
  "Network",
  "Rate",
  "Effective Date",
  "Example Mobile",
  "All networks",
];
const workbook = zip({
  "xl/workbook.xml": `<workbook xmlns:r="r"><workbookProtection lockStructure="1"/><sheets><sheet name="Rates" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst>${strings.map((t) => `<si><t>${t.replace("&", "&amp;")}</t></si>`).join("")}</sst>`,
  "xl/styles.xml": `<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c></row>
    <row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" t="s"><v>2</v></c><c r="C3" t="s"><v>3</v></c><c r="D3" t="s"><v>4</v></c></row>
    <row r="4"><c r="A4"><v>26201</v></c><c r="B4" t="s"><v>5</v></c><c r="C4"><v>0.0412</v></c><c r="D4" s="1"><v>46327</v></c></row>
    <row r="5"><c r="A5" t="inlineStr"><is><t>26200</t></is></c><c r="B5" t="s"><v>6</v></c><c r="C5"><v>0.05</v></c></row>
  </sheetData><sheetProtection sheet="1" objects="1" scenarios="1" password="CC1A"/></worksheet>`,
});

test("a protected .xlsx sheet is read, with its header row and date cells", () => {
  const rows = readXlsx(workbook);
  assert.equal(rows[0]![0], "Vendor rate sheet – protected");
  assert.deepEqual(rows[1], []);
  assert.deepEqual(rows[3], ["26201", "Example Mobile", "0.0412", "2026-11-01"]);
  const sheet = readSheet(rows, null, { allNetworks: "mcc00" });
  assert.equal(sheet.headerRow, 3);
  assert.deepEqual(
    sheet.columns.map((c) => c.field),
    ["mccmnc", "network", "rate", "effective"],
  );
  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.rows[0]!.effective, "2026-11-01T00:00:00.000Z");
  assert.equal(sheet.rows[0]!.lineNo, 4);
  assert.equal(sheet.rows[1]!.mccmnc, "262", "26200 read as the country rate for an mcc00 partner");
  assert.equal(readSheet(rows).rows[1]!.mccmnc, "26200", "unchanged without the setting");
});

test("a given header row is used, and a wrong one is a clear error", () => {
  const rows = readXlsx(workbook);
  assert.equal(readSheet(rows, null, { headerRow: 3 }).rows.length, 2);
  const bad = readSheet(rows, null, { headerRow: 1 });
  assert.equal(bad.fatal, true);
  assert.match(bad.errors[0]!.message, /in row 1/);
});

test("a workbook that needs a password to open is refused", () => {
  const ole = Buffer.from("d0cf11e0a1b11ae1000000000000000000000000", "hex");
  assert.throws(
    () => readXlsx(ole),
    (e: unknown) => e instanceof SheetFileError && /password/.test(e.message),
  );
  assert.throws(() => readXlsx(Buffer.from("MCCMNC;Rate")), SheetFileError);
});

test("all-networks codes both ways", () => {
  assert.equal(toCountryCode("2620", "mcc0"), "262");
  assert.equal(toCountryCode("262000", "mcc000"), "262");
  assert.equal(toCountryCode("26201", "mcc0"), "26201");
  assert.equal(fromCountryCode("262", "mcc0"), "2620");
  assert.equal(fromCountryCode("262", "mcc"), "262");
  assert.equal(fromCountryCode("26201", "mcc00"), "26201");
  // A custom form (team trial round 3): MCC plus a suffix.
  assert.equal(toCountryCode("26299", "MCC99"), "262");
  assert.equal(toCountryCode("26201", "MCC99"), "26201");
  assert.equal(toCountryCode("262XX", "MCCxx"), "262");
  assert.equal(fromCountryCode("262", "MCC99"), "26299");
  assert.equal(fromCountryCode("26201", "MCC99"), "26201");
});
