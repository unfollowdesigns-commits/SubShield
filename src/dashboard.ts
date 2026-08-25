import type { CertificateDetail, Company, DashboardRow } from './db';
import { FAILURE_TEXT } from './validate';
import type { FailureReason } from './types';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const money = (n: number | null) => (n == null ? '—' : `$${n.toLocaleString('en-US')}`);

const STATUS_LABEL: Record<DashboardRow['compliance_status'], string> = {
  compliant: 'Compliant',
  expiring_soon: 'Expiring soon',
  expired: 'Expired',
  missing: 'No certificate',
};

export interface Totals {
  compliant: number;
  expiring_soon: number;
  expired: number;
  missing: number;
  total: number;
}

export function tally(rows: DashboardRow[]): Totals {
  const t: Totals = { compliant: 0, expiring_soon: 0, expired: 0, missing: 0, total: rows.length };
  for (const r of rows) t[r.compliance_status]++;
  return t;
}

/** Red first. An office manager opens this to find what is wrong, not what is fine. */
export function byUrgency(rows: DashboardRow[]): DashboardRow[] {
  const rank: Record<DashboardRow['compliance_status'], number> = {
    expired: 0, missing: 1, expiring_soon: 2, compliant: 3,
  };
  return [...rows].sort(
    (a, b) =>
      rank[a.compliance_status] - rank[b.compliance_status] ||
      (a.days_remaining ?? -9999) - (b.days_remaining ?? -9999) ||
      a.vendor_name.localeCompare(b.vendor_name),
  );
}

const STYLE = `
  :root { color-scheme: light dark;
    --bg:#f6f7f9; --card:#fff; --ink:#14171c; --muted:#5b6472; --line:#dfe3e9;
    --accent:#1c5cd6; --ok:#0f7b46; --warn:#8a5a00; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#12151a; --card:#1a1f27; --ink:#e9edf3; --muted:#9aa5b4; --line:#2a323d;
    --accent:#6f9cf5; --ok:#4ec98a; --warn:#e0b062; --bad:#f2907f; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  .page { max-width:1080px; margin:0 auto; padding:28px 24px 60px; }
  header { display:flex; justify-content:space-between; align-items:baseline;
           flex-wrap:wrap; gap:12px; margin-bottom:24px; }
  h1 { font-size:1.3rem; margin:0; }
  .muted { color:var(--muted); font-size:.85rem; margin:2px 0 0; }
  nav { display:flex; gap:6px; margin-bottom:22px; flex-wrap:wrap; }
  nav a { padding:7px 13px; border-radius:999px; border:1px solid var(--line);
          text-decoration:none; color:var(--ink); font-size:.88rem; background:var(--card); }
  nav a[aria-current] { background:var(--accent); border-color:var(--accent); color:#fff; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr));
           gap:12px; margin-bottom:24px; }
  .tile { background:var(--card); border:1px solid var(--line); border-radius:10px;
          padding:14px 16px; }
  .tile b { display:block; font-size:1.7rem; font-weight:650; line-height:1.1; }
  .tile span { font-size:.8rem; color:var(--muted); }
  .tile.bad b { color:var(--bad); } .tile.warn b { color:var(--warn); }
  .tile.ok b { color:var(--ok); }
  table { width:100%; border-collapse:collapse; background:var(--card);
          border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .scroll { overflow-x:auto; }
  th, td { text-align:left; padding:11px 14px; border-bottom:1px solid var(--line);
           font-size:.9rem; white-space:nowrap; }
  th { font-size:.75rem; text-transform:uppercase; letter-spacing:.05em;
       color:var(--muted); font-weight:600; }
  tr:last-child td { border-bottom:0; }
  .pill { display:inline-block; padding:2px 9px; border-radius:999px;
          font-size:.75rem; font-weight:600; }
  .pill.compliant { background:rgba(15,123,70,.12); color:var(--ok); }
  .pill.expiring_soon { background:rgba(138,90,0,.14); color:var(--warn); }
  .pill.expired, .pill.missing { background:rgba(179,38,30,.12); color:var(--bad); }
  .empty { background:var(--card); border:1px solid var(--line); border-radius:10px;
           padding:36px; text-align:center; color:var(--muted); }
  .rule { font-size:.85rem; color:var(--muted); margin:18px 0 0; }
  @media print {
    nav, .noprint { display:none !important; }
    body { background:#fff; color:#000; }
    .tile, table, .empty { border-color:#bbb; }
    th, td { white-space:normal; }
  }
`;

function shell(title: string, company: Company, tab: string, token: string, body: string): string {
  const link = (href: string, label: string, id: string) =>
    `<a href="${href}?t=${encodeURIComponent(token)}"${
      tab === id ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} — ${escape(company.company_name)}</title>
<style>${STYLE}</style></head>
<body><div class="page">
<header>
  <div>
    <h1>${escape(company.company_name)}</h1>
    <p class="muted">Subcontractor insurance compliance</p>
  </div>
  <p class="muted">${new Date().toISOString().slice(0, 10)}</p>
</header>
<nav>
  ${link('/dash', 'Compliance grid', 'grid')}
  ${link('/dash/exceptions', 'Needs review', 'exceptions')}
  ${link('/dash/report', 'Audit report', 'report')}
</nav>
${body}
</div></body></html>`;
}

