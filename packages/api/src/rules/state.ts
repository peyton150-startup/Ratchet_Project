import type { PoolClient } from 'pg';
import type { EvalContext, StateProvider } from './condition';

// Loan-pipeline stage order (docs/demo-domain.md), used to rank "past underwriting" etc.
const STAGE_RANK: Record<string, number> = {
  application: 0,
  'document collection': 1,
  verification: 2,
  underwriting: 3,
  conditions: 4,
  closing: 5,
};

export interface ScanTarget {
  entityId: string;
  applicationId?: string;
  documentId?: string;
}

/** Enumerates targets for scheduled sweeps (R11). */
export interface ScanProvider {
  scan(name: string, now: Date): Promise<ScanTarget[]>;
}

const STATE_PREDICATES = new Set(['all_required_docs_verified', 'application_stage_rank']);
const SCAN_PREDICATES = new Set(['stale_documents_at_underwriting']);

/**
 * State/scan predicates backed by the append-only event log. Runs inside the caller's tenant
 * transaction, so RLS scopes every query to the current tenant. This is the allowlisted host-code
 * escape hatch from ADR-004 — cross-entity logic lives here, tested, not in the DSL.
 */
// Every scan is bounded: an unbounded result set is a latent outage once a tenant has enough data
// (Nygard). If a sweep hits the cap it is doing too much work in one pass — the cap makes that
// visible instead of letting the worker balloon.
const MAX_SCAN_ROWS = Number(process.env.MAX_SCAN_ROWS ?? 1000);

export class PgStateProvider implements StateProvider, ScanProvider {
  constructor(private readonly client: PoolClient) {}

  async resolve(name: string, ctx: EvalContext): Promise<unknown> {
    if (!STATE_PREDICATES.has(name)) throw new Error(`unknown state predicate: ${name}`);
    const applicationId = (ctx.payload['applicationId'] as string | undefined) ?? ctx.event.entityId;

    if (name === 'all_required_docs_verified') {
      const res = await this.client.query<{ doc_type: string }>(
        `SELECT payload->>'docType' AS doc_type
           FROM events
          WHERE event_type = 'verification.completed'
            AND payload->>'applicationId' = $1
            AND payload->>'outcome' = 'pass'
          LIMIT $2`,
        [applicationId, MAX_SCAN_ROWS],
      );
      const verified = new Set(res.rows.map((r) => r.doc_type));
      const incomeVerified = verified.has('paystub') || verified.has('W2');
      const assetsVerified = verified.has('bank_statement');
      return incomeVerified && assetsVerified;
    }

    // application_stage_rank: rank of the application's most recent stage in the event log.
    const res = await this.client.query<{ stage: string | null }>(
      `SELECT payload->>'stage' AS stage
         FROM events
        WHERE event_type LIKE 'application.%'
          AND entity_id = $1
        ORDER BY occurred_at DESC
        LIMIT 1`,
      [applicationId],
    );
    const stage = res.rows[0]?.stage ?? null;
    return stage !== null && stage in STAGE_RANK ? STAGE_RANK[stage] : -1;
  }

  async scan(name: string, now: Date): Promise<ScanTarget[]> {
    if (!SCAN_PREDICATES.has(name)) throw new Error(`unknown scan predicate: ${name}`);
    // Documents older than 60 days on applications whose latest stage is underwriting (R11).
    const res = await this.client.query<{ application_id: string; document_id: string }>(
      `WITH latest_stage AS (
         SELECT DISTINCT ON (entity_id) entity_id AS application_id, payload->>'stage' AS stage
           FROM events
          WHERE event_type LIKE 'application.%'
          ORDER BY entity_id, occurred_at DESC
       ),
       docs AS (
         SELECT payload->>'applicationId' AS application_id,
                payload->>'documentId'    AS document_id,
                (payload->>'issuedDate')::timestamptz AS issued_date
           FROM events
          WHERE event_type = 'document.uploaded'
       )
       SELECT d.application_id, d.document_id
         FROM docs d
         JOIN latest_stage s ON s.application_id = d.application_id
        WHERE s.stage = 'underwriting'
          AND d.issued_date < ($1::timestamptz - interval '60 days')
        LIMIT $2`,
      [now.toISOString(), MAX_SCAN_ROWS],
    );
    return res.rows.map((r) => ({
      entityId: r.document_id,
      applicationId: r.application_id,
      documentId: r.document_id,
    }));
  }
}
