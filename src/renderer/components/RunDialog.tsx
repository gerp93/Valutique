import { useEffect, useMemo, useState } from 'react';
import { AiConnector, AiTask, AiTier, AI_TASK_LABELS, AI_TIERS, AI_TIER_LABELS, AI_TIER_DESCRIPTIONS } from '@shared/types/connector';
import { BatchEstimate } from '@shared/types/job';
import { ItemAiStatus } from '@shared/types/item';
import { BILLING_MODE_BADGES } from '@shared/providerTemplates';
import { formatDuration, formatTokens } from '../utils/format';

/** The minimal shape RunDialog needs to know whether a task already ran on an item. */
export interface RunnableItem {
  id: string;
  name: string;
  aiStatus: ItemAiStatus;
  estimatedValue: number | null;
}

/** Whether this task has already produced a result for this item. */
function isDone(item: RunnableItem, task: AiTask): boolean {
  if (task === 'identify') return item.aiStatus === 'done' || Boolean(item.name);
  if (task === 'appraise') return item.estimatedValue !== null;
  return false;
}

/**
 * Confirmation shown before any batch run.
 *
 * This is the heart of the cost surface: the same 40 items cost a few dollars
 * on an API key and nothing at all on a subscription, and take twenty minutes
 * versus most of a night. Switching connector here re-estimates live, so the
 * choice is made with both numbers visible rather than discovered afterwards.
 *
 * Defaults to only the items this task hasn't already run on -- re-running
 * identify or appraisal across a whole collection you've already processed
 * is rarely what "click Identify" meant, so redoing finished items is an
 * explicit opt-in rather than the default blast radius.
 */
export default function RunDialog({
  task,
  items,
  itemNoun,
  onClose,
  onConfirmed,
}: {
  task: AiTask;
  items: RunnableItem[];
  itemNoun: string;
  onClose: () => void;
  onConfirmed: (queued: number) => void;
}) {
  const [connectors, setConnectors] = useState<AiConnector[]>([]);
  const [connectorId, setConnectorId] = useState<string | null>(null);
  // Deep matches today's behavior (search + verified comps) -- Quick is an
  // explicit opt-in each time, not a sticky preference, so a run always says
  // out loud which rigor it's using.
  const [tier, setTier] = useState<AiTier>('deep');
  const [estimate, setEstimate] = useState<BatchEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A single explicitly-chosen item (the item detail page's Re-identify /
  // Re-appraise buttons) is already an unambiguous redo request -- the
  // checkbox only earns its keep as a guard against silently re-running a
  // whole batch you didn't mean to.
  const singleTarget = items.length === 1;

  const doneCount = useMemo(() => items.filter((item) => isDone(item, task)).length, [items, task]);
  const [redoDone, setRedoDone] = useState(false);

  const itemIds = useMemo(
    () =>
      (singleTarget || redoDone ? items : items.filter((item) => !isDone(item, task))).map((item) => item.id),
    [items, task, redoDone, singleTarget]
  );

  useEffect(() => {
    void (async () => {
      const [all, bindings] = await Promise.all([
        window.valutique.connectors.getAll(),
        window.valutique.connectors.getBindings(),
      ]);
      const enabled = all.filter((connector) => connector.enabled);
      setConnectors(enabled);
      setConnectorId(
        bindings.find((binding) => binding.task === task && binding.tier === tier)?.connectorId ??
          enabled[0]?.id ??
          null
      );
    })();
  }, [task, tier]);

  useEffect(() => {
    void window.valutique.queue.estimate(task, tier, itemIds, connectorId).then(setEstimate);
  }, [task, tier, itemIds, connectorId]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      // The queue reads the task/tier binding itself, so a one-off connector
      // choice is applied by setting the binding before enqueuing.
      const bindings = await window.valutique.connectors.getBindings();
      const bound = bindings.find((binding) => binding.task === task && binding.tier === tier)?.connectorId ?? null;
      if (connectorId && connectorId !== bound) {
        await window.valutique.connectors.setBinding(task, tier, connectorId);
      }

      const queued = await window.valutique.queue.enqueue(task, tier, itemIds, null);
      onConfirmed(queued);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const blocked = connectors.length === 0;

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>
          {AI_TASK_LABELS[task]} — {itemIds.length} {itemIds.length === 1 ? itemNoun : `${itemNoun}s`}
        </h2>

        <div className="tab-bar" style={{ marginBottom: 8 }} role="tablist" aria-label="Rigor">
          {AI_TIERS.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={tier === option}
              className={`tab-button${tier === option ? ' active' : ''}`}
              onClick={() => setTier(option)}
              disabled={busy}
            >
              {AI_TIER_LABELS[option]}
            </button>
          ))}
        </div>
        <p className="card-hint" style={{ marginBottom: 12 }}>
          {AI_TIER_DESCRIPTIONS[tier]}
        </p>

        {!singleTarget && doneCount > 0 && (
          <label className="field-inline" style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={redoDone} onChange={(event) => setRedoDone(event.target.checked)} />
            <span>
              Redo the {doneCount} already {task === 'identify' ? 'identified' : 'valued'} {doneCount === 1 ? itemNoun : `${itemNoun}s`}
            </span>
          </label>
        )}

        {blocked ? (
          <>
            <p className="card-hint">
              No AI connector is set up yet. Add one in Settings — the Claude Code and Gemini CLI options use a
              subscription you already have and cost nothing per item.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label>Run this on</label>
              <select value={connectorId ?? ''} onChange={(event) => setConnectorId(event.target.value || null)}>
                {connectors.map((connector) => (
                  <option key={connector.id} value={connector.id}>
                    {connector.name} — {BILLING_MODE_BADGES[connector.billingMode]}
                  </option>
                ))}
              </select>
            </div>

            {itemIds.length === 0 ? (
              <p className="card-hint">
                Every {itemNoun} here already has a result for this task. Check the box above to redo them.
              </p>
            ) : (
              estimate && (
                <>
                  <div className="stat-row" style={{ marginBottom: 12 }}>
                    <div className="card">
                      <div className="stat-label">Cost</div>
                      <div className="stat-value" style={{ fontSize: 20 }}>
                        {estimate.estimatedCost === null
                          ? 'Free'
                          : estimate.estimatedCost < 0.01
                            ? '<0.01'
                            : estimate.estimatedCost.toFixed(2)}
                      </div>
                      <div className="stat-sub">{estimate.billingMode}</div>
                    </div>
                    <div className="card">
                      <div className="stat-label">Time</div>
                      <div className="stat-value" style={{ fontSize: 20 }}>
                        {formatDuration(estimate.estimatedSeconds)}
                      </div>
                      <div className="stat-sub">runs in the background</div>
                    </div>
                  </div>

                  <p className="card-hint" style={{ marginBottom: 12 }}>
                    {estimate.costSummary}
                  </p>

                  <div className="connector-billing">
                    About {formatTokens(estimate.estimatedTokensIn)} in / {formatTokens(estimate.estimatedTokensOut)}{' '}
                    out
                    {estimate.estimatedSearches > 0 && ` · ${estimate.estimatedSearches} web searches`}
                  </div>

                  {estimate.warnings.map((warning) => (
                    <div key={warning} className="banner banner-warn" style={{ marginTop: 12, marginBottom: 0 }}>
                      {warning}
                    </div>
                  ))}
                </>
              )
            )}

            {error && <div className="banner banner-bad" style={{ marginTop: 12 }}>{error}</div>}

            <div className="modal-actions">
              <button className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void confirm()}
                disabled={busy || !connectorId || itemIds.length === 0}
              >
                {busy ? 'Queuing…' : 'Start'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
