import { describe, expect, it, vi } from 'vitest';
import { ingest } from '../src/pipeline';
import { sha256 } from '../src/extract';
import type { Db } from '../src/db';

const file = {
  bytes: new TextEncoder().encode('%PDF-1.7 a certificate'),
  type: 'application/pdf',
  filename: 'coi.pdf',
};

type LogEntry = { action: string; company_id: string; certificate_id?: string | null };

function fakes(existing: { id: string } | null) {
  // Explicit parameter types so the recorded calls stay typed at the assertions.
  const put = vi.fn(async (_key: string, _body: unknown, _opts?: unknown) => ({}));
  const db = {
    findByContentHash: vi.fn(async (_companyId: string, _sha: string) => existing),
    insertCertificate: vi.fn(async (_row: Record<string, unknown>) => ({ id: 'cert-new' })),
    log: vi.fn(async (_entry: LogEntry) => undefined),
  };
  return { db: db as unknown as Db, spy: db, bucket: { put } as unknown as R2Bucket, put };
}

const opts = (db: Db, bucket: R2Bucket) => ({
  db, bucket, companyId: 'co-1', subcontractorId: 'sub-1', source: 'portal' as const,
});

describe('ingest', () => {
  it('stores the file and opens a certificate the first time', async () => {
    const { db, spy, bucket, put } = fakes(null);
    const out = await ingest(file, opts(db, bucket));

    expect(out).toEqual({ certificateId: 'cert-new', duplicate: false });
    expect(put).toHaveBeenCalledTimes(1);
    expect(spy.insertCertificate).toHaveBeenCalledTimes(1);
    expect(spy.log.mock.calls[0]?.[0].action).toBe('ingested');
  });

  it('records the content hash so the next copy can be recognised', async () => {
    const { db, spy, bucket } = fakes(null);
    await ingest(file, opts(db, bucket));
    const row = spy.insertCertificate.mock.calls[0]?.[0];
    expect(row?.content_sha256).toBe(await sha256(file.bytes));
  });

  it('TC-11: the same file again costs no storage, no row and no extraction', async () => {
    const { db, spy, bucket, put } = fakes({ id: 'cert-existing' });
    const out = await ingest(file, opts(db, bucket));

    expect(out).toEqual({ certificateId: 'cert-existing', duplicate: true });
    expect(put).not.toHaveBeenCalled();
    expect(spy.insertCertificate).not.toHaveBeenCalled();
    expect(spy.log.mock.calls[0]?.[0].action).toBe('duplicate_ignored');
  });

  it('looks for duplicates within one client only', async () => {
    const { db, spy, bucket } = fakes(null);
    await ingest(file, opts(db, bucket));
    expect(spy.findByContentHash).toHaveBeenCalledWith('co-1', await sha256(file.bytes));
  });

  it('files an unidentified sender under "unmatched" rather than failing', async () => {
    const { db, bucket, put } = fakes(null);
    await ingest(file, { ...opts(db, bucket), subcontractorId: null, source: 'email' });
    expect(put.mock.calls[0]?.[0]).toContain('/unmatched/');
  });

  it('a different document from the same vendor is not a duplicate', async () => {
    const other = { ...file, bytes: new TextEncoder().encode('%PDF-1.7 a different one') };
    expect(await sha256(other.bytes)).not.toBe(await sha256(file.bytes));
  });
});
