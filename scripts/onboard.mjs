#!/usr/bin/env node
/**
 * Day-0 client provisioning.
 *
 *   node scripts/onboard.mjs --name "Apex Builders Group" \
 *        --email ops@apex.example --alias apex-certs --subs vendors.csv
 *
 * Creates the company, imports the subcontractor list, generates an upload
 * token per vendor, and prints the links to send out. Re-running with the same
 * alias updates the company and adds only vendors that are new, so a client
 * who sends a longer list next week does not get duplicates.
 *
 * The CSV needs a header row. Recognised columns:
 *   vendor_name (or name), contact_email (or email), contact_person, trade, contact_phone
 *
 * Environment: SUPABASE_URL, SUPABASE_SERVICE_KEY, and optionally APP_URL.
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_URL = (process.env.APP_URL ?? 'https://app.subshield.io').replace(/\/$/, '');

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY first.');
  process.exit(1);
}

const name = args.get('name');
const email = args.get('email');
const alias = args.get('alias') ?? slug(name ?? '');
if (!name || !email) {
  console.error('Usage: --name "Company" --email ops@company.com [--alias company-certs]');
  console.error('       [--subs vendors.csv] [--min-occurrence 1000000] [--min-aggregate 2000000]');
  process.exit(1);
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-certs';
}

async function api(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** Minimal CSV reader: quoted fields, embedded commas and doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const pick = (cells, ...names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1 && cells[i]?.trim()) return cells[i].trim();
    }
    return null;
  };
  return rows.slice(1)
    .filter((cells) => cells.some((c) => c.trim()))
    .map((cells) => ({
      vendor_name: pick(cells, 'vendor_name', 'name', 'vendor', 'company'),
      contact_email: pick(cells, 'contact_email', 'email'),
      contact_person: pick(cells, 'contact_person', 'contact'),
      contact_phone: pick(cells, 'contact_phone', 'phone'),
      trade: pick(cells, 'trade'),
    }))
    .filter((v) => v.vendor_name && v.contact_email);
}

const token = () => randomBytes(24).toString('base64url');

// ─── company ────────────────────────────────────────────────────────────────
const existing = await api(`/companies?inbound_alias=eq.${encodeURIComponent(alias)}&select=*`);
const fields = {
  company_name: name,
  primary_contact_email: email,
  primary_contact_name: args.get('contact') ?? null,
  inbound_alias: alias,
  min_gl_each_occurrence: Number(args.get('min-occurrence') ?? 1_000_000),
  min_gl_aggregate: Number(args.get('min-aggregate') ?? 2_000_000),
  slack_webhook_url: args.get('slack') ?? null,
  status: 'active',
};

const company = existing.length
  ? (await api(`/companies?id=eq.${existing[0].id}`, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify(fields),
    }))[0]
  : (await api('/companies', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify(fields),
    }))[0];

console.log(`${existing.length ? 'Updated' : 'Created'} ${company.company_name}`);
console.log(`  Inbound address:  ${alias}@process.subshield.io`);

// ─── subcontractors ─────────────────────────────────────────────────────────
const csvPath = args.get('subs');
if (csvPath) {
  const vendors = parseCsv(readFileSync(csvPath, 'utf8'));
  const known = await api(
    `/subcontractors?company_id=eq.${company.id}&select=contact_email`,
  );
  const seen = new Set(known.map((k) => k.contact_email.toLowerCase()));

  const fresh = vendors
    .filter((v) => !seen.has(v.contact_email.toLowerCase()))
    .map((v) => ({ ...v, company_id: company.id, upload_token: token() }));

  if (fresh.length) {
    // PostgREST caps request size; insert in modest chunks.
    for (let i = 0; i < fresh.length; i += 50) {
      await api('/subcontractors', {
        method: 'POST',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify(fresh.slice(i, i + 50)),
      });
    }
  }
  console.log(`  Vendors:          ${vendors.length} in file, ${fresh.length} added, ` +
              `${vendors.length - fresh.length} already known`);
}

// ─── the links to send ──────────────────────────────────────────────────────
const all = await api(
  `/subcontractors?company_id=eq.${company.id}&select=vendor_name,contact_email,upload_token` +
  `&order=vendor_name.asc`,
);
console.log(`\nUpload links (${all.length}):`);
for (const s of all) {
  console.log(`  ${s.vendor_name}\t${s.contact_email}\t${APP_URL}/u/${s.upload_token}`);
}
console.log(`\nDashboard link: run scripts/dashboard-link.mjs --company ${company.id}`);
