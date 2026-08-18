import initSqlJs, { Database } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import { getEffectiveDbPath } from '../dbLocation';

let dbInstance: Database | null = null;
let currentDbPath: string | null = null;

export async function initDatabase(dbPath?: string): Promise<Database> {
  const SQL = await initSqlJs();
  dbPath = dbPath ?? getEffectiveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let db: Database;

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  dbInstance = db;
  currentDbPath = dbPath;

  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      item_noun TEXT NOT NULL DEFAULT 'item',
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // The custom-field table is what keeps this database collection-agnostic.
  // Farm toys get Scale and Model Brand; an action figure collection gets
  // Character and Wave. Neither is known to the code -- both are rows here,
  // compiled into a JSON schema at AI call time.
  db.run(`
    CREATE TABLE IF NOT EXISTS field_defs (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      data_type TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '[]',
      required INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      ai_extractable INTEGER NOT NULL DEFAULT 1,
      ai_hint TEXT,
      show_in_list INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (collection_id, key),
      FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      description TEXT,
      notes TEXT,
      ai_notes TEXT,
      location TEXT,
      condition_grade TEXT NOT NULL DEFAULT 'unknown',
      condition_notes TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      acquired_date TEXT,
      acquired_price REAL,
      ai_status TEXT NOT NULL DEFAULT 'none',
      ai_tier TEXT,
      ai_last_run_at TEXT,
      ai_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
    )
  `);

  // Entity-attribute-value store for the custom fields. Typed columns rather
  // than one stringly-typed blob so numeric fields can be sorted and filtered
  // in SQL. multi_enum values live in value_text as a JSON array.
  db.run(`
    CREATE TABLE IF NOT EXISTS item_field_values (
      item_id TEXT NOT NULL,
      field_def_id TEXT NOT NULL,
      value_text TEXT,
      value_number REAL,
      value_bool INTEGER,
      value_date TEXT,
      from_ai INTEGER NOT NULL DEFAULT 0,
      confidence REAL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (item_id, field_def_id),
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
      FOREIGN KEY (field_def_id) REFERENCES field_defs(id) ON DELETE CASCADE
    )
  `);

  // Photo bytes live on disk in a relocatable media library, content-addressed
  // by hash; only metadata is stored here. Keeps the database small enough to
  // sit in a cloud-synced folder.
  db.run(`
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      byte_size INTEGER NOT NULL DEFAULT 0,
      is_primary INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    )
  `);

  // Appraisals are append-only. Re-running valuation adds a row and moves the
  // is_current flag, so the evidence behind an earlier number is never lost.
  db.run(`
    CREATE TABLE IF NOT EXISTS appraisals (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'deep',
      connector_id TEXT,
      connector_label TEXT NOT NULL DEFAULT '',
      model TEXT,
      value_low REAL,
      value_mid REAL,
      value_high REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      condition_assessed TEXT,
      confidence REAL,
      rationale TEXT,
      is_current INTEGER NOT NULL DEFAULT 1,
      search_unavailable INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS appraisal_comps (
      id TEXT PRIMARY KEY,
      appraisal_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      price REAL,
      currency TEXT,
      sold_date TEXT,
      condition TEXT,
      listing_type TEXT NOT NULL DEFAULT 'unknown',
      similarity_note TEXT,
      url_verified INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (appraisal_id) REFERENCES appraisals(id) ON DELETE CASCADE
    )
  `);

  // API keys are deliberately NOT in this table -- they live in the OS keychain
  // via safeStorage. This database is designed to be relocated into a
  // cloud-synced folder, and credentials must not ride along with it.
  db.run(`
    CREATE TABLE IF NOT EXISTS ai_connectors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'http',
      base_url TEXT,
      model TEXT,
      cli_command TEXT,
      cli_args_json TEXT NOT NULL DEFAULT '[]',
      billing_mode TEXT NOT NULL DEFAULT 'api_credits',
      supports_vision INTEGER NOT NULL DEFAULT 1,
      supports_web_search INTEGER NOT NULL DEFAULT 0,
      supports_structured_output INTEGER NOT NULL DEFAULT 0,
      max_tokens INTEGER NOT NULL DEFAULT 8000,
      effort TEXT,
      price_input_per_mtok REAL,
      price_output_per_mtok REAL,
      price_search_per_k REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      extra_params_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Migration: extra CLI arguments arrived after the first release.
  try {
    db.run(`ALTER TABLE ai_connectors ADD COLUMN cli_args_json TEXT NOT NULL DEFAULT '[]'`);
  } catch (e) {
    // Already present on databases created after this change.
  }

  // Migration: captured CLI console output, so a job that ran silently for
  // minutes -- the incident that prompted this column -- has a timestamped
  // record of what it was actually doing, not just its final result.
  try {
    db.run(`ALTER TABLE ai_jobs ADD COLUMN cli_log TEXT`);
  } catch (e) {
    // Already present on databases created after this change.
  }

  // Migration: Google retired gemini-2.5-flash and gemini-2.0-flash for new
  // API keys well before their published shutdown dates (confirmed via a
  // live 404, "no longer available to new users") -- any connector still
  // pointed at one of these old defaults is broken and cannot self-heal by
  // waiting, so bump it to the current default flash model rather than leave
  // every future job failing with the same dead-model error.
  db.run(
    `UPDATE ai_connectors SET model = 'gemini-3.7-flash', updated_at = ?
     WHERE provider = 'gemini' AND model IN ('gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-001', 'gemini-2.0-flash-lite-001', 'gemini-2.5-flash-lite')`,
    [new Date().toISOString()]
  );

  // Migration: AI notes used to be appended into the owner's own notes field,
  // which broke the promise that field made never to be AI-touched. Give the
  // AI its own column instead of retrofitting the mixed text already sitting
  // in `notes` on existing rows -- there's no reliable way to tell which part
  // of an existing note was the owner's and which was appended by a past run.
  try {
    db.run(`ALTER TABLE items ADD COLUMN ai_notes TEXT`);
  } catch (e) {
    // Already present on databases created after this change.
  }

  // Migration: quick/deep tiers. Existing rows default to 'deep' -- today's
  // full search-and-verify behavior -- so nothing changes for anyone until
  // they explicitly configure a 'quick' binding in Settings.
  try {
    db.run(`ALTER TABLE ai_jobs ADD COLUMN tier TEXT NOT NULL DEFAULT 'deep'`);
  } catch (e) {
    // Already present on databases created after this change.
  }
  try {
    db.run(`ALTER TABLE items ADD COLUMN ai_tier TEXT`);
  } catch (e) {
    // Already present on databases created after this change.
  }
  try {
    db.run(`ALTER TABLE appraisals ADD COLUMN tier TEXT NOT NULL DEFAULT 'deep'`);
  } catch (e) {
    // Already present on databases created after this change.
  }

  // One row per (task, tier): quick and deep are configured independently,
  // e.g. a fast/no-search model bound to appraise/quick and a
  // search-capable one bound to appraise/deep.
  db.run(`
    CREATE TABLE IF NOT EXISTS ai_task_bindings (
      task TEXT NOT NULL,
      tier TEXT NOT NULL,
      connector_id TEXT,
      prompt_override TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task, tier),
      FOREIGN KEY (connector_id) REFERENCES ai_connectors(id) ON DELETE SET NULL
    )
  `);

  // Migration: task bindings used to have one row per task, keyed on task
  // alone. Tiering needs (task, tier) as the key, which sql.js can't get to
  // via ALTER -- rebuild the table. Existing bindings become the 'deep' row
  // (today's behavior, unchanged) plus an identical 'quick' row as a safe
  // starting point, so nothing breaks until the user points quick somewhere
  // cheaper in Settings.
  {
    const columns = db.exec(`PRAGMA table_info(ai_task_bindings)`);
    const hasTier = columns.length > 0 && columns[0].values.some((row) => row[1] === 'tier');
    if (!hasTier) {
      db.run(`ALTER TABLE ai_task_bindings RENAME TO ai_task_bindings_old`);
      db.run(`
        CREATE TABLE ai_task_bindings (
          task TEXT NOT NULL,
          tier TEXT NOT NULL,
          connector_id TEXT,
          prompt_override TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (task, tier),
          FOREIGN KEY (connector_id) REFERENCES ai_connectors(id) ON DELETE SET NULL
        )
      `);
      db.run(`
        INSERT INTO ai_task_bindings (task, tier, connector_id, prompt_override, updated_at)
        SELECT task, 'deep', connector_id, prompt_override, updated_at FROM ai_task_bindings_old
      `);
      db.run(`
        INSERT INTO ai_task_bindings (task, tier, connector_id, prompt_override, updated_at)
        SELECT task, 'quick', connector_id, prompt_override, updated_at FROM ai_task_bindings_old
      `);
      db.run(`DROP TABLE ai_task_bindings_old`);
    }
  }

  // The queue is a real table rather than an in-memory list so a 300-item
  // import survives a restart, a crash, or a rate-limit window that outlasts
  // the session.
  db.run(`
    CREATE TABLE IF NOT EXISTS ai_jobs (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'deep',
      item_id TEXT,
      collection_id TEXT,
      connector_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      not_before TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      web_searches INTEGER,
      cost_estimate REAL,
      duration_ms INTEGER,
      request_json TEXT,
      response_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      job_concurrency INTEGER NOT NULL DEFAULT 2,
      ai_image_max_edge INTEGER NOT NULL DEFAULT 1024,
      ai_max_photos_per_item INTEGER NOT NULL DEFAULT 3,
      auto_process_on_import INTEGER NOT NULL DEFAULT 1,
      auto_appraise_after_identify INTEGER NOT NULL DEFAULT 1,
      max_searches_per_appraisal INTEGER NOT NULL DEFAULT 3,
      verify_comp_urls INTEGER NOT NULL DEFAULT 1,
      default_currency TEXT NOT NULL DEFAULT 'USD',
      ebay_enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_items_collection ON items(collection_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_items_name ON items(name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_items_location ON items(location)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_items_ai_status ON items(ai_status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_field_defs_collection ON field_defs(collection_id, sort_order)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_field_values_item ON item_field_values(item_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_photos_item ON photos(item_id, sort_order)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_photos_sha ON photos(sha256)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_appraisals_item ON appraisals(item_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_appraisals_current ON appraisals(item_id, is_current)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_comps_appraisal ON appraisal_comps(appraisal_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON ai_jobs(status, not_before)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_item ON ai_jobs(item_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_connector ON ai_jobs(connector_id, status)`);

  seedSettings(db);
  recoverInterruptedJobs(db);

  saveDatabase(db, dbPath);

  console.log('Database initialized at:', dbPath);

  return db;
}

function seedSettings(db: Database): void {
  const result = db.exec(`SELECT COUNT(*) FROM app_settings WHERE id = 1`);
  const count = result.length > 0 ? Number(result[0].values[0][0]) : 0;
  if (count === 0) {
    db.run(`INSERT INTO app_settings (id, updated_at) VALUES (1, ?)`, [new Date().toISOString()]);
  }
}

/**
 * Jobs left mid-flight by a crash or a quit are put back on the queue rather
 * than stranded in `running` forever. Runs on every startup, before the queue
 * worker starts.
 */
function recoverInterruptedJobs(db: Database): void {
  db.run(`UPDATE ai_jobs SET status = 'queued', not_before = NULL WHERE status = 'running'`);
  db.run(`UPDATE items SET ai_status = 'queued' WHERE ai_status = 'running'`);
}

export function saveDatabase(db: Database, dbPath?: string): void {
  if (!dbPath) {
    dbPath = currentDbPath ?? getEffectiveDbPath();
  }
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

export function getDatabase(): Database | null {
  return dbInstance;
}
