import { describe, expect, it } from 'vitest';
import { editsFromForm, validateEdits } from '../src/review';
import { pickAttachment, type Attachment } from '../src/email';
import type { CertificateDetail } from '../src/db';

const NOW = new Date('2026-06-15T12:00:00Z');

const COMPANY = {
  id: 'co-1',
  company_name: 'Apex Builders Group',
  primary_contact_email: 'ops@apex.example',
  primary_contact_name: 'Dana Reyes',
  inbound_alias: 'apex-certs',
  slack_webhook_url: null,
  status: 'active' as const,
  require_holder_match: false,
  holder_aliases: null,
  min_gl_each_occurrence: 1_000_000,
  min_gl_aggregate: 2_000_000,
  require_additional_insured: true,
  require_waiver_subrogation: true,
};

function cert(over: Partial<CertificateDetail> = {}): CertificateDetail {
  return {
    id: 'cert-1',
    company_id: 'co-1',
    subcontractor_id: 'sub-1',
    verification_status: 'pending_review',
    failure_reasons: ['occurrence_limit_below_minimum'],
    r2_key: 'co-1/sub-1/x',
    original_filename: 'coi.pdf',
    source: 'email',
    producer_name: 'Hanover & Fifth',
    insured_entity_name: 'Tri-County Plumbing Inc',
    carrier_name: 'Travelers',
    gl_policy_number: 'GL-4471902',
    gl_each_occurrence: 500_000,
    gl_general_aggregate: 2_000_000,
    expiration_date: '2027-03-14',
    additional_insured: true,
    waiver_subrogation: true,
    certificate_holder_text: 'Apex Builders Group',
    ai_confidence: 0.93,
    reviewed_by: null,
    reviewed_at: null,
    created_at: '2026-06-15T09:00:00Z',
    companies: COMPANY,
    subcontractors: null,
    ...over,
  };
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

describe('editsFromForm', () => {
  it('strips currency formatting a reviewer types by habit', () => {
    const e = editsFromForm(form({ gl_each_occurrence: '$1,000,000' }));
    expect(e.gl_each_occurrence).toBe(1_000_000);
  });

  it('reads unchecked boxes as false, not missing', () => {
    const e = editsFromForm(form({}));
    expect(e.additional_insured).toBe(false);
    expect(e.waiver_subrogation).toBe(false);
  });

  it('treats blanks and unparseable numbers as null', () => {
    const e = editsFromForm(form({ gl_general_aggregate: 'n/a', insured_entity_name: '  ' }));
    expect(e.gl_general_aggregate).toBeNull();
    expect(e.insured_entity_name).toBeNull();
  });
});

describe('validateEdits', () => {
  const good = {
    gl_each_occurrence: '1000000',
    gl_general_aggregate: '2000000',
    expiration_date: '2027-03-14',
    additional_insured: 'on',
    waiver_subrogation: 'on',
    insured_entity_name: 'Tri-County Plumbing Inc',
    gl_policy_number: 'GL-4471902',
  };

  it('passes when the reviewer corrects a misread limit', () => {
    expect(validateEdits(editsFromForm(form(good)), cert(), NOW)).toEqual([]);
  });

  it('still fails when the reviewer types a genuinely deficient limit', () => {
    const edits = editsFromForm(form({ ...good, gl_each_occurrence: '500000' }));
    expect(validateEdits(edits, cert(), NOW)).toContain('occurrence_limit_below_minimum');
  });

  it('still fails an expired policy a human has confirmed', () => {
    const edits = editsFromForm(form({ ...good, expiration_date: '2026-01-01' }));
    expect(validateEdits(edits, cert(), NOW)).toContain('policy_expired');
  });

  it('still fails a missing endorsement the reviewer left unchecked', () => {
    const { additional_insured, ...rest } = good;
    void additional_insured;
    expect(validateEdits(editsFromForm(form(rest)), cert(), NOW))
      .toContain('missing_additional_insured');
  });

  it('does not fail on confidence — a human read it', () => {
    const edits = editsFromForm(form(good));
    expect(validateEdits(edits, cert({ ai_confidence: 0.11 }), NOW)).toEqual([]);
  });
});

describe('pickAttachment', () => {
  const bytes = (n: number) => new Uint8Array(n).fill(7);

  it('prefers a PDF over a larger image', () => {
    const picked = pickAttachment([
      { filename: 'logo.png', mimeType: 'image/png', content: bytes(900_000) },
      { filename: 'coi.pdf', mimeType: 'application/pdf', content: bytes(120_000) },
    ] as Attachment[]);
    expect(picked?.filename).toBe('coi.pdf');
  });

  it('takes the largest image when there is no PDF — a signature is never the scan', () => {
    const picked = pickAttachment([
      { filename: 'sig.png', mimeType: 'image/png', content: bytes(4_000) },
      { filename: 'scan.jpg', mimeType: 'image/jpeg', content: bytes(800_000) },
    ] as Attachment[]);
    expect(picked?.filename).toBe('scan.jpg');
  });

  it('falls back to the extension when the mime type is generic', () => {
    const picked = pickAttachment([
      { filename: 'certificate.pdf', mimeType: 'application/octet-stream', content: bytes(50_000) },
    ] as Attachment[]);
    expect(picked?.type).toBe('application/pdf');
  });

  it('ignores attachments that fail the guards', () => {
    expect(pickAttachment([
      { filename: 'terms.docx', mimeType: 'application/vnd.openxmlformats', content: bytes(10_000) },
      { filename: 'huge.pdf', mimeType: 'application/pdf', content: bytes(16 * 1024 * 1024) },
    ] as Attachment[])).toBeNull();
  });

  it('returns null for an email with nothing attached', () => {
    expect(pickAttachment([])).toBeNull();
  });
});
