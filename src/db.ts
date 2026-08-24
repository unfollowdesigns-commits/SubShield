import type { FailureReason, Requirements, VerificationStatus } from './types';

/**
 * Supabase over PostgREST rather than a Postgres driver.
 *
 * Drivers need connection pooling, which on Cloudflare means Hyperdrive, which
 * means the paid Workers plan. This is plain fetch with no dependencies and
 * costs nothing.
 */
export interface DbConfig {
  url: string;
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

export interface Company extends Requirements {
  id: string;
  company_name: string;
  primary_contact_email: string;
  inbound_alias: string;
  slack_webhook_url: string | null;
  status: 'active' | 'paused' | 'past_due';
}

export interface Subcontractor {
  id: string;
  company_id: string;
  vendor_name: string;
  contact_email: string;
  contact_person: string | null;
  trade: string | null;
  active_cert_id: string | null;
}

export interface SubcontractorWithCompany extends Subcontractor {
  companies: Company;
}

export interface CertificateRow {
  id: string;
  verification_status: VerificationStatus;
  failure_reasons: FailureReason[] | null;
  expiration_date: string | null;
  created_at: string;
}

export class Db {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: DbConfig) {
    this.base = `${cfg.url.replace(/\/$/, '')}/rest/v1`;
    this.headers = {
      apikey: cfg.serviceKey,
      authorization: `Bearer ${cfg.serviceKey}`,
      'content-type': 'application/json',
    };
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      ...init,
      headers: { ...this.headers, ...(init.headers as Record<string, string>) },
    });
    if (!res.ok) {
      throw new Error(`Database request failed (${res.status}): ${await res.text()}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  /** The upload token is the subcontractor's only credential. */
  async subcontractorByToken(token: string): Promise<SubcontractorWithCompany | null> {
    const rows = await this.request<SubcontractorWithCompany[]>(
      `/subcontractors?upload_token=eq.${encodeURIComponent(token)}` +
        `&select=*,companies(*)&limit=1`,
    );
    return rows[0] ?? null;
  }

  async insertCertificate(row: Record<string, unknown>): Promise<CertificateRow> {
    const rows = await this.request<CertificateRow[]>('/certificates', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    return rows[0]!;
  }

  async updateCertificate(id: string, patch: Record<string, unknown>): Promise<CertificateRow> {
    const rows = await this.request<CertificateRow[]>(
      `/certificates?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify(patch),
      },
    );
    return rows[0]!;
  }

  async certificateStatus(id: string, companyId: string): Promise<CertificateRow | null> {
    // Scoped by company_id, always. Never trust an id from a request alone.
    const rows = await this.request<CertificateRow[]>(
      `/certificates?id=eq.${encodeURIComponent(id)}` +
        `&company_id=eq.${encodeURIComponent(companyId)}` +
        `&select=id,verification_status,failure_reasons,expiration_date,created_at&limit=1`,
    );
    return rows[0] ?? null;
  }

  /** Retire whatever this vendor had on file, then promote the new certificate. */
  async promoteCertificate(subcontractorId: string, certificateId: string): Promise<void> {
    await this.request(
      `/certificates?subcontractor_id=eq.${encodeURIComponent(subcontractorId)}` +
        `&verification_status=eq.auto_approved&id=neq.${encodeURIComponent(certificateId)}`,
      {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ verification_status: 'superseded' }),
      },
    );
    await this.request(`/subcontractors?id=eq.${encodeURIComponent(subcontractorId)}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ active_cert_id: certificateId }),
    });
  }

  /** Every state change gets a row. The audit trail is the product. */
  async log(entry: {
    company_id: string;
    certificate_id?: string | null;
    subcontractor_id?: string | null;
    action: string;
    actor?: string;
    details?: unknown;
  }): Promise<void> {
    await this.request('/audit_logs', {
      method: 'POST',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ actor: 'system', ...entry }),
    });
  }
}
