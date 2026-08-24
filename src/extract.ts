import { EXTRACTION_SCHEMA, SYSTEM_PROMPT } from './prompt';
import type { Extraction } from './types';

export const MAX_FILE_BYTES = 15 * 1024 * 1024;

export const ACCEPTED_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const;

export type AcceptedType = (typeof ACCEPTED_TYPES)[number];

export interface ExtractOptions {
  apiKey: string;
  model: string;
  /** USD per million tokens, for the cost recorded on each certificate. */
  inputRate?: number;
  outputRate?: number;
  fetchImpl?: typeof fetch;
}

export interface ExtractResult {
  extraction: Extraction;
  raw: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class ExtractionError extends Error {
  constructor(message: string, readonly slug: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

/** Rejects anything we should not pay to look at. Runs before any API call. */
export function checkFile(type: string, bytes: number): AcceptedType {
  const normalized = type.split(';')[0]!.trim().toLowerCase();
  if (!ACCEPTED_TYPES.includes(normalized as AcceptedType)) {
    throw new ExtractionError(`Unsupported file type: ${type}`, 'unsupported_file_type');
  }
  if (bytes <= 0) {
    throw new ExtractionError('File is empty', 'empty_file');
  }
  if (bytes > MAX_FILE_BYTES) {
    throw new ExtractionError(
      `File is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is 15 MB`,
      'file_too_large',
    );
  }
  return normalized as AcceptedType;
}

/** Base64 in chunks — btoa on a 15 MB spread argument list blows the stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function contentPart(type: AcceptedType, base64: string, filename: string) {
  const dataUrl = `data:${type};base64,${base64}`;
  return type === 'application/pdf'
    ? { type: 'file', file: { filename, file_data: dataUrl } }
    : { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } };
}

/**
 * Coerce a model response into an Extraction.
 *
 * Structured Outputs makes this mostly redundant, which is the point — it costs
 * nothing and means a schema regression surfaces as a failed check rather than
 * as `"1,000,000" < 1000000` silently approving a deficient certificate.
 */
export function coerceExtraction(value: unknown): Extraction {
  if (typeof value !== 'object' || value === null) {
    throw new ExtractionError('Model returned a non-object', 'malformed_response');
  }
  const v = value as Record<string, unknown>;

  const int = (k: string): number | null => {
    const raw = v[k];
    if (raw == null) return null;
    const n = typeof raw === 'string' ? Number(raw.replace(/[$,\s]/g, '')) : Number(raw);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const str = (k: string): string | null => {
    const raw = v[k];
    if (raw == null) return null;
    const s = String(raw).trim();
    return s === '' ? null : s;
  };
  const bool = (k: string): boolean | null => {
    const raw = v[k];
    if (typeof raw === 'boolean') return raw;
    if (raw == null) return null;
    const s = String(raw).trim().toLowerCase();
    if (['true', 'y', 'yes', 'x'].includes(s)) return true;
    if (['false', 'n', 'no', ''].includes(s)) return false;
    return null;
  };

  const confidence = Number(v.confidence_score);

  return {
    document_type: v.document_type === 'acord_25' ? 'acord_25' : 'other',
    producer_name: str('producer_name'),
    insured_entity_name: str('insured_entity_name'),
    carrier_name: str('carrier_name'),
    gl_policy_number: str('gl_policy_number'),
    gl_each_occurrence_limit: int('gl_each_occurrence_limit'),
    gl_general_aggregate_limit: int('gl_general_aggregate_limit'),
    gl_expiration_date: str('gl_expiration_date'),
    additional_insured_included: bool('additional_insured_included'),
    waiver_of_subrogation_included: bool('waiver_of_subrogation_included'),
    certificate_holder_text: str('certificate_holder_text'),
    // NaN survives on purpose: validate() fails closed on it.
    confidence_score: Number.isFinite(confidence) ? confidence : Number.NaN,
  };
}

/**
 * Send one document to the model and return the parsed extraction.
 *
 * Retries once on 429 and 5xx, then gives up — a successful parse is never
 * retried, because paying twice for the same answer is how a metered API
 * becomes a surprise bill.
 */
export async function extract(
  file: { bytes: Uint8Array; type: string; filename: string },
  opts: ExtractOptions,
): Promise<ExtractResult> {
  const type = checkFile(file.type, file.bytes.length);
  const doFetch = opts.fetchImpl ?? fetch;
  const body = {
    model: opts.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract the compliance fields from this document.' },
          contentPart(type, toBase64(file.bytes), file.filename),
        ],
      },
    ],
    response_format: { type: 'json_schema', json_schema: EXTRACTION_SCHEMA },
  };

  let lastStatus = 0;
  let lastBody = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));

    const res = await doFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429 || res.status >= 500) {
      lastStatus = res.status;
      lastBody = await res.text().catch(() => '');
      continue;
    }
    if (!res.ok) {
      throw new ExtractionError(
        `OpenAI returned ${res.status}: ${await res.text().catch(() => '')}`,
        'extraction_failed',
      );
    }

    const json = (await res.json()) as any;
    const content = json?.choices?.[0]?.message?.content;
    if (json?.choices?.[0]?.finish_reason === 'length') {
      throw new ExtractionError('Model response was truncated', 'extraction_truncated');
    }
    if (typeof content !== 'string') {
      throw new ExtractionError('Model returned no content', 'malformed_response');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ExtractionError('Model returned invalid JSON', 'malformed_response');
    }

    const inputTokens = Number(json?.usage?.prompt_tokens ?? 0);
    const outputTokens = Number(json?.usage?.completion_tokens ?? 0);
    const inRate = opts.inputRate ?? 0.25;
    const outRate = opts.outputRate ?? 2.0;

    return {
      extraction: coerceExtraction(parsed),
      raw: parsed,
      model: String(json?.model ?? opts.model),
      inputTokens,
      outputTokens,
      costUsd: (inputTokens * inRate + outputTokens * outRate) / 1_000_000,
    };
  }

  throw new ExtractionError(
    `OpenAI unavailable after retry (${lastStatus}): ${lastBody}`,
    'extraction_failed',
  );
}
