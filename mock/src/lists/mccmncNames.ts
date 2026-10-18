// Destination filters by name (team trial round 1, §13.25).
/**
 * MCCMNC codes whose country or network name matches an ILIKE pattern ("France%", "%Orange%"), so a
 * destination filter takes names as well as codes (team trial round 1).
 */
export function mccmncByNameSql(pattern: string): string {
  return `(SELECT nm.mccmnc FROM mccmnc nm LEFT JOIN countries nco ON nco.id = nm.country_id
    WHERE nm.deleted_at IS NULL AND (nco.name ILIKE ${pattern} OR nm.network ILIKE ${pattern}
      OR (nco.name || ' · ' || COALESCE(nm.network, '')) ILIKE ${pattern}))`;
}

/** A filter value with letters in it is a name, not a code. */
export const isNameValue = (v: unknown) => /\p{L}/u.test(String(v ?? ""));
