-- Views the chase cron and the client dashboard read from.
--
-- Both derive compliance rather than storing it, so a status can never drift
-- from the certificate it is supposed to describe.

-- Everything one pass of the chase ladder needs, in one query.
create or replace view v_chase_queue as
select
  s.id,
  s.company_id,
  s.vendor_name,
  s.contact_email,
  s.upload_token,
  s.last_chase_stage,
  s.last_chased_at,
  s.active_cert_id,
  c.company_name,
  c.primary_contact_email,
  cert.expiration_date,
  case
    when cert.id is null                             then 'missing'
    when cert.expiration_date < current_date         then 'expired'
    when cert.expiration_date <= current_date + 30   then 'expiring_soon'
    else 'compliant'
  end as compliance_status,
  (cert.expiration_date - current_date) as days_remaining
from subcontractors s
join companies c on c.id = s.company_id
left join certificates cert
  on cert.id = s.active_cert_id
 and cert.verification_status = 'auto_approved'
where c.status = 'active'
  and (
    cert.id is null
    or cert.expiration_date <= current_date + 30
  );

-- The client's compliance grid, plus the fields the audit report prints.
create or replace view v_dashboard as
select
  s.id,
  s.company_id,
  s.vendor_name,
  s.trade,
  s.contact_person,
  s.contact_email,
  s.last_chased_at,
  s.last_chase_stage,
  cert.id                      as certificate_id,
  cert.expiration_date,
  cert.carrier_name,
  cert.gl_policy_number,
  cert.gl_each_occurrence,
  cert.gl_general_aggregate,
  cert.additional_insured,
  cert.waiver_subrogation,
  cert.reviewed_by,
  case
    when cert.id is null                             then 'missing'
    when cert.expiration_date < current_date         then 'expired'
    when cert.expiration_date <= current_date + 30   then 'expiring_soon'
    else 'compliant'
  end as compliance_status,
  (cert.expiration_date - current_date) as days_remaining
from subcontractors s
left join certificates cert
  on cert.id = s.active_cert_id
 and cert.verification_status = 'auto_approved';
