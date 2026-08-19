import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Collection } from '@shared/types/collection';
import { FieldDef } from '@shared/types/fieldDef';
import { CONDITION_LABELS, ItemListEntry } from '@shared/types/item';
import { AiTask } from '@shared/types/connector';
import ImportDialog from '../components/ImportDialog';
import RunDialog from '../components/RunDialog';
import PhotoImage from '../components/PhotoImage';
import FieldEditor from '../components/FieldEditor';
import { DuplicateSuggestion } from '../types';
import { formatFieldValue, formatMoney } from '../utils/format';

export default function CollectionDetail() {
  const { collectionId } = useParams<{ collectionId: string }>();
  const navigate = useNavigate();

  const [collection, setCollection] = useState<Collection | null>(null);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [items, setItems] = useState<ItemListEntry[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicateSuggestion[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [search, setSearch] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [appraisalFilter, setAppraisalFilter] = useState<'' | 'appraised' | 'unappraised'>('');

  const [importing, setImporting] = useState(false);
  const [runTask, setRunTask] = useState<AiTask | null>(null);
  const [editingFields, setEditingFields] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!collectionId) return;
    const [nextCollection, nextFields, nextItems, nextLocations, nextDuplicates] = await Promise.all([
      window.valutique.collections.getById(collectionId),
      window.valutique.fields.getForCollection(collectionId),
      window.valutique.items.list({
        collectionId,
        search: search || undefined,
        location: locationFilter || undefined,
        appraisalState: appraisalFilter || undefined,
      }),
      window.valutique.items.locations(collectionId),
      window.valutique.duplicates.findAll(collectionId),
    ]);

    setCollection(nextCollection);
    setFields(nextFields);
    setItems(nextItems);
    setLocations(nextLocations);
    setDuplicates(nextDuplicates);
  }, [collectionId, search, locationFilter, appraisalFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Items change under us as the queue works, so follow its progress.
  useEffect(() => {
    return window.valutique.queue.onState(() => {
      void refresh();
    });
  }, [refresh]);

  const itemNoun = collection?.itemNoun ?? 'item';

  const stats = useMemo(() => {
    const valued = items.filter((item) => item.estimatedValue !== null);
    const total = valued.reduce((sum, item) => sum + (item.estimatedValue ?? 0) * item.quantity, 0);
    return {
      total,
      valuedCount: valued.length,
      pending: items.filter((item) => item.aiStatus === 'queued' || item.aiStatus === 'running').length,
      errored: items.filter((item) => item.aiStatus === 'error').length,
    };
  }, [items]);

  const toggleSelection = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const targetItems = selected.size > 0 ? items.filter((item) => selected.has(item.id)) : items;

  const mergeSuggestion = async (suggestion: DuplicateSuggestion) => {
    const [target, ...sources] = suggestion.itemIds;
    await window.valutique.items.merge(sources, target);
    setToast('Merged.');
    await refresh();
  };

  if (!collection) return <p className="text-muted">Loading…</p>;

  return (
    <>
      <button className="breadcrumb" onClick={() => navigate('/')}>
        ← Collections
      </button>

      <div className="page-header">
        <div>
          <h1>{collection.name}</h1>
          <p className="subtitle">
            {items.length} {items.length === 1 ? itemNoun : `${itemNoun}s`}
            {fields.length > 0 && ` · ${fields.length} custom fields`}
          </p>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => setEditingFields(true)}>
            Fields
          </button>
          <button className="btn btn-primary" onClick={() => setImporting(true)}>
            Add photos
          </button>
        </div>
      </div>

      <div className="stat-row">
        <div className="card">
          <div className="stat-label">Estimated value</div>
          <div className="stat-value">{formatMoney(stats.total)}</div>
          <div className="stat-sub">
            {/* Never present a total without saying how much of the collection
                it actually covers. */}
            from {stats.valuedCount} of {items.length} {itemNoun}s valued
          </div>
        </div>
        <div className="card">
          <div className="stat-label">In progress</div>
          <div className="stat-value">{stats.pending}</div>
          <div className="stat-sub">{stats.pending > 0 ? 'the queue is working' : 'nothing running'}</div>
        </div>
        {stats.errored > 0 && (
          <div className="card">
            <div className="stat-label">Needs attention</div>
            <div className="stat-value">{stats.errored}</div>
            <div className="stat-sub">open one to see why</div>
          </div>
        )}
      </div>

      {duplicates.length > 0 && (
        <div className="banner banner-warn">
          <strong>{duplicates.length}</strong>{' '}
          {duplicates.length === 1 ? 'set of items looks' : 'sets of items look'} like the same physical {itemNoun},
          identified under the same name. This usually means a few photos of one piece were split apart on import.
          {duplicates.slice(0, 3).map((suggestion) => (
            <div key={suggestion.itemIds.join()} className="banner-actions">
              <span className="text-muted" style={{ flex: 1, fontSize: 13 }}>
                {suggestion.names.filter(Boolean).join(' · ')}
              </span>
              <button className="btn btn-small" onClick={() => void mergeSuggestion(suggestion)}>
                Merge into one
              </button>
            </div>
          ))}
        </div>
      )}

      {toast && (
        <div className="banner" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}

      <div className="filter-bar">
        <div className="filter-field">
          <label>Search</label>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="name, notes, location" />
        </div>
        <div className="filter-field">
          <label>Location</label>
          <select value={locationFilter} onChange={(event) => setLocationFilter(event.target.value)}>
            <option value="">Anywhere</option>
            {locations.map((location) => (
              <option key={location} value={location}>
                {location}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label>Valuation</label>
          <select
            value={appraisalFilter}
            onChange={(event) => setAppraisalFilter(event.target.value as typeof appraisalFilter)}
          >
            <option value="">All</option>
            <option value="appraised">Valued</option>
            <option value="unappraised">Not yet valued</option>
          </select>
        </div>
        <button
          className="btn btn-small"
          onClick={() => {
            setSearch('');
            setLocationFilter('');
            setAppraisalFilter('');
          }}
        >
          Clear
        </button>
      </div>

      {items.length > 0 && (
        <div className="selection-bar">
          <span>
            {selected.size > 0
              ? `${selected.size} selected`
              : `Acting on all ${items.length} shown ${items.length === 1 ? itemNoun : `${itemNoun}s`}`}
          </span>
          {selected.size > 0 && (
            <button className="btn-link" onClick={() => setSelected(new Set())}>
              clear selection
            </button>
          )}
          <span className="spacer" />
          {selected.size > 1 && (
            <button
              className="btn btn-small"
              onClick={async () => {
                const [target, ...sources] = Array.from(selected);
                await window.valutique.items.merge(sources, target);
                setSelected(new Set());
                setToast('Merged.');
                await refresh();
              }}
            >
              Merge selected
            </button>
          )}
          <button className="btn btn-small" onClick={() => setRunTask('identify')} disabled={targetItems.length === 0}>
            Identify
          </button>
          <button className="btn btn-small btn-primary" onClick={() => setRunTask('appraise')} disabled={targetItems.length === 0}>
            Appraise
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="card empty-state">
          <h2>No {itemNoun}s yet</h2>
          <p>
            Add a pile of photos — several angles of one piece and single shots of others, all mixed together.
            Valutique groups them, identifies each one, and values it without you sorting anything first.
          </p>
          <button className="btn btn-primary" onClick={() => setImporting(true)}>
            Add photos
          </button>
        </div>
      ) : (
        <div className="item-grid">
          {items.map((item) => (
            <div
              key={item.id}
              className={`item-card${selected.has(item.id) ? ' selected' : ''}`}
              onClick={(event) => {
                // Ctrl/Cmd-click selects for a batch action; a plain click opens.
                if (event.ctrlKey || event.metaKey) toggleSelection(item.id);
                else navigate(`/items/${item.id}`);
              }}
            >
              <PhotoImage path={item.primaryPhotoPath} className="item-thumb" />
              <div className="item-card-body">
                <div className="item-card-name">{item.name || 'Not yet identified'}</div>
                {item.estimatedValue !== null && (
                  <div className="item-card-value">{formatMoney(item.estimatedValue, item.currency ?? 'USD')}</div>
                )}
                {item.listFieldValues.slice(0, 2).map((value) => (
                  <div key={value.fieldDefId} className="text-muted" style={{ fontSize: 12 }}>
                    {formatFieldValue(value.value)}
                  </div>
                ))}
                {item.searchMatch && (
                  // A match against text that isn't otherwise shown on the
                  // card -- buried in the description, say -- looks like the
                  // filter did nothing without this. Name matches need no
                  // explanation, so the backend never sends one for those.
                  <div className="text-muted" style={{ fontSize: 11.5, fontStyle: 'italic' }}>
                    {item.searchMatch.label}: "{item.searchMatch.snippet}"
                  </div>
                )}
                <div className="item-card-meta">
                  {item.aiStatus === 'queued' && <span className="pill">queued</span>}
                  {item.aiStatus === 'running' && <span className="pill pill-warn">working…</span>}
                  {item.aiStatus === 'error' && <span className="pill pill-bad">failed</span>}
                  {item.aiStatus === 'done' && item.aiTier === 'quick' && (
                    <span className="pill pill-warn">quick</span>
                  )}
                  {item.conditionGrade !== 'unknown' && (
                    <span className="pill">{CONDITION_LABELS[item.conditionGrade]}</span>
                  )}
                  {item.photoCount > 1 && <span className="pill">{item.photoCount} photos</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {importing && collectionId && (
        <ImportDialog
          collectionId={collectionId}
          itemNoun={itemNoun}
          onClose={() => setImporting(false)}
          onDone={(result) => {
            setImporting(false);
            setToast(
              `Added ${result.itemsCreated} ${result.itemsCreated === 1 ? itemNoun : `${itemNoun}s`} from ${
                result.photosAdded
              } photos${result.jobsQueued > 0 ? ` — ${result.jobsQueued} queued for identification` : ''}${
                result.duplicatesSkipped > 0 ? `, ${result.duplicatesSkipped} duplicates skipped` : ''
              }.`
            );
            void refresh();
          }}
        />
      )}

      {runTask && (
        <RunDialog
          task={runTask}
          items={targetItems}
          itemNoun={itemNoun}
          onClose={() => setRunTask(null)}
          onConfirmed={(queued) => {
            setRunTask(null);
            setToast(`${queued} queued.`);
            void refresh();
          }}
        />
      )}

      {editingFields && collectionId && (
        <FieldEditor
          collectionId={collectionId}
          fields={fields}
          onClose={() => setEditingFields(false)}
          onChanged={() => void refresh()}
        />
      )}
    </>
  );
}
