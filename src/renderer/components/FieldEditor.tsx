import { useState } from 'react';
import { FieldDef } from '@shared/types/fieldDef';
import { DATA_TYPES, emptyFieldFormValue, fieldToFormValue, FieldFormFields, FieldFormValue, parseOptions } from './FieldForm';

/**
 * Custom field management.
 *
 * Anything changed here takes effect on the very next AI call, because the
 * field rows are compiled into the extraction schema at request time. Adding
 * "Stock Number" and re-running identify will fill it in on every item, with no
 * code change and no migration. The same is true of editing one: correct a
 * field's option list here and the next identify run can use the corrected
 * one, no delete-and-recreate required (which would have orphaned every value
 * already stored against the old field).
 */
export default function FieldEditor({
  collectionId,
  fields,
  onClose,
  onChanged,
}: {
  collectionId: string;
  fields: FieldDef[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [addValue, setAddValue] = useState<FieldFormValue>(emptyFieldFormValue());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<FieldFormValue>(emptyFieldFormValue());
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await window.valutique.fields.create({
        collectionId,
        key: addValue.label,
        label: addValue.label,
        dataType: addValue.dataType,
        options: parseOptions(addValue.optionsText),
        aiHint: addValue.aiHint || null,
      });
      setAddValue(emptyFieldFormValue());
      setAdding(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (field: FieldDef) => {
    setEditingId(field.id);
    setEditValue(fieldToFormValue(field));
  };

  const saveEdit = async (field: FieldDef) => {
    setBusy(true);
    try {
      await window.valutique.fields.update(field.id, {
        label: editValue.label,
        dataType: editValue.dataType,
        options: parseOptions(editValue.optionsText),
        aiHint: editValue.aiHint || null,
      });
      setEditingId(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (field: FieldDef, patch: Partial<FieldDef>) => {
    await window.valutique.fields.update(field.id, patch);
    onChanged();
  };

  const remove = async (field: FieldDef) => {
    await window.valutique.fields.delete(field.id);
    onChanged();
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <h2>Custom fields</h2>
        <p className="card-hint">
          These are the details the AI fills in from your photos. Changes apply to the next run — add or correct a
          field and re-identify to backfill it across the collection.
        </p>

        {fields.map((field) =>
          editingId === field.id ? (
            <div key={field.id} className="card" style={{ marginBottom: 12 }}>
              <FieldFormFields value={editValue} onChange={setEditValue} />
              <div className="modal-actions">
                <button className="btn" onClick={() => setEditingId(null)} disabled={busy}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => void saveEdit(field)}
                  disabled={busy || !editValue.label}
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div key={field.id} className="connector-row">
              <div className="connector-main">
                <div className="connector-name">
                  {field.label}
                  <span className="pill">{DATA_TYPES.find((type) => type.value === field.dataType)?.label ?? field.dataType}</span>
                  {!field.aiExtractable && <span className="pill">manual only</span>}
                </div>
                {field.options.length > 0 && <div className="connector-meta">{field.options.join(' · ')}</div>}
                {field.aiHint && <div className="connector-meta">Hint: {field.aiHint}</div>}
              </div>
              <div className="connector-actions">
                <button className="btn btn-small" onClick={() => startEdit(field)}>
                  Edit
                </button>
                <button
                  className="btn btn-small"
                  title="Show this on the item cards"
                  onClick={() => void toggle(field, { showInList: !field.showInList })}
                >
                  {field.showInList ? 'On cards' : 'Hidden'}
                </button>
                <button
                  className="btn btn-small"
                  title="Whether the AI should try to read this from photos"
                  onClick={() => void toggle(field, { aiExtractable: !field.aiExtractable })}
                >
                  {field.aiExtractable ? 'AI fills' : 'Manual'}
                </button>
                <button className="btn btn-small btn-danger" onClick={() => void remove(field)}>
                  Delete
                </button>
              </div>
            </div>
          )
        )}

        {adding ? (
          <div className="card" style={{ marginTop: 16 }}>
            <FieldFormFields value={addValue} onChange={setAddValue} />
            <div className="modal-actions">
              <button className="btn" onClick={() => setAdding(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void create()} disabled={busy || !addValue.label}>
                Add field
              </button>
            </div>
          </div>
        ) : (
          <button className="btn" style={{ marginTop: 16 }} onClick={() => setAdding(true)}>
            Add a field
          </button>
        )}

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
