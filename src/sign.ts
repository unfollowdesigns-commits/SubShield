/**
 * Signed links.
 *
 * Slack alerts and review-queue emails carry action links. Rather than build
 * accounts and sessions for people who will click one link a week, each link
 * carries an expiring HMAC over exactly what it authorises.
 */

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/**
 * @param scope what the link permits, e.g. `review:<certificateId>`
 * @param ttlSeconds how long it stays valid
 * @returns `<expiry>.<signature>` for the `t` query parameter
 */
export async function signLink(
  scope: string,
  secret: string,
  ttlSeconds = 7 * 24 * 60 * 60,
  now: Date = new Date(),
): Promise<string> {
  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const sig = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(`${scope}:${exp}`));
  return `${exp}.${b64url(new Uint8Array(sig))}`;
}

/** Constant-time-ish compare. Length is not secret; the bytes are. */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyLink(
  scope: string,
  token: string | null | undefined,
  secret: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;

  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp)) return false;
  if (exp * 1000 < now.getTime()) return false;

  const expected = await crypto.subtle.sign(
    'HMAC',
    await key(secret),
    enc.encode(`${scope}:${exp}`),
  );
  return equal(token.slice(dot + 1), b64url(new Uint8Array(expected)));
}
