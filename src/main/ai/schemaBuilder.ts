import { FieldDef } from '../../shared/types/fieldDef';
import { CONDITION_GRADES } from '../../shared/types/item';
import { JsonSchema } from './types';

/**
 * Compiles a collection's field definitions into a JSON Schema.
 *
 * This is the hinge the whole collection-agnostic design turns on. No prompt
 * and no code mentions "scale" or "model brand" -- those are rows in
 * `field_defs`, and this function turns whatever rows exist into the shape the
 * model must return. Add a field in the UI and the very next AI call extracts
 * it; switch to collecting pocket watches and the same pipeline asks about
 * movement and case material instead, with nothing recompiled.
 *
 * Two constraints from Anthropic's structured-output subset shape everything
 * below, and both cause a hard "Invalid schema" 400 if ignored:
 *
 *   1. Nullable fields must be `anyOf: [<schema>, {type: "null"}]`, not
 *      `type: ["string", "null"]`. JSON Schema allows the array form, but this
 *      subset doesn't -- see `nullable()`.
 *   2. Every property on an `additionalProperties: false` object must be
 *      listed in `required`, including the nullable ones. Optionality is
 *      expressed through the null branch, not through omission from
 *      `required` -- see `objectSchema()`.
 */

/** Wraps a schema so the model may return null instead, the supported way. */
function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: 'null' }] };
}

/**
 * An object schema with every property required and `additionalProperties`
 * pinned to false, which is the only value this subset accepts for it.
 * Centralising this means "list every key in required" can't be forgotten on
 * a future field the way it already was once.
 */
function objectSchema(properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
    ...(description ? { description } : {}),
  };
}

function fieldSchema(def: FieldDef): JsonSchema {
  const description = [def.label, def.aiHint].filter(Boolean).join(' — ');

  switch (def.dataType) {
    case 'number':
    case 'currency':
      return { ...nullable({ type: 'number' }), description };

    case 'integer':
      return { ...nullable({ type: 'integer' }), description };

    case 'year':
      return { ...nullable({ type: 'integer' }), description: `${description} (four-digit year)` };

    case 'boolean':
      return { ...nullable({ type: 'boolean' }), description };

    case 'date':
      return { ...nullable({ type: 'string' }), description: `${description} (ISO date, YYYY-MM-DD)` };

    case 'enum':
      // null lives in the wrapping anyOf, not inside this enum list, so "I
      // can't tell" is still a legal answer without null appearing twice.
      return { ...nullable({ type: 'string', enum: def.options }), description };

    case 'multi_enum':
      return {
        ...nullable({ type: 'array', items: { type: 'string', enum: def.options } }),
        description,
      };

    case 'url':
      return { ...nullable({ type: 'string' }), description: `${description} (URL)` };

    case 'longtext':
    case 'text':
    default:
      return { ...nullable({ type: 'string' }), description };
  }
}

/** Schema for the identify task, given the collection's extractable fields. */
export function buildIdentifySchema(defs: FieldDef[]): JsonSchema {
  const extractable = defs.filter((def) => def.aiExtractable);

  const fieldProperties: Record<string, JsonSchema> = {};
  for (const def of extractable) {
    fieldProperties[def.key] = fieldSchema(def);
  }

  return objectSchema({
    // Deliberately the first property: structured-output generation fills
    // properties in the order they're declared, so putting the evidence
    // dump before `name` makes the model transcribe what it actually read
    // before it commits to an identification -- rather than naming the item
    // first and rationalizing evidence for that guess afterward.
    visual_evidence: {
      type: 'string',
      description:
        'Every distinct piece of text, decal, badge, stamping, or box printing you can actually read, each with exactly where it is. ' +
        'One object often carries markings from more than one source -- e.g. a decal on the body naming the equipment, plus a separate stamped or molded number on an attached accessory (cab, loader, duals, weight kit) that belongs to that accessory, not to the vehicle. List each marking with its location so it is clear which part it was found on, and do not merge them into one number. ' +
        'If something is too worn, small, or angled to read with confidence, say that plainly instead of writing your best guess here.',
    },
    name: {
      type: 'string',
      description:
        'Short specific title for this item, the way a collector would list it -- maker and model, e.g. "Ertl John Deere 4020". ' +
        'Base this only on markings visual_evidence places on the vehicle itself, not on markings found on an attached accessory. ' +
        'Do not append scale, size, condition, packaging state, or anything else that has its own dedicated field below; keep the name itself clean and put that detail only in its field.',
    },
    description: {
      type: 'string',
      description:
        'Two to four sentences describing what the item is, its notable features, and anything visible that affects desirability.',
    },
    condition_grade: {
      type: 'string',
      enum: [...CONDITION_GRADES],
      description: 'Overall condition judged from the photos alone.',
    },
    condition_notes: nullable({
      type: 'string',
      description:
        'Specific visible flaws and their locations — chips, paint loss, bent or missing parts, decal wear, box damage. Null if none are visible.',
    }),
    identification_confidence: {
      type: 'number',
      description: 'How confident you are in the identification, from 0 to 1.',
    },
    uncertain_notes: nullable({
      type: 'string',
      description:
        'What you could not determine and what additional photo would resolve it (e.g. "underside markings not visible"). Null if nothing is uncertain.',
    }),
    fields: objectSchema(
      fieldProperties,
      "Values for this collection's custom fields. Use null for any you cannot determine."
    ),
  });
}

