import { Db, type ChaseRow } from './db';
import { sendEmail, type NotifyConfig } from './notify';
import { signLink } from './sign';

/**
 * The chase ladder.
 *
 * A subcontractor whose certificate lapses on a Friday is on site Monday with
 * no coverage and nobody in the office knows. This is the part of the product
 * that prevents that, and it is the reason the client is paying.
 */

export type ChaseStage = 30 | 15 | 7 | 0;

/**
 * Which rung of the ladder a vendor is on today, or null for nothing to do.
 *
 * Anything at or past expiry is stage 0. The upper rungs are windows rather
 * than exact days: a cron that misses a run, or a vendor added mid-window,
 * must still get chased instead of silently skipping a rung.
 */
export function chaseStageFor(daysRemaining: number | null): ChaseStage | null {
  if (daysRemaining == null) return 0;      // no certificate at all
  if (daysRemaining <= 0) return 0;
  if (daysRemaining <= 7) return 7;
  if (daysRemaining <= 15) return 15;
  if (daysRemaining <= 30) return 30;
  return null;
}

/**
 * Has this rung already been sent?
 *
 * Stages descend as expiry approaches, so a vendor already chased at 15 is not
 * chased again until they reach 7. This is what makes the cron safe to run
 * twice in a day, or twice in a minute.
 */
export function alreadyChased(stage: ChaseStage, lastStage: number | null): boolean {
  if (lastStage == null) return false;
  return lastStage <= stage;
}

export interface ChaseMessage {
  subject: string;
  html: string;
  ccClient: boolean;
}

export function chaseMessage(opts: {
  stage: ChaseStage;
  vendorName: string;
  companyName: string;
  expirationDate: string | null;
  uploadUrl: string;
  missing: boolean;
}): ChaseMessage {
  const { stage, vendorName, companyName, expirationDate, uploadUrl, missing } = opts;
  const link = `<p><a href="${uploadUrl}"
    style="display:inline-block;background:#1c5cd6;color:#fff;padding:10px 18px;
           border-radius:6px;text-decoration:none">Send your certificate</a></p>
    <p style="font-size:13px;color:#5b6472">Or forward it to your agent and ask them to
    send it to us — the link works for them too.</p>`;

  const wrap = (body: string) =>
    `<div style="font:15px/1.55 system-ui,sans-serif;color:#14171c">${body}${link}</div>`;

  if (missing) {
    return {
      ccClient: false,
      subject: `Certificate of insurance needed — ${companyName}`,
      html: wrap(`<p>Hello,</p>
        <p>${companyName} does not have a current certificate of insurance on file for
        ${vendorName}. One is needed before work continues on their sites.</p>`),
    };
  }

  const expires = expirationDate ? ` on <strong>${expirationDate}</strong>` : ' shortly';

  switch (stage) {
    case 30:
      return {
        ccClient: false,
        subject: `Your insurance certificate expires in 30 days — ${companyName}`,
        html: wrap(`<p>Hello,</p>
          <p>Your certificate of insurance for ${companyName} expires${expires}.
          Sending the renewal now saves the reminders later.</p>`),
      };
    case 15:
      return {
        ccClient: false,
        subject: `15 days: insurance certificate renewal — ${companyName}`,
        html: wrap(`<p>Hello,</p>
          <p>We still do not have a renewed certificate of insurance for ${vendorName}.
          The current one expires${expires}.</p>
          <p>Most agents turn these around the same day if you ask.</p>`),
      };
    case 7:
      return {
        ccClient: true,
        subject: `Urgent: insurance expires in 7 days — ${companyName}`,
        html: wrap(`<p>Hello,</p>
          <p>The certificate of insurance for ${vendorName} expires${expires}.
          Once it lapses, ${companyName} cannot allow work to continue on their sites
          until a current certificate is on file.</p>
          <p>Their project manager is copied on this message.</p>`),
      };
    case 0:
      return {
        ccClient: true,
        subject: `Insurance has expired — work stopped — ${companyName}`,
        html: wrap(`<p>Hello,</p>
          <p>The certificate of insurance for ${vendorName} has expired${
            expirationDate ? ` (${expirationDate})` : ''
          }. ${vendorName} is not currently cleared for work on ${companyName} sites.</p>
          <p>Send a current certificate and this clears automatically.</p>`),
      };
  }
}

export interface ChaseEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  RESEND_API_KEY?: string;
  FROM_ADDRESS?: string;
  LINK_SECRET: string;
  APP_URL: string;
  /** Free-plan Workers allow 50 subrequests per invocation. Stay under it. */
  CHASE_BATCH_SIZE?: string;
}

/**
 * One pass of the ladder.
 *
 * Each vendor costs roughly three subrequests (send, update, log), so the batch
 * is small on purpose. Whatever is left is picked up by the next run rather
 * than being lost — every rung is a window, not a single day.
 */
export async function runChase(
  env: ChaseEnv,
  now: Date = new Date(),
): Promise<{ considered: number; sent: number; expired: number; skipped: number }> {
  const db = new Db({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY });
  const batch = Number(env.CHASE_BATCH_SIZE ?? 12);
  const due = await db.chaseQueue(batch * 3);

  const cfg: NotifyConfig = {
    resendApiKey: env.RESEND_API_KEY,
    fromAddress: env.FROM_ADDRESS,
  };

  let sent = 0;
  let expired = 0;
  let skipped = 0;

  for (const row of due) {
    if (sent >= batch) break;

    const stage = chaseStageFor(row.days_remaining);
    if (stage === null || alreadyChased(stage, row.last_chase_stage)) {
      skipped++;
      continue;
    }

    // Expiry is a state change the client's dashboard must reflect even if the
    // email later fails, so it is recorded first.
    if (stage === 0 && row.active_cert_id) {
      await db.expireCertificate(row.active_cert_id, row.id);
      expired++;
    }

    const token = await signLink(`upload:${row.id}`, env.LINK_SECRET, 60 * 24 * 3600, now);
    const message = chaseMessage({
      stage,
      vendorName: row.vendor_name,
      companyName: row.company_name,
      expirationDate: row.expiration_date,
      uploadUrl: `${env.APP_URL}/u/${row.upload_token}?t=${token}`,
      missing: row.compliance_status === 'missing',
    });

    const delivered = await sendEmail(row.contact_email, message.subject, message.html, cfg)
      .catch(() => false);

    if (message.ccClient && row.primary_contact_email) {
      await sendEmail(
        row.primary_contact_email,
        `${row.vendor_name}: ${message.subject}`,
        message.html,
        cfg,
      ).catch(() => false);
    }

    await db.recordChase(row.id, stage, now);
    await db.log({
      company_id: row.company_id,
      subcontractor_id: row.id,
      certificate_id: row.active_cert_id,
      action: stage === 0 ? 'expired' : 'chase_sent',
      details: {
        stage,
        days_remaining: row.days_remaining,
        compliance_status: row.compliance_status,
        delivered,
        cc_client: message.ccClient,
      },
    });
    sent++;
  }

  return { considered: due.length, sent, expired, skipped };
}

export type { ChaseRow };
