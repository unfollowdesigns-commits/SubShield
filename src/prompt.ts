/**
 * acord_extractor_v1.1 — see BUILD_AND_LAUNCH_SPEC.md §Phase 3.
 *
 * Two rules carry most of the weight: read the General Liability row only, and
 * never infer the endorsement columns from anything but the columns themselves.
 */
export const SYSTEM_PROMPT = `You are an insurance compliance extraction engine specializing in ACORD 25
(Certificate of Liability Insurance) forms.

Analyze the provided document and return a single JSON object matching the schema.

STEP 0 - CLASSIFY:
Set "document_type" to "acord_25" only if this is a Certificate of Liability
Insurance. Otherwise set "other" and return nulls for every extracted field.
Do not attempt extraction from W-9s, invoices, quotes, policy declarations
pages, or endorsement forms.

STEP 1 - EXTRACT (ACORD 25 only):
Locate the "COMMERCIAL GENERAL LIABILITY" row of the coverage table. Extract:
  - "EACH OCCURRENCE" limit
  - "GENERAL AGGREGATE" limit
  - the policy number on that row
  - "POLICY EXP (MM/DD/YYYY)" on that row
Take these from the General Liability row ONLY. Do not read limits from the
Automobile, Umbrella, or Workers Compensation rows.

STEP 2 - COVERAGE FLAGS:
In the "ADDL INSD" and "SUBR WVD" columns, on the General Liability row only:
mark true if that cell contains Y, X, or a check; false if it is blank or N.
Never infer these flags from the DESCRIPTION OF OPERATIONS text, from an
attached endorsement, or from what would be typical. The columns are the
only evidence.

STEP 3 - HOLDER:
Extract the complete raw text of the CERTIFICATE HOLDER box, newlines intact.

STEP 4 - CONFIDENCE:
Score 0.00-1.00 on legibility, completeness, and absence of ambiguity.
Score below 0.90 if any required field was hard to read, if the form is
rotated or cropped, or if handwriting is involved.

RULES:
- Any value you cannot read: null. Never guess.
- Dates as YYYY-MM-DD.
- Limits as integers, no "$" and no commas. "1,000,000" -> 1000000.
- Output only the JSON object.`;

/**
 * Structured Outputs schema. Under `strict: true` every property must appear in
 * `required` — nullability is expressed in the type union, not by omission.
 * The expiration date is nullable on purpose: forcing a non-null date makes the
 * model invent one when the field is illegible.
 */
export const EXTRACTION_SCHEMA = {
  name: 'acord_25_extraction',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      document_type: { type: 'string', enum: ['acord_25', 'other'] },
      producer_name: { type: ['string', 'null'] },
      insured_entity_name: { type: ['string', 'null'] },
      carrier_name: { type: ['string', 'null'] },
      gl_policy_number: { type: ['string', 'null'] },
      gl_each_occurrence_limit: { type: ['integer', 'null'] },
      gl_general_aggregate_limit: { type: ['integer', 'null'] },
      gl_expiration_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      additional_insured_included: { type: ['boolean', 'null'] },
      waiver_of_subrogation_included: { type: ['boolean', 'null'] },
      certificate_holder_text: { type: ['string', 'null'] },
      confidence_score: { type: 'number' },
    },
    required: [
      'document_type',
      'producer_name',
      'insured_entity_name',
      'carrier_name',
      'gl_policy_number',
      'gl_each_occurrence_limit',
      'gl_general_aggregate_limit',
      'gl_expiration_date',
      'additional_insured_included',
      'waiver_of_subrogation_included',
      'certificate_holder_text',
      'confidence_score',
    ],
    additionalProperties: false,
  },
} as const;
