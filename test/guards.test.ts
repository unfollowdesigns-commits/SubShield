import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { ExtractionError, checkContent, isEncryptedPdf, sha256 } from '../src/extract';
import { signLink, verifyLink } from '../src/sign';

const pdf = (body: string) =>
  new TextEncoder().encode(`%PDF-1.7\n${body}\ntrailer\n<< /Root 1 0 R >>\n%%EOF`);

describe('sha256', () => {
  it('is stable for identical bytes and different for a changed one', async () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    const c = new Uint8Array([1, 2, 3, 5]);
    expect(await sha256(a)).toBe(await sha256(b));
    expect(await sha256(a)).not.toBe(await sha256(c));
    expect(await sha256(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isEncryptedPdf', () => {
  it('TC-14: spots a security handler in the trailer', () => {
    expect(isEncryptedPdf(pdf('trailer\n<< /Encrypt 9 0 R /Root 1 0 R >>'))).toBe(true);
  });

  it('leaves an ordinary PDF alone', () => {
    expect(isEncryptedPdf(pdf('1 0 obj << /Type /Catalog >> endobj'))).toBe(false);
  });

  it('checks the tail, so the flag is found in a large file', () => {
    const padding = new Uint8Array(200_000).fill(0x20);
    const tail = pdf('trailer\n<< /Encrypt 9 0 R >>');
    const big = new Uint8Array(padding.length + tail.length);
    big.set(padding);
    big.set(tail, padding.length);
    expect(isEncryptedPdf(big)).toBe(true);
  });

  it('raises an actionable error rather than a vague extraction failure', () => {
    try {
      checkContent('application/pdf', pdf('trailer\n<< /Encrypt 9 0 R >>'));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ExtractionError).slug).toBe('pdf_password_protected');
      expect((e as Error).message).toMatch(/password protected/);
    }
  });

  it('does not run the PDF check against an image', () => {
    expect(() => checkContent('image/png', new Uint8Array([137, 80, 78, 71]))).not.toThrow();
  });
});

describe('TC-18: one tenant cannot reach another', () => {
  const SECRET = 'tenant-isolation-secret';
  const NOW = new Date('2026-06-15T12:00:00Z');

  it('a dashboard link for one company does not open another', async () => {
    const apex = await signLink('dash:company-apex', SECRET, 3600, NOW);
    expect(await verifyLink('dash:company-apex', apex, SECRET, NOW)).toBe(true);
    expect(await verifyLink('dash:company-northgate', apex, SECRET, NOW)).toBe(false);
  });

  it('a review link for one certificate does not open another', async () => {
    const one = await signLink('review:cert-apex-1', SECRET, 3600, NOW);
    expect(await verifyLink('review:cert-northgate-1', one, SECRET, NOW)).toBe(false);
  });

  it('a dashboard token cannot be reused as a review token', async () => {
    const dash = await signLink('dash:company-apex', SECRET, 3600, NOW);
    expect(await verifyLink('review:company-apex', dash, SECRET, NOW)).toBe(false);
  });

  it('the scope is signed, so swapping the id in the URL fails', async () => {
    const apex = await signLink('dash:company-apex', SECRET, 3600, NOW);
    // Exactly what an attacker can do: keep the token, change ?c=
    for (const forged of ['dash:company-b', 'dash:', 'dash:company-apex2']) {
      expect(await verifyLink(forged, apex, SECRET, NOW)).toBe(false);
    }
  });
});

describe('the dashboard-link script signs the same way the Worker verifies', () => {
  it('matches scripts/dashboard-link.mjs byte for byte', async () => {
    const SECRET = 'shared-secret';
    const companyId = 'company-apex';
    const exp = 1_800_000_000;

    // What scripts/dashboard-link.mjs produces:
    const scriptSig = createHmac('sha256', SECRET)
      .update(`dash:${companyId}:${exp}`)
      .digest('base64url');

    const at = new Date(exp * 1000 - 60_000);
    const workerToken = await signLink(`dash:${companyId}`, SECRET, 60, at);

    expect(workerToken).toBe(`${exp}.${scriptSig}`);
    expect(await verifyLink(`dash:${companyId}`, `${exp}.${scriptSig}`, SECRET, at)).toBe(true);
  });
});
