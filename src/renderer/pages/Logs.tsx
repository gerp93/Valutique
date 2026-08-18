import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AiJob, JobStatus } from '@shared/types/job';
import { AiConnector, AiTask, AI_TASKS, AI_TASK_LABELS } from '@shared/types/connector';
import { formatDateTime, formatSpend, formatTokens } from '../utils/format';

const STATUSES: JobStatus[] = ['queued', 'running', 'rate_limited', 'done', 'failed', 'cancelled'];
const PAGE_SIZES = [25, 50, 100, 200];

type SortKey = 'when' | 'task' | 'connector' | 'status' | 'tokens' | 'cost';

/**
 * Full job history, split out of Cost & Usage so that page can stay a summary
 * and this one can be the place to actually dig through what ran -- filtered
 * by task/connector/status, sorted, and paged rather than a fixed last-40 list.
 */
export default function Logs() {
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [connectors, setConnectors] = useState<AiConnector[]>([]);
  const [loading, setLoading] = useState(true);

  const [taskFilter, setTaskFilter] = useState<AiTask | ''>('');
  const [connectorFilter, setConnectorFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<JobStatus | ''>('');

  const [sortKey, setSortKey] = useState<SortKey>('when');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  const navigate = useNavigate();

  const refresh = async () => {
    const [nextJobs, nextConnectors] = await Promise.all([
      // A generous cap rather than true server-side paging -- a desktop
      // collection's job history tops out in the low thousands, small enough
      // to filter/sort/page in the renderer, and "Clear finished history"
      // is right here if it ever grows past that.
      window.valutique.queue.recentJobs(2000),
      window.valutique.connectors.getAll(),
    ]);
    setJobs(nextJobs);
    setConnectors(nextConnectors);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    return window.valutique.queue.onState(() => void refresh());
  }, []);

  // Any filter/sort change invalidates the current page.
  useEffect(() => {
    setPage(0);
  }, [taskFilter, connectorFilter, statusFilter, sortKey, sortDir, pageSize]);

  const connectorName = (id: string | null): string => {
    if (!id) return '—';
    return connectors.find((c) => c.id === id)?.name ?? 'Deleted connector';
  };

  const connectorCurrency = (id: string | null): string => {
    return connectors.find((c) => c.id === id)?.pricing.currency ?? 'USD';
  };

  const filtered = useMemo(() => {
    return jobs.filter((job) => {
      if (taskFilter && job.task !== taskFilter) return false;
      if (connectorFilter && job.connectorId !== connectorFilter) return false;
      if (statusFilter && job.status !== statusFilter) return false;
      return true;
    });
  }, [jobs, taskFilter, connectorFilter, statusFilter]);

  const sorted = useMemo(() => {
    const withKey = (job: AiJob): string | number => {
      switch (sortKey) {
        case 'when':
          return job.finishedAt ?? job.createdAt;
        case 'task':
          return AI_TASK_LABELS[job.task] ?? job.task;
        case 'connector':
          return connectorName(job.connectorId);
        case 'status':
          return job.status;
        case 'tokens':
          return (job.tokensIn ?? 0) + (job.tokensOut ?? 0);
        case 'cost':
          return job.costEstimate ?? -1;
      }
    };

    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = withKey(a);
      const bv = withKey(b);
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortKey, sortDir, connectors]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageJobs = sorted.slice(page * pageSize, page * pageSize + pageSize);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortIndicator = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  if (loading) return <p className="text-muted">Loading…</p>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Logs</h1>
          <p className="subtitle">Every AI job that has run, filterable and sortable.</p>
        </div>
        <div className="header-actions">
          <button
            className="btn"
            onClick={async () => {
              await window.valutique.queue.clearHistory();
              await refresh();
            }}
          >
            Clear finished history
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-field">
          <label>Task</label>
          <select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value as AiTask | '')}>
            <option value="">Any</option>
            {AI_TASKS.map((task) => (
              <option key={task} value={task}>
                {AI_TASK_LABELS[task]}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label>Connector</label>
          <select value={connectorFilter} onChange={(event) => setConnectorFilter(event.target.value)}>
            <option value="">Any</option>
            {connectors.map((connector) => (
              <option key={connector.id} value={connector.id}>
                {connector.name}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label>Status</label>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as JobStatus | '')}>
            <option value="">Any</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        {(taskFilter || connectorFilter || statusFilter) && (
          <button
            className="btn btn-small"
            onClick={() => {
              setTaskFilter('');
              setConnectorFilter('');
              setStatusFilter('');
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {jobs.length === 0 ? (
        <div className="card empty-state">
          <h2>Nothing has run yet</h2>
          <p>Identify or appraise something and it shows up here.</p>
        </div>
      ) : (
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th className="sortable" onClick={() => toggleSort('when')}>
                  When{sortIndicator('when')}
                </th>
                <th className="sortable" onClick={() => toggleSort('task')}>
                  Task{sortIndicator('task')}
                </th>
                <th className="sortable" onClick={() => toggleSort('connector')}>
                  Connector{sortIndicator('connector')}
                </th>
                <th className="sortable" onClick={() => toggleSort('status')}>
                  Status{sortIndicator('status')}
                </th>
                <th className="sortable" onClick={() => toggleSort('tokens')}>
                  Tokens{sortIndicator('tokens')}
                </th>
                <th className="sortable" onClick={() => toggleSort('cost')}>
                  Cost{sortIndicator('cost')}
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pageJobs.map((job) => (
                <Fragment key={job.id}>
                  <tr
                    className={job.itemId ? 'clickable-row' : undefined}
                    onClick={() => job.itemId && navigate(`/items/${job.itemId}`)}
                  >
                    <td className="text-muted">{formatDateTime(job.finishedAt ?? job.createdAt)}</td>
                    <td>{AI_TASK_LABELS[job.task] ?? job.task}</td>
                    <td className="text-muted">{connectorName(job.connectorId)}</td>
                    <td>
                      <span className={`pill${statusTone(job.status)}`}>{job.status.replace('_', ' ')}</span>
                      {job.error && (
                        <div className="text-muted" style={{ fontSize: 12, marginTop: 3, maxWidth: '48ch' }}>
                          {job.error}
                        </div>
                      )}
                    </td>
                    <td className="text-muted">
                      {job.tokensIn === null ? '—' : `${formatTokens(job.tokensIn)} / ${formatTokens(job.tokensOut)}`}
                    </td>
                    <td>
                      {job.costEstimate === null ? '—' : formatSpend(job.costEstimate, connectorCurrency(job.connectorId))}
                    </td>
                    <td>
                      {job.cliLog && (
                        <button
                          className="btn btn-small"
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedLogId((current) => (current === job.id ? null : job.id));
                          }}
                        >
                          {expandedLogId === job.id ? 'Hide log' : 'View log'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedLogId === job.id && job.cliLog && (
                    <tr>
                      <td colSpan={7} style={{ padding: 0 }}>
                        <div className="console-output" style={{ maxHeight: 320 }}>
                          {job.cliLog.split('\n').map((line, index) => (
                            <div key={index} className="console-line">
                              {line}
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>

          <div className="pagination-bar">
            <span className="text-muted" style={{ fontSize: 12.5 }}>
              {sorted.length === 0
                ? 'No matching jobs'
                : `${page * pageSize + 1}–${Math.min(sorted.length, (page + 1) * pageSize)} of ${sorted.length}`}
            </span>
            <span className="spacer" />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              Per page
              <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-small" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span className="text-muted" style={{ fontSize: 12.5 }}>
              Page {page + 1} of {pageCount}
            </span>
            <button className="btn btn-small" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function statusTone(status: string): string {
  if (status === 'done') return ' pill-good';
  if (status === 'failed') return ' pill-bad';
  if (status === 'rate_limited') return ' pill-warn';
  return '';
}
