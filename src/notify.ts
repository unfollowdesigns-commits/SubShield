import { FAILURE_TEXT } from './validate';
import type { FailureReason } from './types';

/**
 * Outbound messages. Slack when the client has a webhook, email otherwise —
 * most fifteen-person GC offices do not have Slack, so it is never required.
 */

export interface NotifyConfig {
  resendApiKey?: string;
  fromAddress?: string;
  fetchImpl?: typeof fetch;
}

const money = (n: number | null | undefined) =>
  n == null ? 'not stated' : `$${n.toLocaleString('en-US')}`;

export function reasonText(reasons: FailureReason[] | string[]): string[] {
  return reasons.map((r) => FAILURE_TEXT[r as FailureReason] ?? String(r));
}

export interface ExceptionAlert {
  vendorName: string;
  companyName: string;
  reasons: string[];
  confidence: number | null;
  expirationDate: string | null;
  occurrenceLimit: number | null;
  aggregateLimit: number | null;
  reviewUrl: string;
}

/** Slack Block Kit. The buttons are signed links, not Slack interactivity — */
/** no Slack app, no OAuth, no review process, no cost. */
export function slackBlocks(a: ExceptionAlert) {
  return {
    text: `Compliance exception: ${a.vendorName}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `⚠️  Compliance exception — ${a.vendorName}` },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: reasonText(a.reasons).map((r) => `• ${r}`).join('\n'),
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: [
              `Each occurrence ${money(a.occurrenceLimit)}`,
              `aggregate ${money(a.aggregateLimit)}`,
              `expires ${a.expirationDate ?? 'unknown'}`,
              a.confidence == null ? 'confidence unknown' : `confidence ${a.confidence.toFixed(2)}`,
            ].join(' · '),
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: 'Review this certificate' },
            url: a.reviewUrl,
          },
        ],
      },
    ],
  };
}

export async function postToSlack(
  webhookUrl: string,
  alert: ExceptionAlert,
  cfg: NotifyConfig = {},
): Promise<boolean> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(slackBlocks(alert)),
  });
  return res.ok;
}

export function exceptionEmailHtml(a: ExceptionAlert): string {
  const items = reasonText(a.reasons).map((r) => `<li>${r}</li>`).join('');
  return `<div style="font:15px/1.5 system-ui,sans-serif;color:#14171c">
<p><strong>${a.vendorName}</strong> sent a certificate that needs a look before it can be accepted.</p>
<ul>${items}</ul>
<p style="color:#5b6472;font-size:13px">
Each occurrence ${money(a.occurrenceLimit)} · aggregate ${money(a.aggregateLimit)} ·
expires ${a.expirationDate ?? 'unknown'}</p>
<p><a href="${a.reviewUrl}"
 style="display:inline-block;background:#1c5cd6;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">
Review this certificate</a></p>
</div>`;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  cfg: NotifyConfig,
): Promise<boolean> {
  if (!cfg.resendApiKey || !cfg.fromAddress) return false;
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.resendApiKey}`,
    },
    body: JSON.stringify({ from: cfg.fromAddress, to: [to], subject, html }),
  });
  return res.ok;
}

/**
 * Raise an exception with whichever channel the client has. Notification
 * failure is never allowed to fail the pipeline — the certificate is already
 * safely in the review queue, and a dropped Slack post must not undo that.
 */
export async function raiseException(
  alert: ExceptionAlert,
  target: { slackWebhookUrl: string | null; email: string },
  cfg: NotifyConfig,
): Promise<'slack' | 'email' | 'none'> {
  try {
    if (target.slackWebhookUrl) {
      if (await postToSlack(target.slackWebhookUrl, alert, cfg)) return 'slack';
    }
    const sent = await sendEmail(
      target.email,
      `Compliance exception: ${alert.vendorName}`,
      exceptionEmailHtml(alert),
      cfg,
    );
    return sent ? 'email' : 'none';
  } catch {
    return 'none';
  }
}

export function rejectionEmailHtml(opts: {
  vendorName: string;
  companyName: string;
  reasons: string[];
  uploadUrl: string;
}): string {
  const items = reasonText(opts.reasons).map((r) => `<li>${r}</li>`).join('');
  return `<div style="font:15px/1.5 system-ui,sans-serif;color:#14171c">
<p>Thanks for sending your certificate of insurance for ${opts.companyName}.</p>
<p>We could not accept it yet:</p>
<ul>${items}</ul>
<p>Ask your insurance agent for a corrected certificate, then send it back here:</p>
<p><a href="${opts.uploadUrl}">${opts.uploadUrl}</a></p>
</div>`;
}

export function confirmationEmailHtml(opts: {
  vendorName: string;
  companyName: string;
  expirationDate: string | null;
}): string {
  return `<div style="font:15px/1.5 system-ui,sans-serif;color:#14171c">
<p>Your certificate of insurance for ${opts.companyName} has been accepted.</p>
${opts.expirationDate
  ? `<p>It is on file through <strong>${opts.expirationDate}</strong>. We will remind you
     30 days before it expires.</p>`
  : ''}
<p>Nothing further is needed.</p>
</div>`;
}