export function renderGrid(company: Company, rows: DashboardRow[], token: string): string {
  const t = tally(rows);
  const tiles = `<div class="tiles">
    <div class="tile bad"><b>${t.expired + t.missing}</b><span>Not covered</span></div>
    <div class="tile warn"><b>${t.expiring_soon}</b><span>Expiring within 30 days</span></div>
    <div class="tile ok"><b>${t.compliant}</b><span>Compliant</span></div>
    <div class="tile"><b>${t.total}</b><span>Vendors tracked</span></div>
  </div>`;

  const body = rows.length === 0
    ? `${tiles}<div class="empty">No subcontractors yet.</div>`
    : `${tiles}<div class="scroll"><table>
        <thead><tr>
          <th>Vendor</th><th>Trade</th><th>Status</th><th>Expires</th>
          <th>Days</th><th>Each occurrence</th><th>Aggregate</th><th>Last chased</th>
        </tr></thead><tbody>
        ${byUrgency(rows).map((r) => `<tr>
          <td>${escape(r.vendor_name)}</td>
          <td>${escape(r.trade ?? '—')}</td>
          <td><span class="pill ${r.compliance_status}">${STATUS_LABEL[r.compliance_status]}</span></td>
          <td>${escape(r.expiration_date ?? '—')}</td>
          <td>${r.days_remaining == null ? '—' : r.days_remaining}</td>
          <td>${money(r.gl_each_occurrence)}</td>
          <td>${money(r.gl_general_aggregate)}</td>
          <td>${escape(r.last_chased_at?.slice(0, 10) ?? 'never')}</td>
        </tr>`).join('')}
        </tbody></table></div>`;

  return shell('Compliance', company, 'grid', token, body);
}

export function renderExceptions(
  company: Company,
  certs: CertificateDetail[],
  links: Map<string, string>,
  token: string,
): string {
  const body = certs.length === 0
    ? `<div class="empty">Nothing is waiting on you.</div>`
    : `<div class="scroll"><table>
        <thead><tr><th>Vendor</th><th>Received</th><th>Why it stopped</th><th></th></tr></thead>
        <tbody>${certs.map((c) => `<tr>
          <td>${escape(c.subcontractors?.vendor_name ?? c.insured_entity_name ?? 'Unidentified')}</td>
          <td>${escape(c.created_at.slice(0, 10))}</td>
          <td style="white-space:normal">${(c.failure_reasons ?? [])
            .map((r) => escape(FAILURE_TEXT[r as FailureReason] ?? String(r)))
            .join('; ')}</td>
          <td><a href="/review/${c.id}?t=${encodeURIComponent(links.get(c.id) ?? '')}">Review</a></td>
        </tr>`).join('')}</tbody></table></div>`;

  return shell('Needs review', company, 'exceptions', token, body);
}

/**
 * The audit report.
 *
 * Print-optimised HTML rather than a generated PDF: a Worker has no PDF engine,
 * and every browser prints to PDF for free. The auditor gets the same document
 * either way, and the stack stays at zero dependencies.
 */
export function renderReport(
  company: Company,
  rows: DashboardRow[],
  activity: { action: string; actor: string; created_at: string; details: unknown }[],
  token: string,
): string {
  const t = tally(rows);
  const body = `
  <p class="noprint muted">Use your browser's print dialog and choose “Save as PDF”.
     <button onclick="window.print()" style="margin-left:8px">Print</button></p>

  <div class="tiles">
    <div class="tile ok"><b>${t.compliant}</b><span>Compliant</span></div>
    <div class="tile warn"><b>${t.expiring_soon}</b><span>Expiring within 30 days</span></div>
    <div class="tile bad"><b>${t.expired + t.missing}</b><span>Not covered</span></div>
  </div>

  <p class="rule">Requirements in force: general liability each occurrence
    ${money(company.min_gl_each_occurrence)}, general aggregate
    ${money(company.min_gl_aggregate)}${
      company.require_additional_insured ? ', additional insured' : ''}${
      company.require_waiver_subrogation ? ', waiver of subrogation' : ''}.</p>

  <h2 style="font-size:1rem;margin:26px 0 10px">Vendor status</h2>
  <div class="scroll"><table>
    <thead><tr>
      <th>Vendor</th><th>Status</th><th>Carrier</th><th>Policy</th>
      <th>Each occurrence</th><th>Aggregate</th><th>AI</th><th>WoS</th><th>Expires</th>
    </tr></thead>
    <tbody>${byUrgency(rows).map((r) => `<tr>
      <td>${escape(r.vendor_name)}</td>
      <td><span class="pill ${r.compliance_status}">${STATUS_LABEL[r.compliance_status]}</span></td>
      <td>${escape(r.carrier_name ?? '—')}</td>
      <td>${escape(r.gl_policy_number ?? '—')}</td>
      <td>${money(r.gl_each_occurrence)}</td>
      <td>${money(r.gl_general_aggregate)}</td>
      <td>${r.additional_insured ? 'Yes' : '—'}</td>
      <td>${r.waiver_subrogation ? 'Yes' : '—'}</td>
      <td>${escape(r.expiration_date ?? '—')}</td>
    </tr>`).join('')}</tbody>
  </table></div>

  <h2 style="font-size:1rem;margin:26px 0 10px">Recent activity</h2>
  <div class="scroll"><table>
    <thead><tr><th>When</th><th>Action</th><th>By</th></tr></thead>
    <tbody>${activity.slice(0, 100).map((a) => `<tr>
      <td>${escape(a.created_at.slice(0, 16).replace('T', ' '))}</td>
      <td>${escape(a.action.replace(/_/g, ' '))}</td>
      <td>${escape(a.actor)}</td>
    </tr>`).join('')}</tbody>
  </table></div>

  <p class="rule">Generated by SubShield on ${new Date().toISOString().slice(0, 10)}.
    Status is derived from the certificates on file and reflects what was
    submitted; it is not an opinion on the adequacy of any policy.</p>`;

  return shell('Audit report', company, 'report', token, body);
}
