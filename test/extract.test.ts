import { describe, expect, it, vi } from 'vitest';
import {
  ExtractionError,
  MAX_FILE_BYTES,
  checkFile,
  coerceExtraction,
  extract,
  toBase64,
} from '../src/extract';
import { validate } from '../src/validate';
import type { Requirements } from '../src/types';

const REQS: Requirements = {
  min_gl_each_occurrence: 1_000_000,
  min_gl_aggregate: 2_000_000,
  require_additional_insured: true,
  require_waiver_subrogation: true,
};

const MODEL_JSON = {
  document_type: 'acord_25',
  producer_name: 'Hanover & Fifth',
  insured_entity_name: 'Tri-County Plumbing Inc',
  carrier_name: 'Travelers',
  gl_policy_number: 'GL-4471902',
  gl_each_occurrence_limit: 1000000,
  gl_general_aggregate_limit: 2000000,
  gl_expiration_date: '2027-03-14',
  additional_insured_included: true,
  waiver_of_subrogation_included: true,
  certificate_holder_text: 'Apex Builders Group',
  confidence_score: 0.96,
};

function stubOpenAI(payload: unknown, init: { status?: number } = {}) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        model: 'test-model',
        usage: { prompt_tokens: 1800, completion_tokens: 260 },
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }],
      }),
      { status: init.status ?? 200, headers: { 'content-type': 'application/json' } },
    ),
  ) as unknown as typeof fetch;
}

const png = { bytes: new Uint8Array([137, 80, 78, 71]), type: 'image/png', filename: 'coi.png' };

describe('checkFile', () => {
  it('accepts the three formats subs actually send', () => {
    expect(checkFile('application/pdf', 1000)).toBe('application/pdf');
    expect(checkFile('image/jpeg', 1000)).toBe('image/jpeg');
    expect(checkFile('image/png', 1000)).toBe('image/png');
  });

  it('tolerates a charset parameter and odd casing', () => {
    expect(checkFile('APPLICATION/PDF; charset=binary', 1000)).toBe('application/pdf');
  });

  it('TC-13: rejects a file over 15 MB before any API call', () => {
    expect(() => checkFile('application/pdf', MAX_FILE_BYTES + 1)).toThrow(ExtractionError);
    try {
      checkFile('application/pdf', 40 * 1024 * 1024);
    } catch (e) {
      expect((e as ExtractionError).slug).toBe('file_too_large');
    }
  });

  it('rejects other formats and empty files', () => {
    expect(() => checkFile('application/zip', 100)).toThrow(/Unsupported file type/);
    expect(() => checkFile('image/png', 0)).toThrow(/empty/i);
  });
});

