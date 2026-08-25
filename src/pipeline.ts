import type { Candidate } from './matching';
import { matchSubcontractor } from './matching';
import { ExtractionError, extract, sha256 } from './extract';
import { validate } from './validate';
import { signLink } from './sign';
import {
  confirmationEmailHtml,
  raiseException,
  rejectionEmailHtml,
  sendEmail,
} from './notify';
import type { Company, Db, Subcontractor } from './db';

export interface PipelineEnv {
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  OPENAI_INPUT_RATE?: string;
  OPENAI_OUTPUT_RATE?: string;
  RESEND_API_KEY?: string;
  FROM_ADDRESS?: string;
  LINK_SECRET: string;
  APP_URL: string;
}

export interface PipelineContext {
  env: PipelineEnv;
  db: Db;
  company: Company;
  /** Known up front on the portal path; often unknown on the email path. */
  subcontractor: Subcontractor | null;
  /** Vendors to match the insured name against when the sender was unknown. */
  candidates?: Candidate[];
  source: 'portal' | 'email';
  /** Where to send the outcome, when it is not the subcontractor on file. */
  replyTo?: string | null;
}

export interface PipelineFile {
  bytes: Uint8Array;
  type: string;
  filename: string;
}

/**
 * Store a document and open a certificate row for it — unless this client has
 * already been sent the identical file, in which case return what they have.
 *
 * Shared by both intakes so a document mailed and then uploaded costs one
 * extraction and raises one notification.
 */
export async function ingest(
  file: PipelineFile,
  opts: {
    db: Db;
    bucket: R2Bucket;
    companyId: string;
    subcontractorId: string | null;
    source: 'portal' | 'email';
    details?: Record<string, unknown>;
  },
): Promise<{ certificateId: string; duplicate: boolean }> {
  const { db, bucket, companyId, subcontractorId, source } = opts;
  const sha = await sha256(file.bytes);

  const existing = await db.findByContentHash(companyId, sha);
  if (existing) {
    await db.log({
      company_id: companyId,
      subcontractor_id: subcontractorId,
      certificate_id: existing.id,
      action: 'duplicate_ignored',
      details: { source, filename: file.filename, sha256: sha, ...opts.details },
    });
    return { certificateId: existing.id, duplicate: true };
  }

  const key = `${companyId}/${subcontractorId ?? 'unmatched'}/${Date.now()}-${crypto.randomUUID()}`;
  await bucket.put(key, file.bytes as BufferSource, {
    httpMetadata: { contentType: file.type },
  });

  const cert = await db.insertCertificate({
    company_id: companyId,
    subcontractor_id: subcontractorId,
    r2_key: key,
    source,
    original_filename: file.filename,
    content_sha256: sha,
    verification_status: 'processing',
  });

  await db.log({
    company_id: companyId,
    subcontractor_id: subcontractorId,
    certificate_id: cert.id,
    action: 'ingested',
    details: {
      source,
      filename: file.filename,
      bytes: file.bytes.length,
      sha256: sha,
      ...opts.details,
    },
  });

  return { certificateId: cert.id, duplicate: false };
}

/**
 * Extract, identify, validate, record, notify.
 *
 * Every exit path writes a terminal status and an audit row. A certificate must
 * never be left sitting in `processing`, and a failure to notify must never
 * undo a decision that has already been committed.
 */
