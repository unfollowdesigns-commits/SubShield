import PostalMime from 'postal-mime';
import { ACCEPTED_TYPES, checkFile } from './extract';
import { aliasFromAddress, matchSubcontractor } from './matching';
import { processCertificate, type PipelineEnv } from './pipeline';
import { Db } from './db';
import { sendEmail } from './notify';

export interface EmailEnv extends PipelineEnv {
  DOCS: R2Bucket;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

/** Cloudflare's inbound message shape, narrowed to what we use. */
export interface InboundMessage {
  from: string;
  to: string;
  raw: ReadableStream;
  rawSize: number;
  setReject(reason: string): void;
}

export interface Attachment {
  filename?: string;
  mimeType?: string;
  content: ArrayBuffer | Uint8Array | string;
}

const extensionType: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/**
 * Pick the certificate out of an email.
 *
 * Agents send logos, signatures and "please consider the environment" images.
 * Prefer a PDF, then the largest acceptable image — a signature block is never
 * the biggest attachment on a message that also carries a scan.
 */
export function pickAttachment(attachments: Attachment[]): {
  bytes: Uint8Array;
  type: string;
  filename: string;
} | null {
  const usable = attachments
    .map((a) => {
      const bytes =
        a.content instanceof Uint8Array
          ? a.content
          : typeof a.content === 'string'
            ? Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0))
            : new Uint8Array(a.content);
      const filename = a.filename ?? 'attachment';
      const ext = filename.split('.').pop()?.toLowerCase() ?? '';
      const declared = (a.mimeType ?? '').split(';')[0]!.trim().toLowerCase();
      const type = ACCEPTED_TYPES.includes(declared as never)
        ? declared
        : (extensionType[ext] ?? declared);
      return { bytes, type, filename };
    })
    .filter((a) => {
      try {
        checkFile(a.type, a.bytes.length);
        return true;
      } catch {
        return false;
      }
    });

  if (usable.length === 0) return null;
  const pdf = usable.filter((a) => a.type === 'application/pdf');
  const pool = pdf.length ? pdf : usable;
  return pool.reduce((a, b) => (b.bytes.length > a.bytes.length ? b : a));
}

/**
 * Inbound email handler, bound to a Cloudflare Email Routing catch-all.
 *
 * One route for every client: the local part of the recipient address is the
 * tenant key, which keeps the account well under the 200-rule routing limit.
 */
export async function handleInboundMail(
  message: InboundMessage,
  env: EmailEnv,
): Promise<void> {
  const db = new Db({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY });

  const alias = aliasFromAddress(message.to);
  const company = alias ? await db.companyByAlias(alias) : null;
  if (!company) {
    message.setReject('No SubShield account is configured for this address');
    return;
  }
  if (company.status !== 'active') {
    message.setReject('This SubShield account is not active');
    return;
  }

  const parsed = await new PostalMime().parse(message.raw);
  const sender = (parsed.from?.address ?? message.from ?? '').toLowerCase();
  const file = pickAttachment((parsed.attachments ?? []) as Attachment[]);

  if (!file) {
    await db.log({
      company_id: company.id,
      action: 'rejected_at_intake',
      details: { reason: 'no_usable_attachment', from: sender, subject: parsed.subject },
    });
    // Bounce would be invisible to a person; tell them what to do instead.
    await sendEmail(
      sender,
      `We could not find a certificate on your email`,
      `<p>We did not find a PDF, JPG or PNG certificate attached to your message.
       Please reply with the ACORD 25 attached, under 15 MB.</p>`,
      { resendApiKey: env.RESEND_API_KEY, fromAddress: env.FROM_ADDRESS },
    ).catch(() => false);
    return;
  }

  // Try the sender address before spending anything on extraction.
  const candidates = await db.subcontractorsForCompany(company.id);
  const bySender = matchSubcontractor(candidates, { senderEmail: sender });
  const subcontractor = bySender.subcontractorId
    ? await db.subcontractorById(bySender.subcontractorId)
    : null;

  const key = `${company.id}/${subcontractor?.id ?? 'unmatched'}/${Date.now()}-${crypto.randomUUID()}`;
  await env.DOCS.put(key, file.bytes, { httpMetadata: { contentType: file.type } });

  const cert = await db.insertCertificate({
    company_id: company.id,
    subcontractor_id: subcontractor?.id ?? null,
    r2_key: key,
    source: 'email',
    original_filename: file.filename,
    verification_status: 'processing',
  });

  await db.log({
    company_id: company.id,
    subcontractor_id: subcontractor?.id ?? null,
    certificate_id: cert.id,
    action: 'ingested',
    details: {
      source: 'email',
      from: sender,
      subject: parsed.subject,
      filename: file.filename,
      bytes: file.bytes.length,
      matched_by: bySender.method,
    },
  });

  await processCertificate(file, cert.id, {
    env,
    db,
    company,
    subcontractor,
    candidates,
    source: 'email',
    replyTo: sender,
  });
}
