import { describe, expect, it } from 'vitest';
import { holderMatches, validate } from '../src/validate';
import type { Extraction, Requirements } from '../src/types';

const NOW = new Date('2026-06-15T12:00:00Z');

const APEX: Requirements = {
  min_gl_each_occurrence: 1_000_000,
  min_gl_aggregate: 2_000_000,
  require_additional_insured: true,
  require_waiver_subrogation: true,
  require_holder_match: true,
  company_name: 'Apex Builders Group',
  holder_aliases: ['Apex Builders'],
};

function clean(over: Partial<Extraction> = {}): Extraction {
  return {
    document_type: 'acord_25',
    producer_name: 'Hanover & Fifth',
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

describe('holderMatches', () => {
  it('finds the client name inside a postal address block', () => {
    expect(holderMatches('Apex Builders Group\n88 Harbor Rd\nProvidence RI', ['Apex Builders Group']))
      .toBe(true);
  });

  it('accepts a configured alias', () => {
    expect(holderMatches('APEX BUILDERS\n88 Harbor Rd', ['Apex Builders Group', 'Apex Builders']))
      .toBe(true);
  });

  it('ignores corporate suffix differences', () => {
    expect(holderMatches('Apex Builders Group, LLC\n88 Harbor Rd', ['Apex Builders Group Inc']))
      .toBe(true);
  });

  it('TC-10: rejects a certificate made out to a different contractor', () => {
    expect(holderMatches('Northgate Construction LLC\n12 Mill St', ['Apex Builders Group']))
      .toBe(false);
  });

  it('tolerates a small misreading in the first line', () => {
    expect(holderMatches('Apex Bullders Group\n88 Harbor Rd', ['Apex Builders Group'])).toBe(true);
  });

  it('rejects an empty holder block', () => {
    expect(holderMatches(null, ['Apex Builders Group'])).toBe(false);
    expect(holderMatches('   ', ['Apex Builders Group'])).toBe(false);
  });

  it('passes when there is nothing configured to check against', () => {
    expect(holderMatches('Anyone at all', [])).toBe(true);
  });
});

describe('validate — the holder check', () => {
  it('approves a certificate made out to this client', () => {
    expect(validate(clean(), APEX, NOW)).toEqual([]);
  });

  it('TC-10: never auto-approves another contractor’s certificate, however clean', () => {
    const other = clean({
      certificate_holder_text: 'Northgate Construction LLC\n12 Mill St\nWarwick, RI',
    });
    expect(validate(other, APEX, NOW)).toEqual(['holder_mismatch']);
  });

  it('flags a holder block the model could not read', () => {
    expect(validate(clean({ certificate_holder_text: null }), APEX, NOW))
      .toEqual(['missing_certificate_holder']);
  });

  it('skips the check for a client who has not turned it on', () => {
    const relaxed = { ...APEX, require_holder_match: false };
    const other = clean({ certificate_holder_text: 'Northgate Construction LLC' });
    expect(validate(other, relaxed, NOW)).toEqual([]);
  });

  it('skips the check when no company name is configured', () => {
    const unnamed = { ...APEX, company_name: undefined, holder_aliases: null };
    expect(validate(clean({ certificate_holder_text: 'Whoever' }), unnamed, NOW)).toEqual([]);
  });

  it('reports a holder mismatch alongside the other failures', () => {
    const bad = clean({
      certificate_holder_text: 'Northgate Construction LLC',
      gl_each_occurrence_limit: 500_000,
    });
    expect(validate(bad, APEX, NOW).sort())
      .toEqual(['holder_mismatch', 'occurrence_limit_below_minimum']);
  });
});