describe('toBase64', () => {
  it('round-trips binary without blowing the stack on large inputs', () => {
    const big = new Uint8Array(300_000).map((_, i) => i % 256);
    const decoded = Uint8Array.from(atob(toBase64(big)), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(big.length);
    expect(decoded[299_999]).toBe(big[299_999]);
  });
});

describe('coerceExtraction', () => {
  it('passes a well-formed response through unchanged', () => {
    expect(coerceExtraction(MODEL_JSON)).toMatchObject({
      gl_each_occurrence_limit: 1_000_000,
      additional_insured_included: true,
      confidence_score: 0.96,
    });
  });

  it('strips currency formatting if a model ever returns it as a string', () => {
    const x = coerceExtraction({ ...MODEL_JSON, gl_each_occurrence_limit: '$1,000,000' });
    expect(x.gl_each_occurrence_limit).toBe(1_000_000);
  });

  it('reads Y and X in the endorsement columns as true', () => {
    const x = coerceExtraction({
      ...MODEL_JSON,
      additional_insured_included: 'Y',
      waiver_of_subrogation_included: 'X',
    });
    expect(x.additional_insured_included).toBe(true);
    expect(x.waiver_of_subrogation_included).toBe(true);
  });

  it('turns empty strings into nulls rather than falsy values', () => {
    const x = coerceExtraction({ ...MODEL_JSON, gl_policy_number: '   ' });
    expect(x.gl_policy_number).toBeNull();
  });

  it('treats an unrecognised document_type as "other" so nothing is approved', () => {
    const x = coerceExtraction({ ...MODEL_JSON, document_type: 'acord_128' });
    expect(x.document_type).toBe('other');
    expect(validate(x, REQS)).toEqual(['not_an_acord_25']);
  });

  it('keeps a missing confidence as NaN, which validate() fails closed on', () => {
    const x = coerceExtraction({ ...MODEL_JSON, confidence_score: undefined });
    expect(Number.isNaN(x.confidence_score)).toBe(true);
    expect(validate(x, REQS)).toContain('low_confidence');
  });

  it('rejects a non-object response', () => {
    expect(() => coerceExtraction('nope')).toThrow(ExtractionError);
  });
});

describe('extract', () => {
  it('returns a parsed extraction and the metered cost', async () => {
    const fetchImpl = stubOpenAI(MODEL_JSON);
    const result = await extract(png, { apiKey: 'k', model: 'm', fetchImpl });

    expect(result.extraction.insured_entity_name).toBe('Tri-County Plumbing Inc');
    expect(result.inputTokens).toBe(1800);
    // 1800 in @ $0.25/M + 260 out @ $2/M
    expect(result.costUsd).toBeCloseTo((1800 * 0.25 + 260 * 2) / 1_000_000, 10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends a PDF as a file part and an image as an image part', async () => {
    const fetchImpl = stubOpenAI(MODEL_JSON);
    await extract({ ...png, type: 'application/pdf', filename: 'coi.pdf' },
      { apiKey: 'k', model: 'm', fetchImpl });
    const body = JSON.parse((fetchImpl as any).mock.calls[0][1].body);
    expect(body.messages[1].content[1].type).toBe('file');

    const fetchImpl2 = stubOpenAI(MODEL_JSON);
    await extract(png, { apiKey: 'k', model: 'm', fetchImpl: fetchImpl2 });
    const body2 = JSON.parse((fetchImpl2 as any).mock.calls[0][1].body);
    expect(body2.messages[1].content[1].type).toBe('image_url');
  });

  it('requests strict structured output', async () => {
    const fetchImpl = stubOpenAI(MODEL_JSON);
    await extract(png, { apiKey: 'k', model: 'm', fetchImpl });
    const body = JSON.parse((fetchImpl as any).mock.calls[0][1].body);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    // strict mode requires every property to be listed in required
    const schema = body.response_format.json_schema.schema;
    expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties)));
  });

  it('TC-15: retries once on 429, then surfaces a recoverable failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 }));
    const promise = extract(png, {
      apiKey: 'k', model: 'm', fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(promise).rejects.toThrow(/unavailable after retry/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('does not retry a hard 400', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad request', { status: 400 }));
    await expect(
      extract(png, { apiKey: 'k', model: 'm', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/OpenAI returned 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails on a truncated response rather than parsing half a certificate', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: '{"docu' } }],
      }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(extract(png, { apiKey: 'k', model: 'm', fetchImpl }))
      .rejects.toThrow(/truncated/);
  });

  it('never calls the API for a file that fails the guards', async () => {
    const fetchImpl = vi.fn();
    await expect(
      extract({ ...png, type: 'application/zip' },
        { apiKey: 'k', model: 'm', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(ExtractionError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('extract → validate, end to end', () => {
  it('approves a clean certificate straight from a model response', async () => {
    const result = await extract(png, {
      apiKey: 'k', model: 'm', fetchImpl: stubOpenAI(MODEL_JSON),
    });
    expect(validate(result.extraction, REQS, new Date('2026-06-15T00:00:00Z'))).toEqual([]);
  });

  it('queues a deficient certificate with the reasons a sub can act on', async () => {
    const deficient = {
      ...MODEL_JSON,
      gl_each_occurrence_limit: 500000,
      additional_insured_included: false,
    };
    const result = await extract(png, {
      apiKey: 'k', model: 'm', fetchImpl: stubOpenAI(deficient),
    });
    expect(validate(result.extraction, REQS, new Date('2026-06-15T00:00:00Z')).sort()).toEqual([
      'missing_additional_insured',
      'occurrence_limit_below_minimum',
    ]);
  });
});
