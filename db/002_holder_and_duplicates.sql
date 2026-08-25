-- Holder matching and duplicate detection.
--
-- A certificate naming a different general contractor as the holder is not
-- evidence of coverage for this one, so it must never auto-approve. And the
-- same document mailed twice should cost one extraction, not two.

alter table companies
  add column if not exists require_holder_match boolean not null default true,
  -- Other names this client is legitimately named by on a certificate:
  -- a DBA, a parent entity, the exact legal name with its suffix.
  add column if not exists holder_aliases text[] not null default '{}';

alter table certificates
  add column if not exists content_sha256 text;

-- Duplicate lookup is per client, never across clients — two GCs holding the
-- same subcontractor's certificate is normal and is not a duplicate.
create index if not exists certificates_company_sha_idx
  on certificates (company_id, content_sha256);
