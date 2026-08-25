/** What the model is asked to return. Mirrors the JSON schema in src/prompt.ts. */
export interface Extraction {
  document_type: 'acord_25' | 'other';
  producer_name: string | null;
  insured_entity_name: string | null;
  carrier_name: string | null;
  gl_policy_number: string | null;
  gl_each_occurrence_limit: number | null;
  gl_general_aggregate_limit: number | null;
  /** YYYY-MM-DD */
  gl_expiration_date: string | null;
  additional_insured_included: boolean | null;
  waiver_of_subrogation_included: boolean | null;
  certificate_holder_text: string | null;
  confidence_score: number;
}

/** A client's insurance requirements. Every check in validate() reads from here. */
export interface Requirements {
  min_gl_each_occurrence: number;
  min_gl_aggregate: number;
  require_additional_insured: boolean;
  require_waiver_subrogation: boolean;
  /** Off by default so a client without a configured name is never blocked. */
  require_holder_match?: boolean;
  company_name?: string;
  /** Other names this client is legitimately named by: a DBA, a parent entity. */
  holder_aliases?: string[] | null;
}

/**
 * Machine-readable failure slugs. The chase email templates, the Slack alert and
 * the review UI all render from these — never store a prose reason.
 */
export type FailureReason =
  | 'not_an_acord_25'
  | 'low_confidence'
  | 'missing_expiration_date'
  | 'unparseable_expiration_date'
  | 'policy_expired'
  | 'missing_occurrence_limit'
  | 'occurrence_limit_below_minimum'
  | 'missing_aggregate_limit'
  | 'aggregate_limit_below_minimum'
  | 'missing_additional_insured'
  | 'missing_waiver_of_subrogation'
  | 'missing_certificate_holder'
  | 'holder_mismatch'
  | 'unmatched_vendor';

export type VerificationStatus =
  | 'processing'
  | 'auto_approved'
  | 'pending_review'
  | 'rejected'
  | 'expired'
  | 'superseded';
