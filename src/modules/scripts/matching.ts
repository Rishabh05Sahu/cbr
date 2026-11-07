// FR-096 script targeting and the deterministic match order (ADR-0011). Pure functions.
//
// A script targets any of: transaction types, property types, languages, lead sources (projects
// arrive in Phase 5). An empty list means "any". A published script matches a lead when, for
// every dimension the script targets, the lead's value is one of the targeted values; a lead
// without a value for a targeted dimension does not match it. Languages are two-letter codes
// (lead.preferredLanguage); they compare trimmed and case-insensitively.
//
// Order of matches (the "best match" is the first):
//   1. more targeted dimensions first (the most specific script wins; untargeted = generic, last)
//   2. name, case-insensitive A→Z
//   3. script id (stable tie-break)

export interface ScriptTargeting {
  transactionTypes: readonly string[];
  propertyTypes: readonly string[];
  languages: readonly string[];
  sourceIds: readonly string[];
}

export interface LeadForMatching {
  transactionType: string | null;
  propertyType: string | null;
  preferredLanguage: string | null;
  sourceId: string | null;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Number of targeted dimensions the lead satisfies, or null when the script does not match. */
export function matchScore(t: ScriptTargeting, lead: LeadForMatching): number | null {
  const dims: [readonly string[], string | null, boolean][] = [
    [t.transactionTypes, lead.transactionType, false],
    [t.propertyTypes, lead.propertyType, false],
    [t.languages, lead.preferredLanguage, true],
    [t.sourceIds, lead.sourceId, false],
  ];
  let score = 0;
  for (const [targets, value, loose] of dims) {
    if (targets.length === 0) continue;
    if (value === null || value.trim() === '') return null;
    const hit = loose ? targets.some((x) => norm(x) === norm(value)) : targets.includes(value);
    if (!hit) return null;
    score++;
  }
  return score;
}

/** The matching scripts in the documented order. */
export function rankScripts<S extends { id: string; name: string } & ScriptTargeting>(
  scripts: readonly S[],
  lead: LeadForMatching,
): (S & { score: number })[] {
  return scripts
    .flatMap((s) => {
      const score = matchScore(s, lead);
      return score === null ? [] : [{ ...s, score }];
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en') ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