export function buildAppraiseSchema(currency: string): JsonSchema {
  return objectSchema({
    value_low: { ...nullable({ type: 'number' }), description: `Low end of the realistic resale range, in ${currency}.` },
    value_mid: { ...nullable({ type: 'number' }), description: `Most likely resale value, in ${currency}.` },
    value_high: { ...nullable({ type: 'number' }), description: `High end of the realistic resale range, in ${currency}.` },
    currency: {
      type: 'string',
      description: `Currency code for the values above. Use ${currency} unless the evidence is in another currency.`,
    },
    condition_assessed: nullable({
      type: 'string',
      description: 'Condition you judged from the photos, in the collecting vocabulary for this category.',
    }),
    confidence: { type: 'number', description: 'Confidence in this valuation, from 0 to 1.' },
    rationale: {
      type: 'string',
      description:
        'How you arrived at the range: what comparables you weighted, how condition and packaging moved the number, and what you were unsure about.',
    },
    comps: {
      type: 'array',
      description:
        'The listings you actually used. Only include ones you genuinely found — an empty array is a valid and expected answer when you could not find any.',
      items: objectSchema({
        source: { type: 'string', description: 'Site the listing is on, e.g. ebay, worthpoint, hobbydb.' },
        title: { type: 'string', description: 'Listing title as it appears on the source.' },
        url: {
          type: 'string',
          description: 'Direct link to the listing. Must be a URL you actually retrieved, never constructed.',
        },
        price: nullable({ type: 'number' }),
        currency: nullable({ type: 'string' }),
        sold_date: nullable({ type: 'string', description: 'ISO date of the sale or listing, if known.' }),
        condition: nullable({ type: 'string' }),
        listing_type: {
          type: 'string',
          enum: ['sold', 'active', 'unknown'],
          description:
            'Whether this is a completed sale or a current asking price. These are different evidence — do not label an asking price as sold.',
        },
        similarity_note: nullable({
          type: 'string',
          description: 'How this comparable differs from the item, e.g. "same casting, box missing".',
        }),
      }),
    },
  });
}

export function buildSuggestFieldsSchema(): JsonSchema {
  return objectSchema({
    fields: {
      type: 'array',
      description: 'Between 5 and 12 custom fields worth tracking for this kind of collection.',
      items: objectSchema({
        key: { type: 'string', description: 'lower_snake_case machine name.' },
        label: { type: 'string', description: 'Human-readable field name.' },
        data_type: {
          type: 'string',
          enum: ['text', 'longtext', 'number', 'integer', 'boolean', 'date', 'year', 'enum', 'multi_enum', 'url', 'currency'],
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Allowed values, for enum and multi_enum only. Empty array otherwise.',
        },
        ai_hint: nullable({
          type: 'string',
          description: 'Guidance for reading this field off a photo, e.g. where the marking is usually found.',
        }),
        rationale: { type: 'string', description: 'One sentence on why this field matters for value or organisation.' },
      }),
    },
  });
}

export function buildGroupPhotosSchema(): JsonSchema {
  return objectSchema({
    groups: {
      type: 'array',
      description:
        'One entry per distinct physical object. Every supplied photo number must appear in exactly one group.',
      items: objectSchema({
        photos: {
          type: 'array',
          items: { type: 'integer' },
          description: 'The photo numbers showing this one object.',
        },
        label: { type: 'string', description: 'A few words naming what the object appears to be.' },
        confidence: { type: 'number', description: 'Confidence that these photos really are one object, 0 to 1.' },
      }),
    },
  });
}
