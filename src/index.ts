import { Db, type SubcontractorWithCompany } from './db';
import { ExtractionError, checkFile, extract } from './extract';
import { FAILURE_TEXT, validate } from './validate';
import { renderUploadPage } from './upload-page';
import type { FailureReason } from './types';

export interface Env {
  DOCS: R2Bucket;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  OPENAI_INPUT_RATE?: string;
  OPENAI_OUTPUT_RATE?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/health') return json({ ok: true });

    // /u/:token, /u/:token/status/:certificateId
    if (parts[0] !== 'u' || !parts[1]) {
      return html('<h1>Not found</h1>', 404);
    }

    const db = new Db({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY });
    const sub = await db.subcontractorByToken(parts[1]);
    if (!sub) return html('<h1>This upload link is no longer valid</h1>', 404);

    if (parts[2] === 'status' && parts[3]) {
      // Scoped to this token's company — an id alone never grants access.
      const cert = await db.certificateStatus(parts[3], sub.company_id);
      if (!cert) return json({ message: 'Not found' }, 404);
      return json({
        status: cert.verification_status,
        expiration_date: cert.expiration_date,
        reasons: (cert.failure_reasons ?? []).map(
          (r) => FAILURE_TEXT[r as FailureReason] ?? r,
        ),
      });
    }

    if (parts.length === 2 && req.method === 'GET') return html(renderUploadPage(sub));
    if (parts.length === 2 && req.method === 'POST') return handleUpload(req, env, ctx, db, sub);

    return json({ message: 'Not found' }, 404);
  },
} satisfies ExportedHandler<Env>;

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
    processCertificate({ bytes, type: file.type, filename: file.name }, cert.id, env, db, sub),
  );

  return json({ certificate_id: cert.id, status: 'processing' }, 202);
}

/**
 * Extract, validate, record. Every exit path writes a terminal status and an
 * audit row — a certificate must never be left sitting in `processing`.
 */
export async function processCertificate(
  file: { bytes: Uint8Array; type: string; filename: string },
  certificateId: string,
  env: Env,
  db: Db,
  sub: SubcontractorWithCompany,
): Promise<void> {
  const co = sub.companies;
  try {
    const result = await extract(file, {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      inputRate: env.OPENAI_INPUT_RATE ? Number(env.OPENAI_INPUT_RATE) : undefined,
      outputRate: env.OPENAI_OUTPUT_RATE ? Number(env.OPENAI_OUTPUT_RATE) : undefined,
    });

    const x = result.extraction;
    const failures = validate(x, co);
    const approved = failures.length === 0;

    await db.updateCertificate(certificateId, {
      producer_name: x.producer_name,
      insured_entity_name: x.insured_entity_name,
      carrier_name: x.carrier_name,
      gl_policy_number: x.gl_policy_number,
      gl_each_occurrence: x.gl_each_occurrence_limit,
      gl_general_aggregate: x.gl_general_aggregate_limit,
      expiration_date: x.gl_expiration_date,
      additional_insured: x.additional_insured_included,
      waiver_subrogation: x.waiver_of_subrogation_included,
      certificate_holder_text: x.certificate_holder_text,
      ai_confidence: Number.isFinite(x.confidence_score) ? x.confidence_score : null,
      verification_status: approved ? 'auto_approved' : 'pending_review',
      failure_reasons: approved ? null : failures,
      raw_json_response: result.raw,
      model_used: result.model,
      extraction_cost_usd: result.costUsd,
    });

    if (approved) await db.promoteCertificate(sub.id, certificateId);

    await db.log({
      company_id: sub.company_id,
      subcontractor_id: sub.id,
      certificate_id: certificateId,
      action: approved ? 'approved' : 'pending_review',
      details: {
        failure_reasons: failures,
        confidence: x.confidence_score,
        tokens: { input: result.inputTokens, output: result.outputTokens },
        cost_usd: result.costUsd,
      },
    });
  } catch (err) {
    const slug = err instanceof ExtractionError ? err.slug : 'extraction_failed';
    // Failures land in the review queue, never in the bin. A document we could
    // not read is a document a human still has to look at.
    await db.updateCertificate(certificateId, {
      verification_status: 'pending_review',
      failure_reasons: [slug],
    });
    await db.log({
      company_id: sub.company_id,
      subcontractor_id: sub.id,
      certificate_id: certificateId,
      action: 'extraction_failed',
      details: { reason: slug, message: (err as Error).message },
    });
  }
}
