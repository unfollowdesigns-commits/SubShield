-- SubShield initial schema. See BUILD_AND_LAUNCH_SPEC.md §Phase 2.
-- Apply with: supabase db push, or paste into the Supabase SQL editor.

create extension if not exists pgcrypto;

-- ─── companies (paying clients) ───────────────────────────────────────────────
create table if not exists companies (
  id                          uuid primary key default gen_random_uuid(),
  company_name                text not null,
  primary_contact_name        text,
  primary_contact_email       text not null,
  inbound_alias               text unique not null,
  min_gl_each_occurrence      bigint not null default 1000000,
  min_gl_aggregate            bigint not null default 2000000,
  require_additional_insured  boolean not null default true,
  require_waiver_subrogation  boolean not null default true,
  slack_webhook_url           text,
  status                      text not null default 'active'
                                check (status in ('active','paused','past_due')),
  created_at                  timestamptz not null default now()
);

-- ─── subcontractors (clients' vendors) ────────────────────────────────────────
create table if not exists subcontractors (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id) on delete cascade,
  vendor_name      text not null,
  trade            text,
  contact_person   text,
  contact_email    text not null,
  contact_phone    text,
  upload_token     text unique not null,
  active_cert_id   uuid,
  last_chased_at   timestamptz,
  last_chase_stage int,
  created_at       timestamptz not null default now(),
  unique (company_id, contact_email)
);

-- ─── certificates (parsed documents) ──────────────────────────────────────────
create table if not exists certificates (
  id                      uuid primary key default gen_random_uuid(),
  subcontractor_id        uuid references subcontractors(id) on delete set null,
  company_id              uuid not null references companies(id) on delete cascade,
  r2_key                  text,
  source                  text not null check (source in ('email','portal','manual')),
  original_filename       text,
  producer_name           text,
  insured_entity_name     text,
  carrier_name            text,
  gl_policy_number        text,
  gl_each_occurrence      bigint,
  gl_general_aggregate    bigint,
  expiration_date         date,
  additional_insured      boolean,
  waiver_subrogation      boolean,
  certificate_holder_text text,
  ai_confidence           numeric(3,2),
  verification_status     text not null default 'processing'
                            check (verification_status in
                              ('processing','auto_approved','pending_review',
                               'rejected','expired','superseded')),
  failure_reasons         text[],
  raw_json_response       jsonb,
  model_used              text,
  extraction_cost_usd     numeric(8,5),
  created_at              timestamptz not null default now(),
  reviewed_by             text,
  reviewed_at             timestamptz
);

do $$ begin
  alter table subcontractors
    add constraint fk_active_cert
    foreign key (active_cert_id) references certificates(id) on delete set null;
exception when duplicate_object then null;
end $$;

-- ─── audit_logs (history) ─────────────────────────────────────────────────────
create table if not exists audit_logs (
  id               bigserial primary key,
  company_id       uuid references companies(id) on delete cascade,
  certificate_id   uuid references certificates(id) on delete set null,
  subcontractor_id uuid references subcontractors(id) on delete set null,
  action           text not null,
  actor            text not null default 'system',
  details          jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists certificates_company_status_idx
  on certificates (company_id, verification_status);
create index if not exists certificates_expiration_idx
  on certificates (expiration_date);
create index if not exists subcontractors_company_idx
  on subcontractors (company_id);
create index if not exists audit_logs_company_time_idx
  on audit_logs (company_id, created_at desc);

-- ─── compliance status is derived, never stored ───────────────────────────────
create or replace view v_subcontractor_status as
select
  s.id,
  s.company_id,
  s.vendor_name,
  s.contact_email,
  s.trade,
  c.expiration_date,
  case
    when c.id is null                          then 'missing'
    when c.expiration_date < current_date      then 'expired'
    when c.expiration_date <= current_date + 30 then 'expiring_soon'
    else 'compliant'
  end as compliance_status,
  c.expiration_date - current_date as days_remaining
from subcontractors s
left join certificates c
  on c.id = s.active_cert_id
 and c.verification_status = 'auto_approved';

-- Row level security: every table is reached only through the Worker's service
-- key, so no policies are granted to anon or authenticated roles. Enabling RLS
-- with no policy means a leaked publishable key reads nothing.
alter table companies       enable row level security;
alter table subcontractors  enable row level security;
alter table certificates    enable row level security;
alter table audit_logs      enable row level security;
