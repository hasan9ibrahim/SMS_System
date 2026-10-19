// Images for e-mail templates (§11, team trial round 1): PNG, JPEG or GIF up to 2 MB, per business company
// or shared. Templates reference them by url; sent e-mails embed them inline (cid), so readers see them
// without allowing remote images (see email/html.ts embedImages).
import type { FastifyReply, FastifyRequest } from "fastify";
import type { EmailAsset, EmailAssetUpload } from "@sms/contract";
import { withDb } from "../db.js";
import { imageInfo } from "../email/html.js";
import { sendProblem } from "../problem.js";
import { iso } from "./records.js";
import { getCurrentUser } from "./session.js";
import { badInput } from "./switchTools.js";

const MAX_BYTES = 2 * 1024 * 1024;
const SELECT = `a.id, a.name, a.content_type, a.size, a.width, a.height, a.business_company_id, a.uploaded_at,
  u.username AS uploaded_by FROM email_assets a LEFT JOIN users u ON u.id = a.uploaded_by_id`;

const mapAsset = (r: Record<string, unknown>): EmailAsset => ({
  id: Number(r.id),
  name: r.name as string,
  contentType: r.content_type as EmailAsset["contentType"],
  size: Number(r.size),
  width: Number(r.width),
  height: Number(r.height),
  url: `/api/v1/email-assets/${r.id}/file`,
  businessCompanyId: r.business_company_id == null ? null : Number(r.business_company_id),
  uploadedBy: (r.uploaded_by as string | null) ?? null,
  uploadedAt: iso(r.uploaded_at)!,
});

export function listEmailAssets(request: FastifyRequest, reply: FastifyReply) {
  const { businessCompanyId } = request.query as { businessCompanyId?: number };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      `SELECT ${SELECT} WHERE a.deleted_at IS NULL
          AND ($1::bigint IS NULL OR a.business_company_id IS NULL OR a.business_company_id = $1)
        ORDER BY a.uploaded_at DESC, a.id DESC LIMIT 200`,
      [businessCompanyId ?? null],
    );
    return { items: rows.map(mapAsset) };
  });
}

export function uploadEmailAsset(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as EmailAssetUpload;
  return withDb(reply, async (pool) => {
    const data = Buffer.from(b.contentBase64, "base64");
    const info = imageInfo(data);
    if (!data.length || data.length > MAX_BYTES)
      return badInput(reply, [{ path: "/contentBase64", message: "the image must be at most 2 MB" }]);
    if (!info)
      return badInput(reply, [
        { path: "/contentBase64", message: "use a PNG, JPEG or GIF image (SVG and WebP do not show in Outlook)" },
      ]);
    if (b.businessCompanyId != null) {
      const { rows } = await pool.query("SELECT 1 FROM business_companies WHERE id = $1 AND deleted_at IS NULL", [
        b.businessCompanyId,
      ]);
      if (!rows[0]) return badInput(reply, [{ path: "/businessCompanyId", message: "unknown business company" }]);
    }
    const me = await getCurrentUser();
    const name = b.name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "image";
    const { rows } = await pool.query(
      `INSERT INTO email_assets (business_company_id, name, content_type, size, width, height, data, uploaded_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [b.businessCompanyId, name, info.type, data.length, info.width, info.height, data, me.id],
    );
    const { rows: out } = await pool.query(`SELECT ${SELECT} WHERE a.id = $1`, [rows[0].id]);
    return reply.code(201).send(mapAsset(out[0]));
  });
}

export function downloadEmailAsset(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT content_type, data FROM email_assets WHERE id = $1", [id]);
    if (!rows[0]) return sendProblem(reply, 404, "No such image");
    return reply
      .type(rows[0].content_type as string)
      .header("cache-control", "private, max-age=86400")
      .send(rows[0].data as Buffer);
  });
}
