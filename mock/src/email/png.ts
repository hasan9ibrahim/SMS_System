// Fake images for the generator and tests (CLAUDE.md rule 1: fake data only).
import zlib from "node:zlib";

/**
 * A fake 160 × 48 logo (§11): a brand-coloured mark and three grey bars standing in for the name. Real
 * pixels, so templates using {company_logo} preview and send at a realistic size.
 */
export function fakeLogoPng(rgb: [number, number, number]): Buffer {
  const w = 160;
  const h = 48;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const inMark = x >= 4 && x < 44 && y >= 4 && y < 44;
      const inner = x >= 16 && x < 32 && y >= 16 && y < 32;
      const bar =
        x >= 54 && ((y >= 12 && y < 20 && x < 150) || (y >= 26 && y < 31 && x < 120) || (y >= 35 && y < 40 && x < 96));
      const c: [number, number, number] = inMark && !inner ? rgb : bar ? [75, 85, 99] : [255, 255, 255];
      raw.set(c, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
