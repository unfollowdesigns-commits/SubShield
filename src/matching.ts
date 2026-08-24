/**
 * Working out who a certificate belongs to.
 *
 * This is the one genuinely fuzzy step in the pipeline, so it is isolated here,
 * kept pure, and biased hard towards refusing to guess. A COI filed against the
 * wrong subcontractor is worse than one sitting in a review queue.
 */

/** Corporate suffixes and punctuation carry no identifying information. */
const NOISE = /\b(inc|incorporated|llc|ltd|limited|co|company|corp|corporation|the|and|of|group|services|service|contracting|contractors|construction)\b/g;

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    // Periods go first, so "L.L.C." collapses to "llc" and is recognised as
    // noise. Strip them alongside the rest and it becomes "l l c", which is not.
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dice coefficient over character bigrams. 0 = nothing shared, 1 = identical. */
export function similarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };

  const ga = bigrams(na);
  const gb = bigrams(nb);
  if (ga.size === 0 || gb.size === 0) return 0;

  let shared = 0;
  let total = 0;
  for (const n of ga.values()) total += n;
  for (const [g, n] of gb) {
    total += n;
    shared += Math.min(n, ga.get(g) ?? 0);
  }
  return (2 * shared) / total;
}

export const NAME_MATCH_THRESHOLD = 0.6;

export interface Candidate {
  id: string;
  vendor_name: string;
  contact_email: string;
}

export type MatchMethod = 'sender_email' | 'vendor_name' | 'none';

export interface Match {
  subcontractorId: string | null;
  method: MatchMethod;
  score: number;
}

const NO_MATCH: Match = { subcontractorId: null, method: 'none', score: 0 };

/**
 * Resolve a certificate to a subcontractor.
 *
 * Sender address first — it is exact. Then the insured entity name, but only if
 * one candidate clears the threshold and no second candidate comes close;
 * two plausible matches means we do not know, which is not the same as a tie.
 */
export function matchSubcontractor(
  candidates: Candidate[],
  opts: { senderEmail?: string | null; insuredName?: string | null },
): Match {
  const sender = opts.senderEmail?.trim().toLowerCase();
  if (sender) {
    const hit = candidates.find((c) => c.contact_email.trim().toLowerCase() === sender);
    if (hit) return { subcontractorId: hit.id, method: 'sender_email', score: 1 };
  }

  const insured = opts.insuredName?.trim();
  if (!insured) return NO_MATCH;

  const scored = candidates
    .map((c) => ({ c, score: similarity(insured, c.vendor_name) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < NAME_MATCH_THRESHOLD) return NO_MATCH;

  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < 0.15) return NO_MATCH;

  return { subcontractorId: best.c.id, method: 'vendor_name', score: best.score };
}

/**
 * `apex-certs@process.subshield.io` -> `apex-certs`.
 * Sub-addressing is stripped so `apex-certs+scan@…` still routes.
 */
export function aliasFromAddress(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  const local = address.slice(0, at).trim().toLowerCase();
  const plus = local.indexOf('+');
  const alias = plus === -1 ? local : local.slice(0, plus);
  return alias === '' ? null : alias;
}
