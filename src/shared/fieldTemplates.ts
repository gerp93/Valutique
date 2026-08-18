import { FieldDataType } from './types/fieldDef';

/**
 * Starter field sets offered when creating a collection, so you can get moving
 * without waiting on an AI suggestion or typing fields by hand. These are
 * ordinary starting points -- every field can be edited, reordered, or deleted,
 * and nothing in the code knows these particular fields exist.
 */
export interface TemplateField {
  key: string;
  label: string;
  dataType: FieldDataType;
  options?: string[];
  aiHint?: string;
  showInList?: boolean;
  /** Off for things only the owner knows, like what they paid. */
  aiExtractable?: boolean;
}

export interface CollectionTemplate {
  id: string;
  name: string;
  itemNoun: string;
  description: string;
  blurb: string;
  fields: TemplateField[];
}

export const COLLECTION_TEMPLATES: CollectionTemplate[] = [
  {
    id: 'farm_toys',
    name: 'Farm Toys',
    itemNoun: 'toy',
    description:
      'Die-cast and plastic farm toys — tractors, implements, trucks and machinery — across manufacturers and scales.',
    blurb: 'Scale, manufacturer, model brand, packaging, and the details that drive farm-toy value.',
    fields: [
      {
        key: 'scale',
        label: 'Scale',
        dataType: 'enum',
        options: ['1/16', '1/32', '1/64', '1/8', '1/12', '1/24', '1/43', '1/50', 'Other'],
        aiHint:
          'The size ratio, printed on the box or stamped underneath -- look there first. Only guess from proportions if no printed scale is visible, and only when something of known real-world size (a coin, a hand, a ruler) is in the same photo to judge against; a photo with nothing to compare against does not support a specific scale guess.',
        showInList: true,
      },
      {
        key: 'manufacturer',
        label: 'Manufacturer',
        dataType: 'text',
        aiHint:
          'Who made the toy — Ertl, SpecCast, Bruder, Siku, Britains, Scale Models, First Gear. Usually cast into the base or printed on the box. This is NOT the brand of the real machine.',
        showInList: true,
      },
      {
        key: 'model_brand',
        label: 'Model Brand',
        dataType: 'text',
        aiHint:
          'The real-world equipment brand the toy represents — John Deere, International Harvester, Case IH, New Holland, Massey Ferguson, Allis-Chalmers, Ford. Read it from the decals and colour scheme.',
        showInList: true,
      },
      {
        key: 'model_number',
        label: 'Model Number',
        dataType: 'text',
        aiHint: 'The equipment model designation, e.g. "4430", "806", "Magnum 7250". Usually on the hood or side decals.',
        showInList: true,
      },
      {
        key: 'equipment_type',
        label: 'Equipment Type',
        dataType: 'enum',
        options: ['Tractor', 'Combine', 'Implement', 'Truck', 'Trailer', 'Construction', 'Livestock', 'Accessory', 'Other'],
        aiHint: 'What kind of machine this is.',
        showInList: true,
      },
      {
        key: 'packaging',
        label: 'Packaging',
        dataType: 'enum',
        options: ['Mint in sealed box', 'Mint in box', 'Box only, opened', 'Loose, box included', 'Loose, no box'],
        aiHint:
          'Packaging state drives a large share of value for farm toys. Judge from the photos whether a box is present and whether it looks sealed.',
        showInList: true,
      },
      {
        key: 'stock_number',
        label: 'Stock Number',
        dataType: 'text',
        aiHint: 'Manufacturer catalogue or stock number, usually on the box end flap or the underside of the toy.',
      },
      {
        key: 'year_issued',
        label: 'Year Issued',
        dataType: 'year',
        aiHint: 'Year the toy was produced, not the year of the real machine. Copyright dates are often stamped underneath.',
      },
      {
        key: 'is_collector_edition',
        label: 'Collector / Special Edition',
        dataType: 'boolean',
        aiHint: 'True for show editions, Farm Show/Toy Show exclusives, Precision series, or numbered limited runs.',
      },
      {
        key: 'material',
        label: 'Material',
        dataType: 'enum',
        options: ['Die-cast metal', 'Plastic', 'Mixed metal and plastic', 'Other'],
        aiHint: 'Judge from surface sheen, panel lines, and visible wear.',
      },
      { key: 'purchase_source', label: 'Purchase Source', dataType: 'text', aiExtractable: false },
    ],
  },
  {
    id: 'action_figures',
    name: 'Action Figures',
    itemNoun: 'figure',
    description: 'Action figures and collectible figures across lines, waves, and manufacturers.',
    blurb: 'Character, line, wave, scale, and packaging — the same pipeline, different fields.',
    fields: [
      { key: 'character', label: 'Character', dataType: 'text', showInList: true },
      { key: 'toy_line', label: 'Toy Line', dataType: 'text', aiHint: 'The product line, e.g. "Marvel Legends", "Black Series".', showInList: true },
      { key: 'manufacturer', label: 'Manufacturer', dataType: 'text', showInList: true },
      { key: 'wave', label: 'Wave / Series', dataType: 'text' },
      { key: 'scale', label: 'Scale', dataType: 'enum', options: ['1/6', '1/12', '1/18', '3.75 inch', '6 inch', '7 inch', 'Other'], showInList: true },
      { key: 'packaging', label: 'Packaging', dataType: 'enum', options: ['Sealed on card', 'Sealed in box', 'Opened, complete', 'Loose, complete', 'Loose, incomplete'], showInList: true },
      { key: 'accessories_complete', label: 'Accessories Complete', dataType: 'boolean', aiHint: 'Whether all the accessories the figure shipped with appear to be present.' },
      { key: 'year_issued', label: 'Year Issued', dataType: 'year' },
      { key: 'is_exclusive', label: 'Exclusive', dataType: 'boolean', aiHint: 'Retailer or convention exclusive.' },
    ],
  },
  {
    id: 'generic',
    name: 'General Collection',
    itemNoun: 'item',
    description: '',
    blurb: 'A minimal starting point — three fields you can build on, or let the AI propose a set.',
    fields: [
      { key: 'maker', label: 'Maker / Brand', dataType: 'text', showInList: true },
      { key: 'year', label: 'Year', dataType: 'year', showInList: true },
      { key: 'material', label: 'Material', dataType: 'text' },
    ],
  },
];

export function templateById(id: string): CollectionTemplate | undefined {
  return COLLECTION_TEMPLATES.find((t) => t.id === id);
}
