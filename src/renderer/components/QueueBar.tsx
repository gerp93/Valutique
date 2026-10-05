import { useEffect, useState } from 'react';
import { FailedJob, QueueState } from '@shared/types/job';
import { AI_TASK_LABELS, AI_TIER_LABELS } from '@shared/types/connector';
import { formatDuration, formatRelative } from '../utils/format';

/**
 * Always-visible strip showing what the queue is doing.
 *
 * The case this is really built for is the rate-limit pause: on a subscription
 * connector a big batch *will* run out of allowance, and the difference between
 * an app that looks broken and one that looks patient is telling the user it
 * paused on purpose and when it will pick back up.
 */
export default function QueueBar() {
  const [state, setState] = useState<QueueState | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewingFailed, setReviewingFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    window.valutique.queue.getState().then((initial) => {
      if (!cancelled) setState(initial);
    });

    const unsubscribe = window.valutique.queue.onState((next) => {
      if (!cancelled) setState(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (!state) return null;

  const { counts } = state;
  const pending =
    counts.queued + counts.running + counts.rate_limited + counts.batch_queued + counts.batch_pending;
  const finished = counts.done;
  const total = pending + finished;

  // Nothing pending and nothing to complain about: stay out of the way.
  if (pending === 0 && counts.failed === 0) return null;

  const percent = total > 0 ? Math.round((finished / total) * 100) : 0;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setState(await window.valutique.queue.getState());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="queue-bar">
      <span className="queue-bar-status">{describeStatus(state, pending)}</span>

      {pending > 0 && (
        <div className="progress-track" title={`${finished} of ${total} done`}>
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
      )}

      <span className="queue-bar-detail">{describeDetail(state, pending)}</span>

      <div className="queue-bar-actions">
        {counts.failed > 0 && (
          <button className="btn btn-small" disabled={busy} onClick={() => setReviewingFailed(true)}>
            {counts.failed} failed
          </button>
        )}
        {pending > 0 &&
          (state.paused ? (
            <button className="btn btn-small" disabled={busy} onClick={() => void run(() => window.valutique.queue.resume())}>
              Resume now
            </button>
          ) : (
            <button className="btn btn-small" disabled={busy} onClick={() => void run(() => window.valutique.queue.pause())}>
              Pause
            </button>
          ))}
        {pending > 0 && (
          <button className="btn btn-small btn-danger" disabled={busy} onClick={() => void run(() => window.valutique.queue.cancelAll())}>
            Cancel
          </button>
        )}
      </div>

      {reviewingFailed && (
        <FailedJobsDialog
          onClose={() => setReviewingFailed(false)}
          onRetried={() => {
            setReviewingFailed(false);
            void window.valutique.queue.getState().then(setState);
          }}
        />
      )}
    </div>
  );
}

/**
 * Lists what actually failed and lets the user choose. Retrying everything
 * blindly was the old behaviour and it was dangerous: most failures had already
 * been redone successfully, so "retry all" meant paying to recompute results
 * the items already had.
 */
function FailedJobsDialog({ onClose, onRetried }: { onClose: () => void; onRetried: () => void }) {
  const [jobs, setJobs] = useState<FailedJob[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    void window.valutique.queue.failedJobs().then((found) => {
      setJobs(found);
      setSelected(new Set(found.map((job) => job.id)));
    });
  }, []);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const retry = async () => {
    setRetrying(true);
    try {
      await window.valutique.queue.retryFailed([...selected]);
      onRetried();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={retrying ? undefined : onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <h2>Failed jobs</h2>
        <p className="card-hint">
          Only failures that have not since been redone successfully are listed. Anything retried elsewhere and
          finished has dropped off on its own.
        </p>

        {jobs === null ? (
          <p className="text-muted">Loading…</p>
        ) : jobs.length === 0 ? (
          <p className="text-muted">Nothing left to retry.</p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <button className="btn btn-small" onClick={() => setSelected(new Set(jobs.map((j) => j.id)))}>
                Select all
              </button>
              <button className="btn btn-small" onClick={() => setSelected(new Set())}>
                Select none
              </button>
            </div>

            <div className="failed-job-list">
              {jobs.map((job) => (
                <label key={job.id} className="failed-job">
                  <input type="checkbox" checked={selected.has(job.id)} onChange={() => toggle(job.id)} />
                  <span className="failed-job-body">
                    <span className="failed-job-title">
                      {job.itemName?.trim() || 'Untitled item'}
                      <span className="pill">{AI_TASK_LABELS[job.task]}</span>
                      <span className="pill">{AI_TIER_LABELS[job.tier]}</span>
                    </span>
                    <span className="failed-job-error">{job.error || 'No error recorded.'}</span>
                    <span className="failed-job-meta">
                      {job.attempts} {job.attempts === 1 ? 'attempt' : 'attempts'} · {formatRelative(job.failedAt)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={retrying}>
            Close
          </button>
          <button
            className="btn btn-primary"
            disabled={retrying || selected.size === 0}
            onClick={() => void retry()}
          >
            {retrying ? 'Queueing…' : `Retry ${selected.size} selected`}
          </button>
        </div>
      </div>
    </div>
  );
}

function describeStatus(state: QueueState, pending: number): string {
  if (pending === 0) return `${state.counts.failed} failed`;
  if (state.paused) return 'Paused';
  if (state.counts.running > 0) return `Working on ${state.counts.running}`;
  if (state.counts.batch_pending > 0) return 'Waiting on batch';
  return 'Queued';
}

function describeDetail(state: QueueState, pending: number): string {
  if (pending === 0) {
    return 'Nothing running. Retry the failed items, or open one to see what went wrong.';
  }

  const parts: string[] = [`${pending} to go`];

  // A rate-limit pause carries its own explanation from the provider, which is
  // more useful than anything generic we could write.
  if (state.paused && state.pausedReason) {
    parts.push(state.pausedReason);
    if (state.resumesAt) parts.push(`Resumes ${formatRelative(state.resumesAt)}.`);
    return parts.join(' — ');
  }

  if (state.etaSeconds !== null) {
    parts.push(`about ${formatDuration(state.etaSeconds)} left`);
  }

  const active = state.active[0];
  if (active) {
    parts.push(active.task === 'appraise' ? 'appraising' : 'identifying');
  }

  return parts.join(' — ');
}
