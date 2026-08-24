import { Db, type SubcontractorWithCompany } from './db';
import { ExtractionError, checkFile } from './extract';
import { FAILURE_TEXT } from './validate';
import { renderUploadPage } from './upload-page';
import { applyDecision, renderReviewPage } from './review';
import { processCertificate, type PipelineEnv } from './pipeline';
import { handleInboundMail, type EmailEnv, type InboundMessage } from './email';
import { verifyLink } from './sign';
import type { FailureReason } from './types';

export interface Env extends PipelineEnv, EmailEnv {
  DOCS: R2Bucket;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The review page frames the certificate from this same origin only.
      'content-security-policy': "frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/health') return json({ ok: true });

    const db = new Db({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY });

    if (parts[0] === 'u' && parts[1]) return uploadRoutes(req, env, ctx, db, parts);
    if (parts[0] === 'review' && parts[1]) return reviewRoutes(req, env, db, url, parts);

    return html('<h1>Not found</h1>', 404);
  },

  async email(message: InboundMessage, env: Env): Promise<void> {
    await handleInboundMail(message, env);
  },
} satisfies ExportedHandler<Env>;

// ─── subcontractor upload ────────────────────────────────────────────────────

async function uploadRoutes(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  db: Db,
  parts: string[],
): Promise<Response> {
  const sub = await db.subcontractorByToken(parts[1]!);
  if (!sub) return html('<h1>This upload link is no longer valid</h1>', 404);

  if (parts[2] === 'status' && parts[3]) {
    // Scoped to this token's company — an id alone never grants access.
    const cert = await db.certificateStatus(parts[3], sub.company_id);
    if (!cert) return json({ message: 'Not found' }, 404);
    return json({
      status: cert.verification_status,
      expiration_date: cert.expiration_date,
      reasons: (cert.failure_reasons ?? [])
        .filter((r) => r !== ('unmatched_vendor' as FailureReason))
        .map((r) => FAILURE_TEXT[r as FailureReason] ?? r),
    });
  }

  if (parts.length === 2 && req.method === 'GET') return html(renderUploadPage(sub));
  if (parts.length === 2 && req.method === 'POST') return handleUpload(req, env, ctx, db, sub);
  return json({ message: 'Not found' }, 404);
}

async function handleUpload(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  db: Db,
  sub: SubcontractorWithCompany,
): Promise<Response> {
  const form = await req.formData().catch(() => null);
  // @cloudflare/workers-types types FormData.get() as `string | null`, but the
  // runtime hands back a File for a file part. Cast across that gap, then narrow.
  const file = form?.get('file') as unknown as File | string | null | undefined;
  if (!file || typeof file === 'string') {
    return json({ message: 'No file was uploaded' }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Guard before anything is stored or any paid API is called.
  try {
    checkFile(file.type || 'application/octet-stream', bytes.length);
  } catch (err) {
    const e = err as ExtractionError;
    await db.log({
      company_id: sub.company_id,
      subcontractor_id: sub.id,
      action: 'rejected_at_intake',
      details: { reason: e.slug, filename: file.name, bytes: bytes.length },
    });
    return json({ message: e.message, reasons: [e.message] }, 415);
  }

  const key = `${sub.company_id}/${sub.id}/${Date.now()}-${crypto.randomUUID()}`;
  await env.DOCS.put(key, bytes, { httpMetadata: { contentType: file.type } });

  const cert = await db.insertCertificate({
    company_id: sub.company_id,
    subcontractor_id: sub.id,
    r2_key: key,
    source: 'portal',
    original_filename: file.name,
    verification_status: 'processing',
  });

  await db.log({
    company_id: sub.company_id,
    subcontractor_id: sub.id,
    certificate_id: cert.id,
    action: 'ingested',
    details: { source: 'portal', filename: file.name, bytes: bytes.length },
  });

  // Extraction takes ~10–20s. Answer now, let the page poll for the verdict.
  ctx.waitUntil(
    processCertificate({ bytes, type: file.type, filename: file.name }, cert.id, {
      env,
      db,
      company: sub.companies,
      subcontractor: sub,
      source: 'portal',
    }),
  );

  return json({ certificate_id: cert.id, status: 'processing' }, 202);
}

// ─── human review ────────────────────────────────────────────────────────────

async function reviewRoutes(
  req: Request,
  env: Env,
  db: Db,
  url: URL,
  parts: string[],
): Promise<Response> {
  const certId = parts[1]!;
  const token = url.searchParams.get('t');

  // The signed link is the only credential. It names the certificate it opens,
  // so it cannot be edited into a link for someone else's document.
  if (!(await verifyLink(`review:${certId}`, token, env.LINK_SECRET))) {
    return html('<h1>This review link has expired</h1>', 403);
  }

  const cert = await db.certificateDetail(certId);
  if (!cert) return html('<h1>Not found</h1>', 404);

  if (parts[2] === 'doc') {
    if (!cert.r2_key) return html('<h1>The original document is unavailable</h1>', 404);
    const obj = await env.DOCS.get(cert.r2_key);
    if (!obj) return html('<h1>The original document is unavailable</h1>', 404);
    return new Response(obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
        'content-disposition': 'inline',
        'cache-control': 'private, max-age=300',
      },
    });
  }

  if (req.method === 'POST') {
    const form = await req.formData().catch(() => null);
    if (!form) return html(renderReviewPage(cert, token!, { kind: 'error', text: 'Malformed form.' }), 400);
    const outcome = await applyDecision(cert, form, db);
    const fresh = (await db.certificateDetail(certId)) ?? cert;
    return html(renderReviewPage(fresh, token!, outcome), outcome.kind === 'error' ? 422 : 200);
  }

  return html(renderReviewPage(cert, token!));
}
