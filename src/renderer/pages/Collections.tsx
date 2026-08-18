import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CollectionSummary } from '@shared/types/collection';
import { FieldDataType } from '@shared/types/fieldDef';
import { COLLECTION_TEMPLATES, CollectionTemplate } from '@shared/fieldTemplates';
import { emptyFieldFormValue, FieldFormFields, FieldFormValue, parseOptions } from '../components/FieldForm';
import { formatMoney } from '../utils/format';

export default function Collections() {
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const refresh = async () => {
    setCollections(await window.valutique.collections.getSummaries());
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (loading) return <p className="text-muted">Loading…</p>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Collections</h1>
          <p className="subtitle">Each collection has its own custom fields. Adding a photo starts the AI on its own.</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            New collection
          </button>
        </div>
      </div>

      {collections.length === 0 ? (
        <div className="card empty-state">
          <h2>Nothing here yet</h2>
          <p>
            Start with a collection — farm toys, action figures, or anything else. Pick a starting set of fields or let
            the AI suggest them, then drop your photos in and walk away.
          </p>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            Create your first collection
          </button>
        </div>
      ) : (
        <div className="item-grid">
          {collections.map((collection) => (
            <button
              key={collection.id}
              className="item-card"
              onClick={() => navigate(`/collections/${collection.id}`)}
            >
              <div className="item-card-body">
                <div className="item-card-name">{collection.name}</div>
                <div className="item-card-value">{formatMoney(collection.estimatedValue)}</div>
                <div className="text-muted" style={{ fontSize: 12.5 }}>
                  {collection.itemCount} {collection.itemCount === 1 ? collection.itemNoun : `${collection.itemNoun}s`}
                  {collection.photoCount > 0 && ` · ${collection.photoCount} photos`}
                </div>
                {collection.unappraisedCount > 0 && (
                  <div className="item-card-meta">
                    {/* The total is only as complete as the appraisals behind
                        it, so never show it without this caveat. */}
                    <span className="pill pill-warn">{collection.unappraisedCount} not yet valued</span>
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {creating && (
        <NewCollectionModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            navigate(`/collections/${id}`);
          }}
        />
      )}
    </>
  );
}

/**
 * A field on its way into a not-yet-created collection.
 *
 * Every field the user ends up with -- from a template, from the AI, or typed
 * in by hand -- becomes one of these, in one shared list. That's what lets
 * them all be reviewed, edited, and individually accepted or rejected the same
 * way, rather than the old "accept the whole template, or accept the whole AI
 * list" choice with no way to touch either before creating.
 */
interface DraftField {
  id: string;
  label: string;
  dataType: FieldDataType;
  options: string[];
  aiHint: string | null;
  showInList: boolean;
  accepted: boolean;
  /** Only set for AI-suggested fields, shown so the user knows why it was proposed. */
  rationale?: string;
}

function templateToDraft(template: CollectionTemplate): DraftField[] {
  return template.fields.map((field, index) => ({
    id: `template-${index}`,
    label: field.label,
    dataType: field.dataType,
    options: field.options ?? [],
    aiHint: field.aiHint ?? null,
    showInList: field.showInList ?? index < 4,
    accepted: true,
  }));
}

function NewCollectionModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [template, setTemplate] = useState<CollectionTemplate>(COLLECTION_TEMPLATES[0]);
  const [name, setName] = useState(COLLECTION_TEMPLATES[0].name);
  const [itemNoun, setItemNoun] = useState(COLLECTION_TEMPLATES[0].itemNoun);
  const [description, setDescription] = useState(COLLECTION_TEMPLATES[0].description);
  const [draftFields, setDraftFields] = useState<DraftField[]>(templateToDraft(COLLECTION_TEMPLATES[0]));

  const [addingField, setAddingField] = useState(false);
  const [addValue, setAddValue] = useState<FieldFormValue>(emptyFieldFormValue());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<FieldFormValue>(emptyFieldFormValue());

  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const nextId = useRef(0);
  const newFieldId = () => `manual-${nextId.current++}`;

  const chooseTemplate = (next: CollectionTemplate) => {
    setTemplate(next);
    setName(next.name);
    setItemNoun(next.itemNoun);
    setDescription(next.description);
    setDraftFields(templateToDraft(next));
  };

  const suggest = async () => {
    setSuggesting(true);
    setError(null);
    try {
      const fields = await window.valutique.fields.suggest(name, description);
      // AI suggestions replace the current list rather than merging with it --
      // asking again is "start over with a fresh proposal", not "add more".
      setDraftFields(
        fields.map((field, index) => ({
          id: `ai-${index}`,
          label: field.label,
          dataType: field.dataType,
          options: field.options,
          aiHint: field.aiHint,
          showInList: index < 4,
          accepted: true,
          rationale: field.rationale,
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSuggesting(false);
    }
  };

  const addManualField = () => {
    if (!addValue.label) return;
    setDraftFields((current) => [
      ...current,
      {
        id: newFieldId(),
        label: addValue.label,
        dataType: addValue.dataType,
        options: parseOptions(addValue.optionsText),
        aiHint: addValue.aiHint || null,
        showInList: false,
        accepted: true,
      },
    ]);
    setAddValue(emptyFieldFormValue());
    setAddingField(false);
  };

  const startEdit = (field: DraftField) => {
    setEditingId(field.id);
    setEditValue({ label: field.label, dataType: field.dataType, optionsText: field.options.join(', '), aiHint: field.aiHint ?? '' });
  };

  const saveEdit = () => {
    setDraftFields((current) =>
      current.map((field) =>
        field.id === editingId
          ? { ...field, label: editValue.label, dataType: editValue.dataType, options: parseOptions(editValue.optionsText), aiHint: editValue.aiHint || null }
          : field
      )
    );
    setEditingId(null);
  };

  const toggleAccepted = (id: string) => {
    setDraftFields((current) => current.map((field) => (field.id === id ? { ...field, accepted: !field.accepted } : field)));
  };

  const removeField = (id: string) => {
    setDraftFields((current) => current.filter((field) => field.id !== id));
  };

  const acceptedCount = draftFields.filter((f) => f.accepted).length;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const collection = await window.valutique.collections.create({ name, itemNoun, description });

      const fields = draftFields
        .filter((field) => field.accepted)
        .map((field, index) => ({
          collectionId: collection.id,
          key: field.label,
          label: field.label,
          dataType: field.dataType,
          options: field.options,
          aiHint: field.aiHint,
          showInList: field.showInList,
          sortOrder: index,
        }));

      if (fields.length > 0) {
        await window.valutique.fields.createMany(fields);
      }

      onCreated(collection.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <h2>New collection</h2>

        <div className="provider-choice">
          {COLLECTION_TEMPLATES.map((option) => (
            <button
              key={option.id}
              className={`provider-option${template.id === option.id ? ' selected' : ''}`}
              onClick={() => chooseTemplate(option)}
            >
              <div>
                <div className="provider-option-label">{option.name}</div>
                <div className="provider-option-blurb">{option.blurb}</div>
              </div>
            </button>
          ))}
        </div>

        <div className="grid-2">
          <div className="field">
            <label>Collection name</label>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label>One entry is called a…</label>
            <input value={itemNoun} onChange={(event) => setItemNoun(event.target.value)} placeholder="toy" />
            <span className="field-hint">Used in the interface and in the AI prompts.</span>
          </div>
        </div>

        <div className="field">
          <label>What do you collect?</label>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Die-cast farm toys — tractors, implements and machinery across brands and scales."
          />
          <span className="field-hint">
            The AI reads this when identifying and valuing items, so a sentence of context measurably improves results.
          </span>
        </div>

        <div className="field-inline">
          <button className="btn btn-small" onClick={() => void suggest()} disabled={suggesting || !name}>
            {suggesting ? 'Thinking…' : 'Suggest fields with AI'}
          </button>
          <span className="text-muted" style={{ fontSize: 12.5 }}>
            Replaces the list below with a fresh proposal. Either way, everything under it is yours to edit before
            creating.
          </span>
        </div>

        <div className="card" style={{ marginTop: 8 }}>
          <div className="card-hint" style={{ marginBottom: 12 }}>
            {acceptedCount} of {draftFields.length} fields will be created — untick anything you don't want, edit
            anything that isn't quite right, or add your own below.
          </div>

          {draftFields.map((field) =>
            editingId === field.id ? (
              <div key={field.id} className="card" style={{ marginBottom: 10 }}>
                <FieldFormFields value={editValue} onChange={setEditValue} />
                <div className="modal-actions">
                  <button className="btn btn-small" onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                  <button className="btn btn-small btn-primary" onClick={saveEdit} disabled={!editValue.label}>
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div
                key={field.id}
                className="connector-row"
                style={{ alignItems: 'flex-start', opacity: field.accepted ? 1 : 0.5 }}
              >
                <input
                  type="checkbox"
                  checked={field.accepted}
                  onChange={() => toggleAccepted(field.id)}
                  style={{ marginTop: 3 }}
                />
                <div className="connector-main">
                  <div className="connector-name">
                    {field.label}
                    <span className="pill">{field.dataType}</span>
                  </div>
                  {field.rationale && <div className="connector-meta">{field.rationale}</div>}
                  {field.options.length > 0 && <div className="connector-meta">Options: {field.options.join(', ')}</div>}
                  {field.aiHint && <div className="connector-meta">Hint: {field.aiHint}</div>}
                </div>
                <div className="connector-actions">
                  <button className="btn btn-small" onClick={() => startEdit(field)}>
                    Edit
                  </button>
                  <button className="btn btn-small btn-danger" onClick={() => removeField(field.id)}>
                    Remove
                  </button>
                </div>
              </div>
            )
          )}

          {addingField ? (
            <div className="card" style={{ marginTop: 10 }}>
              <FieldFormFields value={addValue} onChange={setAddValue} />
              <div className="modal-actions">
                <button className="btn btn-small" onClick={() => setAddingField(false)}>
                  Cancel
                </button>
                <button className="btn btn-small btn-primary" onClick={addManualField} disabled={!addValue.label}>
                  Add field
                </button>
              </div>
            </div>
          ) : (
            <button className="btn btn-small" style={{ marginTop: draftFields.length > 0 ? 10 : 0 }} onClick={() => setAddingField(true)}>
              Add a field manually
            </button>
          )}
        </div>

        {error && <div className="banner banner-bad">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !name}>
            {saving ? 'Creating…' : 'Create collection'}
          </button>
        </div>
      </div>
    </div>
  );
}
