import type { CertificateDetail, Db } from './db';
import { FAILURE_TEXT, validate } from './validate';
import type { Extraction, FailureReason } from './types';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The reviewer's edits, as they come back off the form. */
export interface ReviewEdits {
  gl_each_occurrence: number | null;
  gl_general_aggregate: number | null;
  expiration_date: string | null;
  additional_insured: boolean;
  waiver_subrogation: boolean;
  insured_entity_name: string | null;
  gl_policy_number: string | null;
}

const num = (v: string | null): number | null => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

const text = (v: string | null): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};

export function editsFromForm(form: FormData): ReviewEdits {
  return {
    gl_each_occurrence: num(form.get('gl_each_occurrence')),
    gl_general_aggregate: num(form.get('gl_general_aggregate')),
    expiration_date: text(form.get('expiration_date')),
    additional_insured: form.get('additional_insured') === 'on',
    waiver_subrogation: form.get('waiver_subrogation') === 'on',
    insured_entity_name: text(form.get('insured_entity_name')),
    gl_policy_number: text(form.get('gl_policy_number')),
  };
}

/**
 * Re-run the real checks against what the reviewer says the document says.
 *
 * A human correcting a misread field goes through exactly the same validation
 * as the model did — the only way past a failed check is a recorded override.
 */
export function validateEdits(
  edits: ReviewEdits,
  cert: CertificateDetail,
  now: Date = new Date(),
): FailureReason[] {
  const asExtraction: Extraction = {
    document_type: 'acord_25',
    producer_name: cert.producer_name,
    insured_entity_name: edits.insured_entity_name,
    carrier_name: cert.carrier_name,
    gl_policy_number: edits.gl_policy_number,
    gl_each_occurrence_limit: edits.gl_each_occurrence,
    gl_general_aggregate_limit: edits.gl_general_aggregate,
    gl_expiration_date: edits.expiration_date,
    additional_insured_included: edits.additional_insured,
    waiver_of_subrogation_included: edits.waiver_subrogation,
    certificate_holder_text: cert.certificate_holder_text,
    // A human read it, so legibility is no longer in question.
    confidence_score: 1,
  };
  return validate(asExtraction, cert.companies, now);
}

const money = (n: number | null) => (n == null ? '' : String(n));

