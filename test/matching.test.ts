import { describe, expect, it } from 'vitest';
import {
  aliasFromAddress,
  matchSubcontractor,
  normalizeName,
  similarity,
  type Candidate,
} from '../src/matching';

const SUBS: Candidate[] = [
  { id: 'a', vendor_name: 'Tri-County Plumbing Inc', contact_email: 'ap@tricountyplumbing.com' },
  { id: 'b', vendor_name: 'Nordic Electric LLC', contact_email: 'Office@NordicElectric.com' },
  { id: 'c', vendor_name: 'ABC Masonry LLC', contact_email: 'billing@abcmasonry.com' },
];

describe('aliasFromAddress', () => {
  it('takes the local part as the tenant key', () => {
    expect(aliasFromAddress('apex-certs@process.subshield.io')).toBe('apex-certs');
  });

  it('strips sub-addressing so forwarding rules still route', () => {
    expect(aliasFromAddress('apex-certs+scan2@process.subshield.io')).toBe('apex-certs');
  });

  it('lowercases, since mail systems disagree about case', () => {
    expect(aliasFromAddress('Apex-Certs@Process.SubShield.io')).toBe('apex-certs');
  });

  it('refuses malformed addresses rather than inventing an alias', () => {
    expect(aliasFromAddress('not-an-address')).toBeNull();
    expect(aliasFromAddress('@subshield.io')).toBeNull();
    expect(aliasFromAddress('')).toBeNull();
  });
});

describe('normalizeName', () => {
  it('drops corporate suffixes and punctuation', () => {
    expect(normalizeName('Tri-County Plumbing, Inc.')).toBe('tri county plumbing');
    expect(normalizeName('NORDIC ELECTRIC L.L.C.')).toBe('nordic electric');
  });
});

describe('similarity', () => {
  it('scores the same company written two ways as a match', () => {
    expect(similarity('Tri-County Plumbing Inc', 'TRI COUNTY PLUMBING, LLC')).toBeGreaterThan(0.9);
  });

  it('scores unrelated companies low', () => {
    expect(similarity('Tri-County Plumbing Inc', 'Nordic Electric LLC')).toBeLessThan(0.3);
  });

  it('is not fooled by a shared suffix alone', () => {
    expect(similarity('Acme LLC', 'Zenith LLC')).toBeLessThan(0.5);
  });
});

describe('matchSubcontractor', () => {
  it('matches on sender address before anything else', () => {
    const m = matchSubcontractor(SUBS, { senderEmail: 'ap@tricountyplumbing.com' });
    expect(m).toEqual({ subcontractorId: 'a', method: 'sender_email', score: 1 });
  });

  it('matches sender address case-insensitively', () => {
    const m = matchSubcontractor(SUBS, { senderEmail: 'OFFICE@nordicelectric.COM' });
    expect(m.subcontractorId).toBe('b');
  });

  it('falls back to the insured entity name', () => {
    const m = matchSubcontractor(SUBS, {
      senderEmail: 'jane@some-insurance-agency.com',
      insuredName: 'Tri County Plumbing, LLC',
    });
    expect(m.method).toBe('vendor_name');
    expect(m.subcontractorId).toBe('a');
  });

  it('TC-12: refuses to guess when nothing is close enough', () => {
    const m = matchSubcontractor(SUBS, {
      senderEmail: 'jane@agency.com',
      insuredName: 'Delta Roofing Systems',
    });
    expect(m).toEqual({ subcontractorId: null, method: 'none', score: 0 });
  });

  it('refuses when two vendors are similarly plausible', () => {
    const ambiguous: Candidate[] = [
      { id: 'x', vendor_name: 'Summit Electric', contact_email: 'a@x.com' },
      { id: 'y', vendor_name: 'Summit Electrical', contact_email: 'b@y.com' },
    ];
    const m = matchSubcontractor(ambiguous, { insuredName: 'Summit Electric Co' });
    expect(m.subcontractorId).toBeNull();
  });

  it('returns no match when there is nothing to match against', () => {
    expect(matchSubcontractor([], { senderEmail: 'a@b.com', insuredName: 'X' }).subcontractorId)
      .toBeNull();
    expect(matchSubcontractor(SUBS, {}).subcontractorId).toBeNull();
  });
});
