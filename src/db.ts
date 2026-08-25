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
  primary_contact_name: string | null;
  inbound_alias: string;
  slack_webhook_url: string | null;
  status: 'active' | 'paused' | 'past_due';
  require_holder_match: boolean;
  holder_aliases: string[] | null;
}

export interface Subcontractor {
  id: string;
  company_id: string;
  vendor_name: string;
  contact_email: string;
  contact_person: string | null;
  trade: string | null;
  upload_token: string;
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

/** One row of work for the chase cron. */
export interface ChaseRow {
  id: string;
  company_id: string;
  vendor_name: string;
  contact_email: string;
  upload_token: string;
  last_chase_stage: number | null;
  last_chased_at: string | null;
  active_cert_id: string | null;
  company_name: string;
  primary_contact_email: string;
  expiration_date: string | null;
  compliance_status: 'missing' | 'expired' | 'expiring_soon' | 'compliant';
  days_remaining: number | null;
}

/** One row of the client's compliance grid. */
export interface DashboardRow {
  id: string;
  company_id: string;
  vendor_name: string;
  trade: string | null;
  contact_person: string | null;
  contact_email: string;
  last_chased_at: string | null;
  last_chase_stage: number | null;
  certificate_id: string | null;
  expiration_date: string | null;
  carrier_name: string | null;
  gl_policy_number: string | null;
  gl_each_occurrence: number | null;
  gl_general_aggregate: number | null;
  additional_insured: boolean | null;
  waiver_subrogation: boolean | null;
  reviewed_by: string | null;
  compliance_status: 'missing' | 'expired' | 'expiring_soon' | 'compliant';
  days_remaining: number | null;
}

export interface CertificateDetail extends CertificateRow {
  company_id: string;
  subcontractor_id: string | null;
  r2_key: string | null;
  original_filename: string | null;
  source: string;
  producer_name: string | null;
  insured_entity_name: string | null;
  carrier_name: string | null;
  gl_policy_number: string | null;
  gl_each_occurrence: number | null;
  gl_general_aggregate: number | null;
  additional_insured: boolean | null;
  waiver_subrogation: boolean | null;
  certificate_holder_text: string | null;
  ai_confidence: number | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  companies: Company;
  subcontractors: Subcontractor | null;
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

  async companyByAlias(alias: string): Promise<Company | null> {
    const rows = await this.request<Company[]>(
      `/companies?inbound_alias=eq.${encodeURIComponent(alias)}&select=*&limit=1`,
    );
    return rows[0] ?? null;
  }

  async subcontractorById(id: string): Promise<Subcontractor | null> {
    const rows = await this.request<Subcontractor[]>(
      `/subcontractors?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    );
    return rows[0] ?? null;
  }

  /** Match candidates for one client. Only the fields matching needs. */
  async subcontractorsForCompany(companyId: string): Promise<
    { id: string; vendor_name: string; contact_email: string }[]
  > {
    return this.request(
      `/subcontractors?company_id=eq.${encodeURIComponent(companyId)}` +
        `&select=id,vendor_name,contact_email`,
    );
  }

  /** Everything the review screen shows, in one round trip. */
  async certificateDetail(id: string): Promise<CertificateDetail | null> {
    const rows = await this.request<CertificateDetail[]>(
      `/certificates?id=eq.${encodeURIComponent(id)}` +
        `&select=*,companies(*),subcontractors(*)&limit=1`,
    );
    return rows[0] ?? null;
  }

  /**
   * Has this client already been sent this exact file?
   *
   * Scoped by company: two general contractors holding the same vendor's
   * certificate is normal, and is not a duplicate of anything.
   */
  async findByContentHash(companyId: string, sha: string): Promise<CertificateRow | null> {
    const rows = await this.request<CertificateRow[]>(
      `/certificates?company_id=eq.${encodeURIComponent(companyId)}` +
        `&content_sha256=eq.${encodeURIComponent(sha)}` +
        `&select=id,verification_status,failure_reasons,expiration_date,created_at` +
        `&order=created_at.desc&limit=1`,
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

  /** Vendors due a chase today, soonest expiry first. */
  async chaseQueue(limit: number): Promise<ChaseRow[]> {
    return this.request<ChaseRow[]>(
      `/v_chase_queue?select=*&order=days_remaining.asc.nullsfirst&limit=${limit}`,
    );
  }

  async recordChase(subcontractorId: string, stage: number, now: Date): Promise<void> {
    await this.request(`/subcontractors?id=eq.${encodeURIComponent(subcontractorId)}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ last_chase_stage: stage, last_chased_at: now.toISOString() }),
    });
  }

  /** Mark a lapsed certificate expired and clear the vendor's active link. */
  async expireCertificate(certificateId: string, subcontractorId: string): Promise<void> {
    await this.request(`/certificates?id=eq.${encodeURIComponent(certificateId)}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ verification_status: 'expired' }),
    });
    await this.request(`/subcontractors?id=eq.${encodeURIComponent(subcontractorId)}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ active_cert_id: null }),
    });
  }

  async dashboard(companyId: string): Promise<DashboardRow[]> {
    return this.request<DashboardRow[]>(
      `/v_dashboard?company_id=eq.${encodeURIComponent(companyId)}` +
        `&select=*&order=days_remaining.asc.nullsfirst`,
    );
  }

  async companyById(id: string): Promise<Company | null> {
    const rows = await this.request<Company[]>(
      `/companies?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    );
    return rows[0] ?? null;
  }

  async pendingReview(companyId: string): Promise<CertificateDetail[]> {
    return this.request<CertificateDetail[]>(
      `/certificates?company_id=eq.${encodeURIComponent(companyId)}` +
        `&verification_status=eq.pending_review` +
        `&select=*,companies(*),subcontractors(*)&order=created_at.desc&limit=100`,
    );
  }

  async recentActivity(companyId: string, limit = 200): Promise<
    { action: string; actor: string; created_at: string; details: unknown }[]
  > {
    return this.request(
      `/audit_logs?company_id=eq.${encodeURIComponent(companyId)}` +
        `&select=action,actor,created_at,details&order=created_at.desc&limit=${limit}`,
    );
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
