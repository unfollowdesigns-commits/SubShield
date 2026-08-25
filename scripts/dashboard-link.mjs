#!/usr/bin/env node
/**
 * Mint a signed dashboard link for a client.
 *
 *   LINK_SECRET=... node scripts/dashboard-link.mjs --company <uuid> [--days 90]
 *
 * Same signing scheme as the Worker: HMAC-SHA256 over `dash:<companyId>:<exp>`.
 * Rotating LINK_SECRET invalidates every outstanding link.
 */

import { createHmac } from 'node:crypto';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const secret = process.env.LINK_SECRET;
const companyId = args.get('company');
const days = Number(args.get('days') ?? 90);
const appUrl = (process.env.APP_URL ?? 'https://app.subshield.io').replace(/\/$/, '');

if (!secret || !companyId) {
  console.error('Usage: LINK_SECRET=... node scripts/dashboard-link.mjs --company <uuid> [--days 90]');
  process.exit(1);
}

const exp = Math.floor(Date.now() / 1000) + days * 86400;
const sig = createHmac('sha256', secret).update(`dash:${companyId}:${exp}`).digest('base64url');
console.log(`${appUrl}/dash?c=${companyId}&t=${exp}.${sig}`);
