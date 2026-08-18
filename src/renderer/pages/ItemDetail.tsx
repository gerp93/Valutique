import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Appraisal } from '@shared/types/appraisal';
import { FieldDef } from '@shared/types/fieldDef';
import { CONDITION_GRADES, CONDITION_LABELS, ConditionGrade, ItemDetail as ItemDetailType } from '@shared/types/item';
import { AiTask } from '@shared/types/connector';
import PhotoImage from '../components/PhotoImage';
import PhotoLightbox from '../components/PhotoLightbox';
import RunDialog from '../components/RunDialog';
import { describeComp, formatDateTime, formatMoney, formatPercent, formatRange } from '../utils/format';

export default function ItemDetail() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();

  const [item, setItem] = useState<ItemDetailType | null>(null);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [runTask, setRunTask] = useState<AiTask | null>(null);
  const [tab, setTab] = useState<'details' | 'valuation' | 'history'>('details');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [addingPhotos, setAddingPhotos] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  // Which photo is shown large. Separate from which one is the cover photo --
  // clicking a thumbnail to look at it and clicking a thumbnail to make it the
  // card's cover used to be the same action, which meant just browsing your
  // own photos silently changed the cover every time.
  const [viewingPhotoId, setViewingPhotoId] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!itemId) return;
    const detail = await window.valutique.items.getDetail(itemId);
    setItem(detail);
    if (detail) {
      setFields(await window.valutique.fields.getForCollection(detail.collectionId));
    }
  }, [itemId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return window.valutique.queue.onState(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    setViewingPhotoId(null);
  }, [itemId]);

  if (!item) return <p className="text-muted">Loading…</p>;

  const current = item.currentAppraisal;

  const viewedPhoto =
    item.photos.find((photo) => photo.id === viewingPhotoId) ??
    item.photos.find((photo) => photo.isPrimary) ??
    item.photos[0] ??
    null;
  const viewedPhotoIndex = viewedPhoto ? item.photos.findIndex((photo) => photo.id === viewedPhoto.id) : -1;

  const saveBase = async (patch: Parameters<typeof window.valutique.items.update>[1]) => {
    setSaving(true);
    try {
      await window.valutique.items.update(item.id, patch);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const saveField = async (field: FieldDef, value: string) => {
    await window.valutique.items.setFieldValues(item.id, { [field.key]: value });
    setDraft((previous) => {
      const next = { ...previous };
      delete next[field.key];
      return next;
    });
    await refresh();
  };

  /**
   * Adds photos directly to this item, bypassing the collection-level import
   * pipeline entirely. That pipeline's whole job is figuring out which photos
   * belong to which item -- a question already answered here, since the user
   * opened this exact item and is dropping more angles of the same thing.
   */
  const addPhotos = async () => {
    const paths = await window.valutique.import.pickFiles();
    if (paths.length === 0) return;

    setAddingPhotos(true);
    setPhotoError(null);
    try {
      const result = await window.valutique.photos.addToItem(item.id, paths);
      if (result.failed.length > 0) {
        setPhotoError(
          `${result.added.length} of ${paths.length} photo${paths.length === 1 ? '' : 's'} added. ` +
            `Couldn't add: ${result.failed.map((f) => `${f.fileName} (${f.error})`).join('; ')}`
        );
      }
      await refresh();
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingPhotos(false);
    }
  };

  const setCoverPhoto = async (photoId: string) => {
    await window.valutique.photos.setPrimary(photoId);
    await refresh();
  };

  const deletePhoto = async (photoId: string) => {
    await window.valutique.photos.delete(photoId);
    setViewingPhotoId(null);
    await refresh();
  };

  return (
    <>
      <button className="breadcrumb" onClick={() => navigate(`/collections/${item.collectionId}`)}>
        ← Back to collection
      </button>

      <div className="page-header">
        <div>
          <h1>{item.name || 'Not yet identified'}</h1>
          <p className="subtitle">
            {current
              ? `Valued ${formatDateTime(current.createdAt)} by ${current.connectorLabel}`
              : 'No valuation yet'}
          </p>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => setRunTask('identify')}>
            Re-identify
          </button>
          <button className="btn btn-primary" onClick={() => setRunTask('appraise')}>
            {current ? 'Re-appraise' : 'Appraise'}
          </button>
        </div>
      </div>

      {item.aiStatus === 'error' && item.aiError && (
        <div className="banner banner-bad">
          <strong>The last AI run failed.</strong> {item.aiError}
        </div>
      )}

      {item.aiStatus === 'running' && <div className="banner">Working on this now…</div>}

      <div className="grid-2" style={{ alignItems: 'start', gridTemplateColumns: '1.1fr 1fr' }}>
        <div>
          <div className="card">
            {item.photos.length > 0 && viewedPhoto ? (
              <>
                <PhotoImage
                  path={viewedPhoto.relativePath}
                  className="photo-hero photo-hero-clickable"
                  onClick={() => setLightboxOpen(true)}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {!viewedPhoto.isPrimary && (
                    <button className="btn btn-small" onClick={() => void setCoverPhoto(viewedPhoto.id)}>
                      Set as cover
                    </button>
                  )}
                  {item.photos.length > 1 && (
                    <button className="btn btn-small btn-danger" onClick={() => void deletePhoto(viewedPhoto.id)}>
                      Delete this photo
                    </button>
                  )}
                </div>
                {item.photos.length > 1 && (
                  <>
                    <p className="text-muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 6 }}>
                      Click a photo to view it larger.
                    </p>
                    <div className="photo-strip">
                      {item.photos.map((photo) => (
                        <button
                          key={photo.id}
                          className={`photo-tile${photo.isPrimary ? ' primary' : ''}`}
                          style={
                            photo.id === viewedPhoto.id && !photo.isPrimary
                              ? { outline: '2px solid var(--color-text)', outlineOffset: 1 }
                              : undefined
                          }
                          title={photo.isPrimary ? 'Cover photo' : 'View larger'}
                          onClick={() => setViewingPhotoId(photo.id)}
                        >
                          <PhotoImage path={photo.relativePath} />
                          {photo.isPrimary && <span className="photo-tile-badge">Cover</span>}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {photoError && (
                  <div className="banner banner-bad" style={{ marginTop: 12, marginBottom: 0 }}>
                    {photoError}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button className="btn btn-small" disabled={addingPhotos} onClick={() => void addPhotos()}>
                    {addingPhotos ? 'Adding…' : 'Add more photos'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-muted">No photos on this item.</p>
                {photoError && (
                  <div className="banner banner-bad" style={{ marginTop: 8, marginBottom: 8 }}>
                    {photoError}
                  </div>
                )}
                <button className="btn btn-small" disabled={addingPhotos} onClick={() => void addPhotos()}>
                  {addingPhotos ? 'Adding…' : 'Add photos'}
                </button>
              </>
            )}
          </div>
        </div>

        <div>
          <div className="tab-bar">
            <button className={`tab-button${tab === 'details' ? ' active' : ''}`} onClick={() => setTab('details')}>
              Details
            </button>
            <button className={`tab-button${tab === 'valuation' ? ' active' : ''}`} onClick={() => setTab('valuation')}>
              Valuation
            </button>
            <button className={`tab-button${tab === 'history' ? ' active' : ''}`} onClick={() => setTab('history')}>
              History ({item.appraisalHistory.length})
            </button>
          </div>

          {tab === 'details' && (
            <div className="card">
              <div className="field">
                <label>Name</label>
                <input
                  defaultValue={item.name}
                  onBlur={(event) => void saveBase({ name: event.target.value })}
                  disabled={saving}
                />
              </div>

              <div className="field">
                <label>Description</label>
                <textarea
                  defaultValue={item.description ?? ''}
                  onBlur={(event) => void saveBase({ description: event.target.value })}
                  disabled={saving}
                />
              </div>

              <div className="grid-2">
                <div className="field">
                  <label>Condition</label>
                  <select
                    value={item.conditionGrade}
                    onChange={(event) => void saveBase({ conditionGrade: event.target.value as ConditionGrade })}
                  >
                    {CONDITION_GRADES.map((grade) => (
                      <option key={grade} value={grade}>
                        {CONDITION_LABELS[grade]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Where it is</label>
                  <input
                    defaultValue={item.location ?? ''}
                    placeholder="Garage shelf B, bin 3"
                    onBlur={(event) => void saveBase({ location: event.target.value })}
                  />
                </div>
              </div>

              {item.conditionNotes && (
                <div className="field">
                  <label>Condition notes</label>
                  <textarea
                    defaultValue={item.conditionNotes}
                    onBlur={(event) => void saveBase({ conditionNotes: event.target.value })}
                  />
                </div>
              )}

              {fields.map((field) => {
                const value = item.fieldValues.find((entry) => entry.fieldDefId === field.id);
                const key = field.key;
                const shown = draft[key] ?? (value ? formatEditable(value.value) : '');

                return (
                  <div className="field" key={field.id}>
                    <label>
                      {field.label}
                      {value?.fromAi && <span className="pill pill-ai" style={{ marginLeft: 8 }}>AI</span>}
                    </label>
                    {field.dataType === 'enum' ? (
                      <>
                        <select value={shown} onChange={(event) => void saveField(field, event.target.value)}>
                          <option value="">—</option>
                          {field.options.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                          {/*
                            A stored value that isn't in the current option list
                            has to render as *something* -- an AI-suggested list
                            missing a real value, or an option renamed after the
                            fact, both leave a value stranded here. A plain
                            <select> would otherwise fall back to silently
                            showing the first option instead, indistinguishable
                            from a real answer. This makes the mismatch visible
                            and keeps the actual stored text intact rather than
                            replacing it with a guess.
                          */}
                          {shown && !field.options.includes(shown) && (
                            <option value={shown}>{shown} (not a listed option)</option>
                          )}
                        </select>
                        {shown && !field.options.includes(shown) && (
                          <span className="field-hint" style={{ color: 'var(--color-accent-red)' }}>
                            "{shown}" isn't one of this field's options. Pick the right one, or edit the field to add
                            it under Fields.
                          </span>
                        )}
                      </>
                    ) : (
                      <input
                        value={shown}
                        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                        onBlur={(event) => void saveField(field, event.target.value)}
                      />
                    )}
                  </div>
                );
              })}

              <div className="field">
                <label>Your notes (never touched by the AI)</label>
                <textarea
                  defaultValue={item.notes ?? ''}
                  placeholder="Nothing here but what you type."
                  onBlur={(event) => void saveBase({ notes: event.target.value })}
                />
              </div>

              {item.aiNotes && (
                <div className="field">
                  <label>
                    AI notes
                    <span className="pill pill-ai" style={{ marginLeft: 8, textTransform: 'none' }}>
                      from the last run
                    </span>
                  </label>
                  <textarea value={item.aiNotes} readOnly />
                  <span className="field-hint">
                    What the AI couldn't determine and why, from its most recent run — overwritten each time it runs
                    again, never mixed with your own notes above.
                  </span>
                  <button
                    type="button"
                    className="btn-link"
                    style={{ marginTop: 4, alignSelf: 'flex-start' }}
                    onClick={async () => {
                      await window.valutique.items.clearAiNotes(item.id);
                      await refresh();
                    }}
                  >
                    Clear
                  </button>
                </div>
              )}

              <div className="grid-2">
                <div className="field">
                  <label>Quantity</label>
                  <input
                    type="number"
                    min={1}
                    defaultValue={item.quantity}
                    onBlur={(event) => void saveBase({ quantity: Number(event.target.value) || 1 })}
                  />
                </div>
                <div className="field">
                  <label>What you paid</label>
                  <input
                    type="number"
                    step="0.01"
                    defaultValue={item.acquiredPrice ?? ''}
                    onBlur={(event) =>
                      void saveBase({ acquiredPrice: event.target.value ? Number(event.target.value) : null })
                    }
                  />
                </div>
              </div>

              <button
                className="btn btn-danger btn-small"
                onClick={async () => {
                  await window.valutique.items.delete(item.id);
                  navigate(`/collections/${item.collectionId}`);
                }}
              >
                Delete this item
              </button>
            </div>
          )}

          {tab === 'valuation' && <ValuationPanel appraisal={current} />}

          {tab === 'history' && (
            <div className="card">
              {item.appraisalHistory.length === 0 ? (
                <p className="text-muted">No valuations yet.</p>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Value</th>
                      <th>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {item.appraisalHistory.map((appraisal) => (
                      <tr key={appraisal.id}>
                        <td>{formatDateTime(appraisal.createdAt)}</td>
                        <td>
                          {formatMoney(appraisal.valueMid, appraisal.currency)}
                          {appraisal.isCurrent && <span className="pill pill-good" style={{ marginLeft: 6 }}>current</span>}
                        </td>
                        <td className="text-muted">
                          {appraisal.connectorLabel}
                          {appraisal.searchUnavailable && (
                            <div>
                              <span className="pill pill-warn">no web search</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>

      {runTask && (
        <RunDialog
          task={runTask}
          items={[{ id: item.id, name: item.name, aiStatus: item.aiStatus, estimatedValue: item.currentAppraisal?.valueMid ?? null }]}
          itemNoun="item"
          onClose={() => setRunTask(null)}
          onConfirmed={() => {
            setRunTask(null);
            void refresh();
          }}
        />
      )}

      {lightboxOpen && viewedPhotoIndex >= 0 && (
        <PhotoLightbox
          photos={item.photos}
          index={viewedPhotoIndex}
          onIndexChange={(nextIndex) => setViewingPhotoId(item.photos[nextIndex]?.id ?? null)}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </>
  );
}

function ValuationPanel({ appraisal }: { appraisal: Appraisal | null }) {
  if (!appraisal) {
    return (
      <div className="card">
        <p className="text-muted">Not valued yet. Use Appraise above.</p>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <div className="stat-label">Estimated value</div>
        <div className="stat-value">{formatMoney(appraisal.valueMid, appraisal.currency)}</div>
        <div className="stat-sub">
          Range {formatRange(appraisal.valueLow, appraisal.valueHigh, appraisal.currency)} · confidence{' '}
          {formatPercent(appraisal.confidence)}
        </div>

        {appraisal.searchUnavailable && (
          <div className="banner banner-warn" style={{ marginTop: 14, marginBottom: 0 }}>
            This valuation was produced without web access, so it reflects the model's own knowledge rather than
            current listings. Bind the appraise task to a connector that can search for a figure backed by real
            comparables.
          </div>
        )}

        {appraisal.rationale && (
          <>
            <div className="stat-label" style={{ marginTop: 18 }}>
              How it got there
            </div>
            <p style={{ fontSize: 13.5, lineHeight: 1.6, marginTop: 6 }}>{appraisal.rationale}</p>
          </>
        )}
      </div>

      <div className="card">
        <h2>Comparable listings</h2>
        <p className="card-hint">
          {appraisal.comps.length === 0
            ? 'None were found. The range above comes from the model’s own read rather than specific listings — treat it as a wider guess.'
            : 'Every link was checked. An unverified one may have been invented by the model, so weigh it accordingly.'}
        </p>

        {appraisal.comps.map((comp) => {
          const badge = describeComp(comp);
          return (
            <div key={comp.id} className="comp-row">
              <div className="comp-main">
                <div className="comp-title">{comp.title || comp.source}</div>
                <button className="comp-link" onClick={() => void window.valutique.shell.openExternal(comp.url)}>
                  {comp.url}
                </button>
                {comp.similarityNote && (
                  <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>
                    {comp.similarityNote}
                  </div>
                )}
                <div style={{ marginTop: 4 }}>
                  <span className={`pill pill-${badge.tone}`}>{badge.label}</span>
                  {comp.condition && <span className="pill" style={{ marginLeft: 4 }}>{comp.condition}</span>}
                </div>
              </div>
              <div className="comp-price">{formatMoney(comp.price, comp.currency ?? appraisal.currency)}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function formatEditable(value: string | number | boolean | string[] | null): string {
  if (value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}
