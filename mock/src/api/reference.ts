// Picker data for record forms (§5): business companies, countries, categories,
// currencies, billing cycles, time zones and account managers.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ReferenceData } from "@sms/contract";
import { withDb } from "../db.js";
import { TIMEZONES } from "./records.js";

export function getReference(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool): Promise<ReferenceData> => {
    const [bc, countries, categories, currencies, cycles, ams] = await Promise.all([
      pool.query("SELECT id, name, base_currency FROM business_companies WHERE deleted_at IS NULL ORDER BY name"),
      pool.query("SELECT id, name, iso, dial_code FROM countries ORDER BY name"),
      pool.query("SELECT id, name FROM product_categories WHERE deleted_at IS NULL ORDER BY name"),
      pool.query("SELECT iso, name, symbol FROM currencies ORDER BY iso"),
      pool.query("SELECT id, name FROM billing_cycles WHERE deleted_at IS NULL ORDER BY id"),
      pool.query(
        `SELECT id, first_name || ' ' || last_name AS display_name FROM users
          WHERE is_account_manager AND status = 'active' AND deleted_at IS NULL ORDER BY 2`,
      ),
    ]);
    return {
      businessCompanies: bc.rows.map((r) => ({ id: r.id, name: r.name, baseCurrency: r.base_currency })),
      countries: countries.rows.map((r) => ({ id: r.id, name: r.name, iso: r.iso, dialCode: r.dial_code })),
      productCategories: categories.rows.map((r) => ({ id: r.id, name: r.name })),
      currencies: currencies.rows.map((r) => ({ iso: r.iso, name: r.name, symbol: r.symbol })),
      billingCycles: cycles.rows.map((r) => ({ id: r.id, name: r.name })),
      timezones: TIMEZONES,
      accountManagers: ams.rows.map((r) => ({ id: r.id, displayName: r.display_name })),
    };
  });
}
