import type { Extraction, FailureReason, Requirements } from './types';

/**
 * Below this, a human looks at it. The model's own confidence is the only
 * signal we have for legibility, so it gates approval rather than informing it.
 */
export const CONFIDENCE_FLOOR = 0.9;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today as YYYY-MM-DD in UTC. Dates are compared as strings — see validate(). */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** True if `iso` is a real calendar date in YYYY-MM-DD form. */
export function isValidIsoDate(iso: string): boolean {
  if (!ISO_DATE.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** Whole days from `from` to `iso`. Negative once the date is in the past. */
export function daysUntil(iso: string, from: Date = new Date()): number {
  const target = Date.parse(`${iso}T00:00:00Z`);
  const start = Date.parse(`${todayIso(from)}T00:00:00Z`);
  return Math.round((target - start) / 86_400_000);
}

/**
 * The only thing that decides whether a certificate is compliant.
 *
 * The model extracts; this function judges. It is pure and synchronous so it can
 * be tested exhaustively without an API key, and so that no future change can
 * quietly let a model's opinion become an approval.
 *
 * @returns the failed checks. An empty array — and nothing else — means approve.
 */
export function validate(
  x: Extraction,
  reqs: Requirements,
  now: Date = new Date(),
): FailureReason[] {
  // A — is this even the right document? Nothing else is worth checking if not.
  if (x.document_type !== 'acord_25') return ['not_an_acord_25'];

  const fail: FailureReason[] = [];

  // B — extraction quality. NaN and out-of-range both fail closed.
  if (!(x.confidence_score >= CONFIDENCE_FLOOR)) fail.push('low_confidence');

  // C/D — expiration must be present, parseable, and in the future.
  // Compared as ISO strings: a policy expiring today is good through today,
  // and no timezone can shift the answer by a day.
  if (x.gl_expiration_date == null || x.gl_expiration_date === '') {
    fail.push('missing_expiration_date');
  } else if (!isValidIsoDate(x.gl_expiration_date)) {
    fail.push('unparseable_expiration_date');
  } else if (x.gl_expiration_date < todayIso(now)) {
    fail.push('policy_expired');
  }

  // E — limits meet this client's minimums. A null limit is a missing limit,
  // never a passing one.
  const occurrence = x.gl_each_occurrence_limit;
  if (occurrence == null || !Number.isFinite(occurrence) || occurrence <= 0) {
    fail.push('missing_occurrence_limit');
  } else if (occurrence < reqs.min_gl_each_occurrence) {
    fail.push('occurrence_limit_below_minimum');
  }

  const aggregate = x.gl_general_aggregate_limit;
  if (reqs.min_gl_aggregate > 0) {
    if (aggregate == null || !Number.isFinite(aggregate) || aggregate <= 0) {
      fail.push('missing_aggregate_limit');
    } else if (aggregate < reqs.min_gl_aggregate) {
      fail.push('aggregate_limit_below_minimum');
    }
  }

  // F — endorsements. `!== true` on purpose: null means the model could not
  // read the column, which is not evidence that the box was checked.
  if (reqs.require_additional_insured && x.additional_insured_included !== true) {
    fail.push('missing_additional_insured');
  }
  if (reqs.require_waiver_subrogation && x.waiver_of_subrogation_included !== true) {
    fail.push('missing_waiver_of_subrogation');
  }

  return fail;
}

/** Convenience wrapper for the one question callers actually ask. */
export function isCompliant(
  x: Extraction,
  reqs: Requirements,
  now: Date = new Date(),
): boolean {
  return validate(x, reqs, now).length === 0;
}

/** Human-readable text for a failure slug. For emails and the review UI only. */
export const FAILURE_TEXT: Record<FailureReason, string> = {
  not_an_acord_25: 'The file does not appear to be an ACORD 25 certificate of liability insurance',
  low_confidence: 'The certificate could not be read clearly enough to verify automatically',
  missing_expiration_date: 'No general liability expiration date could be found',
  unparseable_expiration_date: 'The general liability expiration date could not be read',
  policy_expired: 'The general liability policy has already expired',
  missing_occurrence_limit: 'No general liability each-occurrence limit could be found',
  occurrence_limit_below_minimum: 'The each-occurrence limit is below the required minimum',
  missing_aggregate_limit: 'No general liability general aggregate limit could be found',
  aggregate_limit_below_minimum: 'The general aggregate limit is below the required minimum',
  missing_additional_insured: 'The certificate does not show additional insured status',
  missing_waiver_of_subrogation: 'The certificate does not show a waiver of subrogation',
};
