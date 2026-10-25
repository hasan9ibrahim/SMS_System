// Document files for billing (§7): a text PDF (Helvetica, A4, pages added as needed) and an Excel
// 2003 XML spreadsheet (.xls, opens in Excel without a library). Enough for the mock; production
// fills the business company's XLSX format files (§11).

export interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  /** Space above the line in points (default size + 5). */
  gap?: number;
  /** Columns: extra texts at fixed x positions (points from the left edge). */
  cells?: { x: number; text: string; right?: boolean }[];
}

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "?");

/** `pageHeader`: lines repeated at the top of every page after the first (a long table's column headings). */
export function simplePdf(lines: PdfLine[], pageHeader: PdfLine[] = []): Buffer {
  const pages: string[][] = [[]];
  let y = 800;
  const queue = [...lines];
  while (queue.length) {
    const l = queue.shift()!;
    const size = l.size ?? 10;
    y -= l.gap ?? size + 5;
    if (y < 40) {
      pages.push([]);
      y = 800;
      queue.unshift(...pageHeader.map((h) => ({ ...h, gap: (h.size ?? 10) + 5 })), { ...l, gap: size + 5 });
      continue;
    }
    const font = l.bold ? "F2" : "F1";
    const ops = pages[pages.length - 1]!;
    if (l.text) ops.push(`BT /${font} ${size} Tf 50 ${y} Td (${esc(l.text)}) Tj ET`);
    for (const c of l.cells ?? []) {
      // Right-aligned cells: Helvetica digits are about 0.556 em wide.
      const x = c.right ? c.x - c.text.length * size * 0.53 : c.x;
      ops.push(`BT /${font} ${size} Tf ${x.toFixed(1)} ${y} Td (${esc(c.text)}) Tj ET`);
    }
  }
  const n = pages.length;
  // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, then per page: page, content.
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ")}] /Count ${n} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  pages.forEach((ops, i) => {
    const stream = [...ops, `BT /F1 8 Tf 520 20 Td (${i + 1} / ${n}) Tj ET`].join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${6 + i * 2} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const xmlEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One worksheet: rows of strings and numbers (null = empty cell); `bold` rows are headings. */
export function spreadsheetXml(sheet: string, rows: { cells: (string | number | null)[]; bold?: boolean }[]): Buffer {
  const cell = (v: string | number | null) =>
    v === null
      ? "<Cell/>"
      : typeof v === "number"
        ? `<Cell ss:StyleID="n"><Data ss:Type="Number">${v}</Data></Cell>`
        : `<Cell><Data ss:Type="String">${xmlEsc(v)}</Data></Cell>`;
  const body = rows.map((r) => `<Row${r.bold ? ' ss:StyleID="b"' : ""}>${r.cells.map(cell).join("")}</Row>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="b"><Font ss:Bold="1"/></Style><Style ss:ID="n"><NumberFormat ss:Format="#,##0.00"/></Style></Styles>
<Worksheet ss:Name="${xmlEsc(sheet.slice(0, 31))}"><Table>
${body}
</Table></Worksheet>
</Workbook>
`;
  return Buffer.from(xml, "utf8");
}