export async function processCertificate(
  file: PipelineFile,
  certificateId: string,
  ctx: PipelineContext,
): Promise<void> {
  const { db, env, company } = ctx;

  try {
    const result = await extract(file, {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      inputRate: env.OPENAI_INPUT_RATE ? Number(env.OPENAI_INPUT_RATE) : undefined,
      outputRate: env.OPENAI_OUTPUT_RATE ? Number(env.OPENAI_OUTPUT_RATE) : undefined,
    });
    const x = result.extraction;

    // Identify the vendor if the sender did not already tell us who they are.
    let subcontractor = ctx.subcontractor;
    let matchNote: Record<string, unknown> | null = null;
    if (!subcontractor && ctx.candidates?.length) {
      const match = matchSubcontractor(ctx.candidates, {
        senderEmail: ctx.replyTo,
        insuredName: x.insured_entity_name,
      });
      matchNote = { method: match.method, score: match.score };
      if (match.subcontractorId) {
        subcontractor = (await db.subcontractorById(match.subcontractorId)) ?? null;
      }
    }

    const failures = validate(x, company);
    // An unidentified vendor is never auto-approved, however clean the document.
    const unmatched = !subcontractor;
    const approved = failures.length === 0 && !unmatched;
    const reasons = unmatched ? [...failures, 'unmatched_vendor'] : failures;

    await db.updateCertificate(certificateId, {
      subcontractor_id: subcontractor?.id ?? null,
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
      failure_reasons: approved ? null : reasons,
      raw_json_response: result.raw,
      model_used: result.model,
      extraction_cost_usd: result.costUsd,
    });

    if (approved && subcontractor) await db.promoteCertificate(subcontractor.id, certificateId);

    await db.log({
      company_id: company.id,
      subcontractor_id: subcontractor?.id ?? null,
      certificate_id: certificateId,
      action: approved ? 'approved' : 'pending_review',
      details: {
        source: ctx.source,
        failure_reasons: reasons,
        confidence: x.confidence_score,
        match: matchNote,
        tokens: { input: result.inputTokens, output: result.outputTokens },
        cost_usd: result.costUsd,
      },
    });

    await notifyOutcome({
      ctx,
      certificateId,
      vendorName: subcontractor?.vendor_name ?? x.insured_entity_name ?? 'Unidentified vendor',
      subcontractor,
      approved,
      reasons,
      extraction: {
        expiration: x.gl_expiration_date,
        occurrence: x.gl_each_occurrence_limit,
        aggregate: x.gl_general_aggregate_limit,
        confidence: Number.isFinite(x.confidence_score) ? x.confidence_score : null,
      },
    });
  } catch (err) {
    const slug = err instanceof ExtractionError ? err.slug : 'extraction_failed';
    // A document we could not read is a document a human still has to look at.
    await db.updateCertificate(certificateId, {
      verification_status: 'pending_review',
      failure_reasons: [slug],
    });
    await db.log({
      company_id: company.id,
      subcontractor_id: ctx.subcontractor?.id ?? null,
      certificate_id: certificateId,
      action: 'extraction_failed',
      details: { source: ctx.source, reason: slug, message: (err as Error).message },
    });
  }
}

async function notifyOutcome(args: {
  ctx: PipelineContext;
  certificateId: string;
  vendorName: string;
  subcontractor: Subcontractor | null;
  approved: boolean;
  reasons: string[];
  extraction: {
    expiration: string | null;
    occurrence: number | null;
    aggregate: number | null;
    confidence: number | null;
  };
}): Promise<void> {
  const { ctx, certificateId, vendorName, subcontractor, approved, reasons, extraction } = args;
  const { env, company, db } = ctx;
  const notifyCfg = {
    resendApiKey: env.RESEND_API_KEY,
    fromAddress: env.FROM_ADDRESS,
  };
  const vendorEmail = subcontractor?.contact_email ?? ctx.replyTo ?? null;

  if (approved) {
    if (vendorEmail) {
      await sendEmail(
        vendorEmail,
        `Certificate accepted — ${company.company_name}`,
        confirmationEmailHtml({
          vendorName,
          companyName: company.company_name,
          expirationDate: extraction.expiration,
        }),
        notifyCfg,
      ).catch(() => false);
    }
    return;
  }

  const token = await signLink(`review:${certificateId}`, env.LINK_SECRET);
  const reviewUrl = `${env.APP_URL}/review/${certificateId}?t=${token}`;

  const channel = await raiseException(
    {
      vendorName,
      companyName: company.company_name,
      reasons,
      confidence: extraction.confidence,
      expirationDate: extraction.expiration,
      occurrenceLimit: extraction.occurrence,
      aggregateLimit: extraction.aggregate,
      reviewUrl,
    },
    { slackWebhookUrl: company.slack_webhook_url, email: company.primary_contact_email },
    notifyCfg,
  );

  await db.log({
    company_id: company.id,
    certificate_id: certificateId,
    subcontractor_id: subcontractor?.id ?? null,
    action: 'exception_raised',
    details: { channel, reasons },
  });

  // Tell the sender what to fix — but only about the document, never about a
  // matching failure, which is our problem and not theirs to correct.
  const vendorFacing = reasons.filter((r) => r !== 'unmatched_vendor');
  if (vendorEmail && vendorFacing.length && ctx.source === 'email' && subcontractor) {
    const uploadToken = await signLink(`upload:${subcontractor.id}`, env.LINK_SECRET);
    await sendEmail(
      vendorEmail,
      `Certificate needs correcting — ${company.company_name}`,
      rejectionEmailHtml({
        vendorName,
        companyName: company.company_name,
        reasons: vendorFacing,
        uploadUrl: `${env.APP_URL}/u/${subcontractor.upload_token}?t=${uploadToken}`,
      }),
      notifyCfg,
    ).catch(() => false);
  }
}
