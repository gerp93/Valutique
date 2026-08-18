import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { UsageReport } from '@shared/types/usage';
import { AI_TASK_LABELS } from '@shared/types/connector';
import { BILLING_MODE_BADGES } from '@shared/providerTemplates';
import { formatDateTime, formatDuration, formatSpend, formatTokens } from '../utils/format';

/**
 * Cost & Usage.
 *
 * Answers the question the connector design creates: "what has this actually
 * cost me, and how much of the work ran for free?" Everything here is derived
 * from the job log, so the figures can never drift from the work that ran.
 */
export default function Usage() {
  const [report, setReport] = useState<UsageReport | null>(null);

  const refresh = async () => {
    setReport(await window.valutique.usage.getReport());
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    return window.valutique.queue.onState(() => void refresh());
  }, []);

  if (!report) return <p className="text-muted">Loading…</p>;

  const nothingYet = report.byConnector.length === 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Cost &amp; Usage</h1>
          <p className="subtitle">
            What the AI work has cost, broken down by connector. See <Link to="/logs">Logs</Link> for the full job
            history.
          </p>
        </div>
      </div>

      {nothingYet ? (
        <div className="card empty-state">
          <h2>Nothing has run yet</h2>
          <p>
            Once you identify or appraise anything, this page shows exactly what it cost — and how much of it ran on a
            subscription or locally for nothing.
          </p>
        </div>
      ) : (
        <>
          <div className="stat-row">
            <div className="card">
              <div className="stat-label">Spent on API credits</div>
              <div className="stat-value">{formatSpend(report.totalEstimatedSpend, report.currency)}</div>
              <div className="stat-sub">
                {report.since ? `since ${formatDateTime(report.since)}` : 'estimated from token counts'}
              </div>
            </div>
            <div className="card">
              <div className="stat-label">Ran for free</div>
              <div className="stat-value">{report.freeJobsCompleted}</div>
              <div className="stat-sub">jobs on subscription or local connectors</div>
            </div>
            {report.estimatedSavings !== null && report.estimatedSavings > 0 && (
              <div className="card">
                <div className="stat-label">Avoided</div>
                <div className="stat-value">{formatSpend(report.estimatedSavings, report.currency)}</div>
                <div className="stat-sub">
                  {/* Based on this user's own configured prices and observed
                      token use, not a made-up rate. */}
                  what that free work would have cost on your priciest paid connector
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <h2>By connector</h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Connector</th>
                  <th>Billing</th>
                  <th>Jobs</th>
                  <th>Tokens in / out</th>
                  <th>Searches</th>
                  <th>Avg time</th>
                  <th>Spend</th>
                </tr>
              </thead>
              <tbody>
                {report.byConnector.map((connector) => (
                  <tr key={connector.connectorId}>
                    <td>{connector.connectorName}</td>
                    <td>
                      <span className={`pill${connector.billingMode === 'api_credits' ? '' : ' pill-good'}`}>
                        {BILLING_MODE_BADGES[connector.billingMode]}
                      </span>
                    </td>
                    <td>
                      {connector.jobsCompleted}
                      {connector.jobsFailed > 0 && (
                        <span className="text-muted"> · {connector.jobsFailed} failed</span>
                      )}
                    </td>
                    <td className="text-muted">
                      {formatTokens(connector.tokensIn)} / {formatTokens(connector.tokensOut)}
                    </td>
                    <td className="text-muted">{connector.webSearches || '—'}</td>
                    <td className="text-muted">
                      {connector.avgDurationMs ? formatDuration(connector.avgDurationMs / 1000) : '—'}
                    </td>
                    <td>
                      {/* A dash, not $0.00 -- these connectors were never
                          metered, and a zero would imply they were. */}
                      {connector.estimatedSpend === null
                        ? '—'
                        : formatSpend(connector.estimatedSpend, connector.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>By task</h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Completed</th>
                  <th>Tokens in / out</th>
                  <th>Spend</th>
                </tr>
              </thead>
              <tbody>
                {report.byTask.map((task) => (
                  <tr key={task.task}>
                    <td>{AI_TASK_LABELS[task.task] ?? task.task}</td>
                    <td>{task.jobsCompleted}</td>
                    <td className="text-muted">
                      {formatTokens(task.tokensIn)} / {formatTokens(task.tokensOut)}
                    </td>
                    <td>{formatSpend(task.estimatedSpend, report.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
