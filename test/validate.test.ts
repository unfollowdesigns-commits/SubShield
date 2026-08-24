import { describe, expect, it } from 'vitest';
import { CONFIDENCE_FLOOR, daysUntil, isValidIsoDate, validate } from '../src/validate';
import type { Extraction, Requirements } from '../src/types';

const NOW = new Date('2026-06-15T12:00:00Z');

const REQS: Requirements = {
  min_gl_each_occurrence: 1_000_000,
  min_gl_aggregate: 2_000_000,
  require_additional_insured: true,
  require_waiver_subrogation: true,
};

/** A certificate that passes every check. Each test bends one thing. */
function clean(over: Partial<Extraction> = {}): Extraction {
  return {
    document_type: 'acord_25',
    producer_name: 'Hanover & Fifth Insurance Agency',
    insured_entity_name: 'Tri-County Plumbing Inc',
    carrier_name: 'Travelers',
    gl_policy_number: 'GL-4471902',
    gl_each_occurrence_limit: 1_000_000,
    gl_general_aggregate_limit: 2_000_000,
    gl_expiration_date: '2027-03-14',
    additional_insured_included: true,
    waiver_of_subrogation_included: true,
    certificate_holder_text: 'Apex Builders Group\n88 Harbor Rd\nProvidence, RI 02903',
    confidence_score: 0.97,
    ...over,
  };
}

describe('validate — the happy path', () => {
  it('approves a clean certificate', () => {
    expect(validate(clean(), REQS, NOW)).toEqual([]);
  });

  it('approves limits exactly at the minimum', () => {
    const x = clean({ gl_each_occurrence_limit: 1_000_000, gl_general_aggregate_limit: 2_000_000 });
    expect(validate(x, REQS, NOW)).toEqual([]);
  });

  it('approves confidence exactly at the floor', () => {
    expect(validate(clean({ confidence_score: CONFIDENCE_FLOOR }), REQS, NOW)).toEqual([]);
  });

  it('approves a policy expiring today — good through end of day', () => {
    expect(validate(clean({ gl_expiration_date: '2026-06-15' }), REQS, NOW)).toEqual([]);
  });
});

describe('validate — the spec QA matrix', () => {
  it('TC-03: rejects a policy that expired yesterday', () => {
    const out = validate(clean({ gl_expiration_date: '2026-06-14' }), REQS, NOW);
    expect(out).toContain('policy_expired');
  });

  it('TC-04: rejects an occurrence limit below the client minimum', () => {
    const out = validate(clean({ gl_each_occurrence_limit: 500_000 }), REQS, NOW);
    expect(out).toContain('occurrence_limit_below_minimum');
  });

  it('TC-04b: rejects an aggregate below the client minimum', () => {
    const out = validate(clean({ gl_general_aggregate_limit: 1_000_000 }), REQS, NOW);
    expect(out).toContain('aggregate_limit_below_minimum');
  });

  it('TC-05: rejects a blank additional insured column', () => {
    const out = validate(clean({ additional_insured_included: false }), REQS, NOW);
    expect(out).toContain('missing_additional_insured');
  });

  it('TC-06: rejects a document that is not an ACORD 25, and checks nothing else', () => {
    const w9 = clean({
      document_type: 'other',
      gl_expiration_date: null,
      gl_each_occurrence_limit: null,
      confidence_score: 0.1,
    });
    expect(validate(w9, REQS, NOW)).toEqual(['not_an_acord_25']);
  });

  it('TC-07: a blank GL limit fails even when other rows carried limits', () => {
    const out = validate(clean({ gl_each_occurrence_limit: null }), REQS, NOW);
    expect(out).toContain('missing_occurrence_limit');
    expect(out).not.toContain('occurrence_limit_below_minimum');
  });
});

