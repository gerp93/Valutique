import { Database } from 'sql.js';
import { AiTask, BillingMode } from '../../shared/types/connector';
import { ConnectorUsage, TaskUsage, UsageReport } from '../../shared/types/usage';
import { all, one, reqStr, str, num, reqNum } from './helpers';
import { ConnectorService } from './connectorService';

/**
 * Aggregates the job log into the numbers the Cost & Usage screen shows.
 *
 * Everything here is derived from `ai_jobs` rather than a separate ledger, so
 * the reported spend can never drift from the work that actually ran.
 */
export class UsageService {
  constructor(
    private db: Database,
    private connectors: ConnectorService
  ) {}

  getReport(): UsageReport {
    const connectors = this.connectors.getAll();
    const byId = new Map(connectors.map((c) => [c.id, c]));

    const rows = all(
      this.db,
      `SELECT connector_id,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS jobs_done,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS jobs_failed,
              COALESCE(SUM(tokens_in), 0)  AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out,
              COALESCE(SUM(web_searches), 0) AS searches,
              COALESCE(SUM(cost_estimate), 0) AS spend,
              AVG(duration_ms) AS avg_duration,
              MAX(finished_at) AS last_used
         FROM ai_jobs
        WHERE connector_id IS NOT NULL
        GROUP BY connector_id`
    );

    const byConnector: ConnectorUsage[] = rows.map((row) => {
      const id = reqStr(row.connector_id);
      const connector = byId.get(id);
      const billingMode: BillingMode = connector?.billingMode ?? 'api_credits';

      return {
        connectorId: id,
        // Jobs outlive the connector that ran them, so a deleted connector
        // still has to render as something meaningful in the history.
        connectorName: connector?.name ?? 'Deleted connector',
        billingMode,
        currency: connector?.pricing.currency ?? 'USD',
        jobsCompleted: reqNum(row.jobs_done),
        jobsFailed: reqNum(row.jobs_failed),
        tokensIn: reqNum(row.tokens_in),
        tokensOut: reqNum(row.tokens_out),
        webSearches: reqNum(row.searches),
        // There is no dollar figure to report for work that drew on a
        // subscription or ran locally -- showing 0.00 would imply metering
        // that never happened.
        estimatedSpend: billingMode === 'api_credits' ? reqNum(row.spend) : null,
        avgDurationMs: num(row.avg_duration),
        lastUsedAt: str(row.last_used),
      };
    });

    byConnector.sort((a, b) => b.jobsCompleted - a.jobsCompleted);

    const taskRows = all(
      this.db,
      `SELECT task,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS jobs_done,
              COALESCE(SUM(tokens_in), 0)  AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out,
              COALESCE(SUM(cost_estimate), 0) AS spend
         FROM ai_jobs
        GROUP BY task`
    );

    const byTask: TaskUsage[] = taskRows.map((row) => ({
      task: reqStr(row.task) as AiTask,
      jobsCompleted: reqNum(row.jobs_done),
      tokensIn: reqNum(row.tokens_in),
      tokensOut: reqNum(row.tokens_out),
      estimatedSpend: reqNum(row.spend),
    }));

    const totalEstimatedSpend = byConnector.reduce((sum, c) => sum + (c.estimatedSpend ?? 0), 0);
    const freeJobsCompleted = byConnector
      .filter((c) => c.billingMode !== 'api_credits')
      .reduce((sum, c) => sum + c.jobsCompleted, 0);

    return {
      byConnector,
      byTask,
      totalEstimatedSpend,
      currency: connectors[0]?.pricing.currency ?? 'USD',
      freeJobsCompleted,
      estimatedSavings: this.estimateSavings(freeJobsCompleted),
      since: str(one(this.db, `SELECT MIN(created_at) AS first FROM ai_jobs`)?.first),
    };
  }

  /**
   * What the work done on free connectors would have cost on the most
   * expensive metered connector the user has configured. Deliberately based on
   * their own configured prices and their own observed token usage rather than
   * a made-up rate -- if there is nothing to compare against, it reports null
   * instead of inventing a figure.
   */
  private estimateSavings(freeJobs: number): number | null {
    if (freeJobs === 0) return null;

    const paid = this.connectors.getAll().filter((c) => c.billingMode === 'api_credits' && c.pricing.inputPerMTok);
    if (paid.length === 0) return null;

    const dearest = paid.reduce((worst, c) =>
      (c.pricing.outputPerMTok ?? 0) > (worst.pricing.outputPerMTok ?? 0) ? c : worst
    );

    // Average real token usage across every job that recorded it, so the
    // comparison reflects this collection rather than a generic assumption.
    const avg = one(
      this.db,
      `SELECT AVG(tokens_in) AS in_avg, AVG(tokens_out) AS out_avg, AVG(web_searches) AS search_avg
         FROM ai_jobs WHERE status = 'done' AND tokens_in IS NOT NULL`
    );

    const tokensIn = num(avg?.in_avg);
    const tokensOut = num(avg?.out_avg);
    if (!tokensIn && !tokensOut) return null;

    const perJob =
      ((tokensIn ?? 0) / 1_000_000) * (dearest.pricing.inputPerMTok ?? 0) +
      ((tokensOut ?? 0) / 1_000_000) * (dearest.pricing.outputPerMTok ?? 0) +
      ((num(avg?.search_avg) ?? 0) / 1000) * (dearest.pricing.webSearchPerThousand ?? 0);

    return perJob * freeJobs;
  }
}
