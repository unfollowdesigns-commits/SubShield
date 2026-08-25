import { describe, expect, it } from 'vitest';
import { byUrgency, tally } from '../src/dashboard';
import type { DashboardRow } from '../src/db';

function row(over: Partial<DashboardRow>): DashboardRow {
  return {
    id: 'x', company_id: 'co-1', vendor_name: 'Vendor', trade: null,
    contact_person: null, contact_email: 'v@example.com',
    last_chased_at: null, last_chase_stage: null, certificate_id: 'c',
    expiration_date: '2027-01-01', carrier_name: null, gl_policy_number: null,
    gl_each_occurrence: 1_000_000, gl_general_aggregate: 2_000_000,
    additional_insured: true, waiver_subrogation: true, reviewed_by: null,
    compliance_status: 'compliant', days_remaining: 200,
    ...over,
  };
}

describe('tally', () => {
  it('counts every status', () => {
    const t = tally([
      row({ compliance_status: 'compliant' }),
      row({ compliance_status: 'compliant' }),
      row({ compliance_status: 'expiring_soon' }),
      row({ compliance_status: 'expired' }),
      row({ compliance_status: 'missing' }),
    ]);
    expect(t).toEqual({ compliant: 2, expiring_soon: 1, expired: 1, missing: 1, total: 5 });
  });

  it('handles an empty book of vendors', () => {
    expect(tally([])).toEqual({ compliant: 0, expiring_soon: 0, expired: 0, missing: 0, total: 0 });
  });
});

describe('byUrgency', () => {
  it('puts what is broken at the top, compliant at the bottom', () => {
    const sorted = byUrgency([
      row({ vendor_name: 'Fine', compliance_status: 'compliant', days_remaining: 300 }),
      row({ vendor_name: 'Soon', compliance_status: 'expiring_soon', days_remaining: 12 }),
      row({ vendor_name: 'Never sent', compliance_status: 'missing', days_remaining: null }),
      row({ vendor_name: 'Lapsed', compliance_status: 'expired', days_remaining: -4 }),
    ]);
    expect(sorted.map((r) => r.vendor_name)).toEqual(['Lapsed', 'Never sent', 'Soon', 'Fine']);
  });

  it('orders within a status by how soon it bites', () => {
    const sorted = byUrgency([
      row({ vendor_name: 'B', compliance_status: 'expiring_soon', days_remaining: 25 }),
      row({ vendor_name: 'A', compliance_status: 'expiring_soon', days_remaining: 3 }),
    ]);
    expect(sorted.map((r) => r.vendor_name)).toEqual(['A', 'B']);
  });

  it('does not mutate what it was given', () => {
    const rows = [row({ vendor_name: 'A', compliance_status: 'compliant' }),
                  row({ vendor_name: 'B', compliance_status: 'expired' })];
    byUrgency(rows);
    expect(rows[0]!.vendor_name).toBe('A');
  });
});
