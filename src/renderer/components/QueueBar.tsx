import { useEffect, useState } from 'react';
import { QueueState } from '@shared/types/job';
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
  const pending = counts.queued + counts.running + counts.rate_limited;
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
          <button className="btn btn-small" disabled={busy} onClick={() => void run(() => window.valutique.queue.retryFailed())}>
            Retry {counts.failed} failed
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
    </div>
  );
}

function describeStatus(state: QueueState, pending: number): string {
  if (pending === 0) return `${state.counts.failed} failed`;
  if (state.paused) return 'Paused';
  if (state.counts.running > 0) return `Working on ${state.counts.running}`;
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