describe('validate — failing closed', () => {
  it('an unreadable endorsement column is not an endorsement', () => {
    const out = validate(
      clean({ additional_insured_included: null, waiver_of_subrogation_included: null }),
      REQS,
      NOW,
    );
    expect(out).toContain('missing_additional_insured');
    expect(out).toContain('missing_waiver_of_subrogation');
  });

  it('rejects confidence just below the floor', () => {
    const out = validate(clean({ confidence_score: 0.89 }), REQS, NOW);
    expect(out).toContain('low_confidence');
  });

  it('treats NaN confidence as low confidence rather than passing', () => {
    const out = validate(clean({ confidence_score: Number.NaN }), REQS, NOW);
    expect(out).toContain('low_confidence');
  });

  it('rejects a malformed expiration date', () => {
    const out = validate(clean({ gl_expiration_date: '03/14/2027' }), REQS, NOW);
    expect(out).toContain('unparseable_expiration_date');
  });

  it('rejects a date that matches the format but is not a real day', () => {
    const out = validate(clean({ gl_expiration_date: '2027-02-30' }), REQS, NOW);
    expect(out).toContain('unparseable_expiration_date');
  });

  it('rejects a missing expiration date', () => {
    const out = validate(clean({ gl_expiration_date: null }), REQS, NOW);
    expect(out).toContain('missing_expiration_date');
  });

  it('rejects a zero or negative limit rather than reading it as a number', () => {
    expect(validate(clean({ gl_each_occurrence_limit: 0 }), REQS, NOW))
      .toContain('missing_occurrence_limit');
    expect(validate(clean({ gl_each_occurrence_limit: -1_000_000 }), REQS, NOW))
      .toContain('missing_occurrence_limit');
  });

  it('reports every independent failure at once, not just the first', () => {
    const bad = clean({
      confidence_score: 0.4,
      gl_each_occurrence_limit: 250_000,
      gl_general_aggregate_limit: 500_000,
      additional_insured_included: false,
      waiver_of_subrogation_included: false,
    });
    expect(validate(bad, REQS, NOW).sort()).toEqual([
      'aggregate_limit_below_minimum',
      'low_confidence',
      'missing_additional_insured',
      'missing_waiver_of_subrogation',
      'occurrence_limit_below_minimum',
    ]);
  });
});

describe('validate — per-client requirements', () => {
  it('honours a client that does not require a waiver of subrogation', () => {
    const relaxed: Requirements = { ...REQS, require_waiver_subrogation: false };
    const x = clean({ waiver_of_subrogation_included: false });
    expect(validate(x, relaxed, NOW)).toEqual([]);
  });

  it('skips the aggregate check when the client sets no aggregate minimum', () => {
    const relaxed: Requirements = { ...REQS, min_gl_aggregate: 0 };
    const x = clean({ gl_general_aggregate_limit: null });
    expect(validate(x, relaxed, NOW)).toEqual([]);
  });

  it('applies a higher minimum for a client that demands one', () => {
    const strict: Requirements = { ...REQS, min_gl_each_occurrence: 2_000_000 };
    expect(validate(clean(), strict, NOW)).toContain('occurrence_limit_below_minimum');
  });
});

describe('date helpers', () => {
  it('accepts real ISO dates and rejects everything else', () => {
    expect(isValidIsoDate('2027-03-14')).toBe(true);
    expect(isValidIsoDate('2024-02-29')).toBe(true);   // leap year
    expect(isValidIsoDate('2027-02-29')).toBe(false);  // not a leap year
    expect(isValidIsoDate('2027-13-01')).toBe(false);
    expect(isValidIsoDate('27-03-14')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
  });

  it('counts days to the chase ladder thresholds', () => {
    expect(daysUntil('2026-07-15', NOW)).toBe(30);
    expect(daysUntil('2026-06-30', NOW)).toBe(15);
    expect(daysUntil('2026-06-22', NOW)).toBe(7);
    expect(daysUntil('2026-06-15', NOW)).toBe(0);
    expect(daysUntil('2026-06-14', NOW)).toBe(-1);
  });
});