export function renderReviewPage(
  cert: CertificateDetail,
  token: string,
  notice?: { kind: 'error' | 'done'; text: string },
): string {
  const co = cert.companies;
  const vendor = cert.subcontractors?.vendor_name ?? cert.insured_entity_name ?? 'Unidentified vendor';
  const reasons = (cert.failure_reasons ?? []).map(
    (r) => FAILURE_TEXT[r as FailureReason] ?? String(r),
  );
  const settled = cert.verification_status !== 'pending_review';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review — ${escape(vendor)}</title>
<style>
  :root { color-scheme: light dark;
    --bg:#f6f7f9; --card:#fff; --ink:#14171c; --muted:#5b6472; --line:#dfe3e9;
    --accent:#1c5cd6; --ok:#0f7b46; --bad:#b3261e; --warn:#8a5a00; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#12151a; --card:#1a1f27; --ink:#e9edf3; --muted:#9aa5b4; --line:#2a323d;
    --accent:#6f9cf5; --ok:#4ec98a; --bad:#f2907f; --warn:#e0b062; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { padding:16px 24px; border-bottom:1px solid var(--line); background:var(--card); }
  header h1 { margin:0; font-size:1.1rem; }
  header p { margin:2px 0 0; color:var(--muted); font-size:.85rem; }
  .wrap { display:grid; grid-template-columns:1fr 420px; gap:0; min-height:calc(100vh - 66px); }
  @media (max-width:900px) { .wrap { grid-template-columns:1fr; } }
  .doc { background:#33383f; display:flex; align-items:stretch; }
  .doc iframe, .doc img { width:100%; height:100%; min-height:70vh; border:0;
                          object-fit:contain; background:#33383f; }
  .panel { background:var(--card); border-left:1px solid var(--line);
           padding:24px; overflow-y:auto; }
  .flags { background:rgba(179,38,30,.08); border:1px solid var(--bad);
           border-radius:8px; padding:12px 14px; margin:0 0 20px; }
  .flags h2 { margin:0 0 8px; font-size:.78rem; text-transform:uppercase;
              letter-spacing:.06em; color:var(--bad); }
  .flags ul { margin:0; padding-left:18px; font-size:.9rem; }
  .notice { border-radius:8px; padding:12px 14px; margin:0 0 20px; font-size:.9rem; }
  .notice.error { background:rgba(179,38,30,.08); border:1px solid var(--bad); }
  .notice.done { background:rgba(15,123,70,.08); border:1px solid var(--ok); }
  label { display:block; margin:0 0 14px; font-size:.85rem; color:var(--muted); }
  label span { display:block; margin-bottom:4px; }
  input[type=text], input[type=date], textarea {
    width:100%; padding:8px 10px; font:inherit; color:var(--ink);
    background:var(--bg); border:1px solid var(--line); border-radius:6px; }
  .row { display:flex; gap:10px; align-items:center; margin:0 0 12px; font-size:.9rem; }
  .row input { width:16px; height:16px; }
  .req { color:var(--muted); font-size:.8rem; margin:-8px 0 16px; }
  button { font:inherit; padding:10px 14px; border-radius:6px; cursor:pointer;
           border:1px solid var(--line); background:var(--bg); color:var(--ink); width:100%; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { border-color:var(--bad); color:var(--bad); }
  .actions { display:grid; gap:8px; margin-top:20px;
             padding-top:20px; border-top:1px solid var(--line); }
  details { margin-top:16px; font-size:.85rem; color:var(--muted); }
  details textarea { margin-top:8px; min-height:60px; }
</style>
</head>
<body>
<header>
  <h1>${escape(vendor)}</h1>
  <p>${escape(co.company_name)} · received ${escape(cert.created_at.slice(0, 10))} ·
     via ${escape(cert.source)}${cert.ai_confidence == null ? '' :
       ` · confidence ${cert.ai_confidence.toFixed(2)}`}</p>
</header>

<div class="wrap">
  <div class="doc">
    ${cert.r2_key
      ? `<iframe src="/review/${cert.id}/doc?t=${encodeURIComponent(token)}"
                title="The certificate as received"></iframe>`
      : `<p style="color:#fff;padding:24px">The original document is unavailable.</p>`}
  </div>

  <div class="panel">
    ${notice ? `<div class="notice ${notice.kind}">${escape(notice.text)}</div>` : ''}

    ${settled
      ? `<div class="notice done">This certificate is already
         <strong>${escape(cert.verification_status.replace('_', ' '))}</strong>${
           cert.reviewed_by ? `, reviewed by ${escape(cert.reviewed_by)}` : ''}.</div>`
      : reasons.length
        ? `<div class="flags"><h2>Failed checks</h2><ul>${
            reasons.map((r) => `<li>${escape(r)}</li>`).join('')}</ul></div>`
        : ''}

    <form method="post" action="/review/${cert.id}?t=${encodeURIComponent(token)}">
      <label><span>Insured entity</span>
        <input type="text" name="insured_entity_name"
               value="${escape(cert.insured_entity_name ?? '')}"></label>
      <label><span>Policy number</span>
        <input type="text" name="gl_policy_number"
               value="${escape(cert.gl_policy_number ?? '')}"></label>
      <label><span>Each occurrence</span>
        <input type="text" name="gl_each_occurrence"
               value="${money(cert.gl_each_occurrence)}"></label>
      <p class="req">Requires ${co.min_gl_each_occurrence.toLocaleString('en-US')}</p>
      <label><span>General aggregate</span>
        <input type="text" name="gl_general_aggregate"
               value="${money(cert.gl_general_aggregate)}"></label>
      <p class="req">Requires ${co.min_gl_aggregate.toLocaleString('en-US')}</p>
      <label><span>Expiration date</span>
        <input type="date" name="expiration_date"
               value="${escape(cert.expiration_date ?? '')}"></label>

      <div class="row">
        <input type="checkbox" id="ai" name="additional_insured"
               ${cert.additional_insured ? 'checked' : ''}>
        <label for="ai" style="margin:0">Additional insured${
          co.require_additional_insured ? ' (required)' : ''}</label>
      </div>
      <div class="row">
        <input type="checkbox" id="ws" name="waiver_subrogation"
               ${cert.waiver_subrogation ? 'checked' : ''}>
        <label for="ws" style="margin:0">Waiver of subrogation${
          co.require_waiver_subrogation ? ' (required)' : ''}</label>
      </div>

      <label><span>Your name or email</span>
        <input type="text" name="reviewer" required placeholder="who is deciding this"></label>

      <div class="actions">
        <button class="primary" name="action" value="approve" ${settled ? 'disabled' : ''}>
          Approve with these values</button>
        <button name="action" value="reject" class="danger" ${settled ? 'disabled' : ''}>
          Reject and request a corrected certificate</button>
      </div>

      <details>
        <summary>Approve anyway, despite a failed check</summary>
        <p>An override is recorded against your name with the reason you give.
           Use it when you have a decision from the client, not to clear the queue.</p>
        <textarea name="override_reason" placeholder="Why is this acceptable?"></textarea>
        <button name="action" value="override" style="margin-top:8px" ${settled ? 'disabled' : ''}>
          Record an override</button>
      </details>
    </form>
  </div>
</div>
</body>
</html>`;
}

/** Apply a reviewer's decision. Returns what to tell them. */
export async function applyDecision(
  cert: CertificateDetail,
  form: FormData,
  db: Db,
  now: Date = new Date(),
): Promise<{ kind: 'error' | 'done'; text: string }> {
  const action = String(form.get('action') ?? '');
  const reviewer = String(form.get('reviewer') ?? '').trim();
  if (!reviewer) return { kind: 'error', text: 'Add your name or email before deciding.' };
  if (cert.verification_status !== 'pending_review') {
    return { kind: 'error', text: 'This certificate has already been decided.' };
  }

  const edits = editsFromForm(form);
  const patch = {
    insured_entity_name: edits.insured_entity_name,
    gl_policy_number: edits.gl_policy_number,
    gl_each_occurrence: edits.gl_each_occurrence,
    gl_general_aggregate: edits.gl_general_aggregate,
    expiration_date: edits.expiration_date,
    additional_insured: edits.additional_insured,
    waiver_subrogation: edits.waiver_subrogation,
    reviewed_by: reviewer,
    reviewed_at: now.toISOString(),
  };

  if (action === 'reject') {
    await db.updateCertificate(cert.id, { ...patch, verification_status: 'rejected' });
    await db.log({
      company_id: cert.company_id,
      certificate_id: cert.id,
      subcontractor_id: cert.subcontractor_id,
      action: 'rejected',
      actor: reviewer,
      details: { failure_reasons: cert.failure_reasons },
    });
    return { kind: 'done', text: 'Rejected. The subcontractor has been asked for a corrected certificate.' };
  }

  if (action === 'override') {
    const reason = String(form.get('override_reason') ?? '').trim();
    if (!reason) return { kind: 'error', text: 'An override needs a reason on the record.' };
    if (!cert.subcontractor_id) {
      return { kind: 'error', text: 'Assign this certificate to a vendor before approving it.' };
    }
    await db.updateCertificate(cert.id, { ...patch, verification_status: 'auto_approved', failure_reasons: null });
    await db.promoteCertificate(cert.subcontractor_id, cert.id);
    await db.log({
      company_id: cert.company_id,
      certificate_id: cert.id,
      subcontractor_id: cert.subcontractor_id,
      action: 'override',
      actor: reviewer,
      details: { reason, overridden_failures: cert.failure_reasons },
    });
    return { kind: 'done', text: 'Override recorded. The vendor is marked compliant.' };
  }

  if (action === 'approve') {
    const failures = validateEdits(edits, cert, now);
    if (failures.length) {
      return {
        kind: 'error',
        text:
          'These values still fail: ' +
          failures.map((f) => FAILURE_TEXT[f]).join('; ') +
          '. Correct them, or record an override.',
      };
    }
    if (!cert.subcontractor_id) {
      return { kind: 'error', text: 'Assign this certificate to a vendor before approving it.' };
    }
    await db.updateCertificate(cert.id, { ...patch, verification_status: 'auto_approved', failure_reasons: null });
    await db.promoteCertificate(cert.subcontractor_id, cert.id);
    await db.log({
      company_id: cert.company_id,
      certificate_id: cert.id,
      subcontractor_id: cert.subcontractor_id,
      action: 'approved',
      actor: reviewer,
      details: { corrected_from_ai: true },
    });
    return { kind: 'done', text: 'Approved. The vendor is marked compliant.' };
  }

  return { kind: 'error', text: 'Unrecognised action.' };
}
