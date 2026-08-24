import { describe, expect, it } from 'vitest';
import { signLink, verifyLink } from '../src/sign';

const SECRET = 'a-test-signing-secret';
const NOW = new Date('2026-06-15T12:00:00Z');

describe('signed links', () => {
  it('verifies a link it just signed', async () => {
    const t = await signLink('review:cert-1', SECRET, 3600, NOW);
    expect(await verifyLink('review:cert-1', t, SECRET, NOW)).toBe(true);
  });

  it('does not open a different certificate', async () => {
    const t = await signLink('review:cert-1', SECRET, 3600, NOW);
    expect(await verifyLink('review:cert-2', t, SECRET, NOW)).toBe(false);
  });

  it('rejects a token signed with a different secret', async () => {
    const t = await signLink('review:cert-1', 'other-secret', 3600, NOW);
    expect(await verifyLink('review:cert-1', t, SECRET, NOW)).toBe(false);
  });

  it('expires', async () => {
    const t = await signLink('review:cert-1', SECRET, 60, NOW);
    const later = new Date(NOW.getTime() + 61_000);
    expect(await verifyLink('review:cert-1', t, SECRET, later)).toBe(false);
  });

  it('rejects a tampered expiry — the expiry is inside the signature', async () => {
    const t = await signLink('review:cert-1', SECRET, 60, NOW);
    const forged = `${Math.floor(NOW.getTime() / 1000) + 999999}.${t.split('.')[1]}`;
    expect(await verifyLink('review:cert-1', forged, SECRET, NOW)).toBe(false);
  });

  it('rejects missing and malformed tokens', async () => {
    for (const t of [null, undefined, '', 'garbage', '.', '12345', 'abc.def']) {
      expect(await verifyLink('review:cert-1', t, SECRET, NOW)).toBe(false);
    }
  });

  it('produces URL-safe tokens', async () => {
    const t = await signLink('review:cert-1', SECRET, 3600, NOW);
    expect(t).toBe(encodeURIComponent(t));
  });
});
