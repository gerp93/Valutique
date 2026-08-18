import { Collection } from '../../shared/types/collection';
import { FieldDef } from '../../shared/types/fieldDef';

/**
 * Task prompts.
 *
 * Two things are load-bearing across all of them. First, nothing here names a
 * collectible category -- the domain arrives as data from the collection row
 * and its field definitions, which is what lets the same prompts serve farm
 * toys and pocket watches. Second, every prompt makes "I could not determine
 * this" an explicitly correct answer, because the failure mode that actually
 * hurts is a confident invented value that looks identical to a real one.
 */

function collectionContext(collection: Collection): string {
  const parts = [`You are cataloguing a collection called "${collection.name}".`];
  if (collection.description) {
    parts.push(`The owner describes it as: ${collection.description}`);
  }
  parts.push(`Each entry is referred to as a "${collection.itemNoun}".`);
  return parts.join(' ');
}

export function identifySystemPrompt(collection: Collection, defs: FieldDef[]): string {
  const fieldNotes = defs
    .filter((def) => def.aiExtractable && def.aiHint)
    .map((def) => `- ${def.label}: ${def.aiHint}`)
    .join('\n');

  return [
    'You are an experienced collectibles cataloguer working from photographs.',
    collectionContext(collection),
    '',
    'Identify the item as specifically as the photos support: maker, model, variant, size or scale, and any markings you can actually read. Work from what is visible — castings, decals, stampings, box printing, proportions, and wear patterns.',
    '',
    'Read every marking before you conclude anything, and note exactly where each one was found. A single object is often more than one part: an add-on cab, loader, duals, or decal kit can carry its own model or part number, separate from the base vehicle it is attached to. A number stamped into a cab is that cab kit\'s number, not the tractor\'s — the vehicle\'s own identity comes from the markings on its own body (hood, side panels, main casting), not from an accessory bolted to it. When two different numbers appear, say which part each one came from rather than picking one to report.',
    '',
    'Scale in particular is easy to get wrong from proportions alone, since a photo carries no true size reference. Only state a specific scale when you have real evidence for it — a scale printed on the box or a decal, or a part of known real-world size visible in frame to judge against. A guess based on "this looks like a typical size" is exactly the kind of confident-but-wrong answer that hurts the owner; if you lack real evidence, say so in uncertain_notes and use the field\'s "Other" option or null rather than a specific guess.',
    '',
    'Grade condition from the photographs alone, and say where the flaws are. Be specific about what you see rather than generous: a chipped edge or a faded decal matters to what this is worth, and the owner would rather hear it now.',
    '',
    'Where a photo does not support a conclusion, return null and say what you could not determine. Null is a correct answer and a plausible-looking guess is not — a fabricated model number is worse than a blank field, because the owner cannot tell the two apart afterwards.',
    '',
    'Some fields restrict you to a fixed list of options. If what you actually see does not match any option on that list, do not pick the closest wrong one — that silently records something false with no sign anything is off. Choose "Other" if the field offers it; otherwise leave that field null. Either way, say what you actually observed in uncertain_notes, so the owner can see the real value and fix the field to match.',
    fieldNotes ? `\nField-specific guidance:\n${fieldNotes}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function identifyUserPrompt(photoCount: number, existingName: string | null): string {
  const lines = [
    `${photoCount} photograph${photoCount === 1 ? '' : 's'} of a single item ${
      photoCount === 1 ? 'is' : 'are'
    } provided. They show the same physical object from different angles.`,
  ];

  if (existingName) {
    lines.push(
      `The owner has already labelled this "${existingName}". Treat that as a hint rather than fact — correct it if the photographs disagree.`
    );
  }

  lines.push('Identify it, describe it, grade its condition, and fill in the collection fields you can determine.');

  return lines.join('\n\n');
}

export function appraiseSystemPrompt(collection: Collection, canSearch: boolean): string {
  const base = [
    'You are a collectibles appraiser producing a realistic secondary-market valuation.',
    collectionContext(collection),
    '',
    'Value the item as it would actually sell today in the condition shown, not at catalogue or insurance-replacement prices. Condition and completeness usually move the number more than the model itself does — reflect that.',
    '',
    'Give a low, likely, and high figure. The spread should honestly represent your uncertainty: a narrow range on a piece you cannot firmly identify is a false signal.',
  ];

  if (canSearch) {
    base.push(
      '',
      'Search for comparable listings before you commit to a number, and prefer completed sales to current asking prices — an unsold listing only tells you what someone hoped to get. Cite the listings you actually used, with the URLs you retrieved.',
      '',
      'Only include a comparable you genuinely found and opened. Never construct, guess at, or pattern-match a URL, and never present a current listing as a completed sale. Returning an empty comps array and a wider range is the correct answer when the searches turn up nothing useful — it is far more useful to the owner than a confident number backed by links that go nowhere.'
    );
  } else {
    base.push(
      '',
      'You have no web access for this valuation, so work from your own knowledge of this market and say so in your rationale. Return an empty comps array — do not produce URLs you cannot retrieve. Widen the range to reflect that you could not check current prices.'
    );
  }

  return base.join('\n');
}

export function appraiseUserPrompt(params: {
  itemName: string;
  description: string | null;
  conditionGrade: string;
  conditionNotes: string | null;
  fieldSummary: string;
  photoCount: number;
  currency: string;
  ebayContext: string | null;
}): string {
  const lines: string[] = [];

  lines.push(`Item: ${params.itemName || '(not yet identified — work from the photographs)'}`);
  if (params.description) lines.push(`Description: ${params.description}`);
  lines.push(`Owner's condition grade: ${params.conditionGrade}`);
  if (params.conditionNotes) lines.push(`Condition notes: ${params.conditionNotes}`);
  if (params.fieldSummary) lines.push(`Known details:\n${params.fieldSummary}`);

  if (params.photoCount > 0) {
    lines.push(
      `\n${params.photoCount} photograph${params.photoCount === 1 ? '' : 's'} of the item ${
        params.photoCount === 1 ? 'is' : 'are'
      } attached. Judge condition from them yourself rather than relying on the grade above.`
    );
  }

  if (params.ebayContext) {
    lines.push(
      `\nCurrent eBay listings matching this item are below. These are asking prices, not sales, so treat them as an upper bound on what the item actually fetches:\n${params.ebayContext}`
    );
  }

  lines.push(`\nProduce a valuation in ${params.currency}.`);

  return lines.join('\n');
}

export function suggestFieldsSystemPrompt(): string {
  return [
    'You help set up a collection database by proposing the custom fields worth tracking for a given kind of collectible.',
    '',
    'Propose fields a serious collector of this category would actually record — the attributes that distinguish one piece from another, drive value, or make a collection searchable. Favour fields that can be determined from good photographs, since they will be filled in automatically from images.',
    '',
    'Use an enum only when the real-world values genuinely form a short, stable list. An enum list is not just a description of the field — every future item will be forced to match one of these exact options, so an option missing from the list produces a wrong answer with no way to signal the truth was something else, not just a blank field. If a category has more than a handful of common real values, or you are not confident you know the complete set (this is common for things like scale, size, or model — verify a few real examples in your head before committing to a short list), use plain text instead so nothing gets forced into the wrong bucket. When you do use an enum, list every value a collector would actually encounter, not just the handful that came to mind first, and always include "Other" as a catch-all.',
    '',
    'Use plain text for anything open-ended. Do not propose fields for things already stored for every item: name, description, condition, quantity, location, notes, purchase date, or purchase price.',
    '',
    'Between five and twelve fields. A focused set that gets filled in reliably is worth more than an exhaustive one that stays mostly blank.',
  ].join('\n');
}

export function suggestFieldsUserPrompt(name: string, description: string): string {
  return [
    `Collection name: ${name}`,
    description ? `What the owner collects: ${description}` : '',
    '',
    'Propose the custom fields for this collection.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function groupPhotosSystemPrompt(itemNoun: string): string {
  return [
    `You are sorting a batch of photographs into groups, where each group is one physical ${itemNoun}.`,
    '',
    `The owner photographed a number of ${itemNoun}s in one session, taking several angles of some and a single shot of others. Your job is to work out which photographs show the same physical object.`,
    '',
    'Judge by the object itself — the same casting, the same paint wear, the same flaws in the same places — not by the background or how similar two objects look. Two identical pieces sitting side by side are still two objects. The same piece shot from the front and from underneath is one.',
    '',
    'Every photo number must appear in exactly one group. When you genuinely cannot tell whether two photos are the same object, put them in separate groups and give a low confidence: splitting one object in two is a single click to fix afterwards, whereas merging two different objects quietly loses one of them.',
  ].join('\n');
}

export function groupPhotosUserPrompt(count: number, timeHint: string | null): string {
  const lines = [
    `${count} photographs are attached, numbered 1 to ${count} in the order shown.`,
  ];

  if (timeHint) {
    lines.push(
      `\nCapture times suggest the following provisional grouping. It is a hint from timestamps only, so correct it wherever the images disagree:\n${timeHint}`
    );
  }

  lines.push('\nGroup them by physical object.');

  return lines.join('\n');
}
