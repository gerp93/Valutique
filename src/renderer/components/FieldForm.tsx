import { FieldDataType, FieldDef } from '@shared/types/fieldDef';

/**
 * The one field-editing form, shared by every place a custom field gets
 * defined or changed: adding a field after the collection exists, editing one
 * in place, and building the field list at collection-creation time. One
 * component means a change to how fields are edited only has to happen once.
 */

export const DATA_TYPES: { value: FieldDataType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'longtext', label: 'Long text' },
  { value: 'enum', label: 'Pick one' },
  { value: 'multi_enum', label: 'Pick several' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Whole number' },
  { value: 'currency', label: 'Money' },
  { value: 'year', label: 'Year' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Yes / no' },
  { value: 'url', label: 'Link' },
];

export interface FieldFormValue {
  label: string;
  dataType: FieldDataType;
  /** Raw comma-separated text as typed. Parsed with parseOptions() on save, not on every keystroke. */
  optionsText: string;
  aiHint: string;
}

export function emptyFieldFormValue(): FieldFormValue {
  return { label: '', dataType: 'text', optionsText: '', aiHint: '' };
}

export function fieldToFormValue(field: FieldDef): FieldFormValue {
  return { label: field.label, dataType: field.dataType, optionsText: field.options.join(', '), aiHint: field.aiHint ?? '' };
}

export function parseOptions(text: string): string[] {
  return text
    .split(',')
    .map((option) => option.trim())
    .filter(Boolean);
}

export function FieldFormFields({
  value,
  onChange,
}: {
  value: FieldFormValue;
  onChange: (next: FieldFormValue) => void;
}) {
  return (
    <>
      <div className="grid-2">
        <div className="field">
          <label>Field name</label>
          <input
            value={value.label}
            onChange={(event) => onChange({ ...value, label: event.target.value })}
            placeholder="Stock Number"
          />
        </div>
        <div className="field">
          <label>Type</label>
          <select
            value={value.dataType}
            onChange={(event) => onChange({ ...value, dataType: event.target.value as FieldDataType })}
          >
            {DATA_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {(value.dataType === 'enum' || value.dataType === 'multi_enum') && (
        <div className="field">
          <label>Choices</label>
          <input
            value={value.optionsText}
            onChange={(event) => onChange({ ...value, optionsText: event.target.value })}
            placeholder="1/16, 1/32, 1/64"
          />
          <span className="field-hint">
            Comma separated. Every future item is forced to match one of these exactly — list every value you might
            actually see, or the AI will have to guess the closest wrong one rather than the true answer.
          </span>
        </div>
      )}

      <div className="field">
        <label>Hint for the AI</label>
        <input
          value={value.aiHint}
          onChange={(event) => onChange({ ...value, aiHint: event.target.value })}
          placeholder="Usually stamped on the underside near the axle."
        />
        <span className="field-hint">
          Telling the model where to look measurably improves how often this gets filled in.
        </span>
      </div>
    </>
  );
}
