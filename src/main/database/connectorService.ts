import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import {
  AiConnector,
  AiTask,
  AiTaskBinding,
  AI_TASKS,
  CreateConnectorInput,
  UpdateConnectorInput,
} from '../../shared/types/connector';
import { templateFor } from '../../shared/providerTemplates';
import { all, one, reqStr, str, num, reqNum, bool, flag, json, now, buildUpdate, Row } from './helpers';
import { saveDatabase } from './schema';
import { connectorKeyRef, deleteSecret, getSecret, hasSecret, setSecret } from '../secrets';

function toConnector(row: Row): AiConnector {
  const id = reqStr(row.id);
  return {
    id,
    name: reqStr(row.name),
    provider: reqStr(row.provider) as AiConnector['provider'],
    transport: reqStr(row.transport, 'http') as AiConnector['transport'],
    baseUrl: str(row.base_url),
    model: str(row.model),
    cliCommand: str(row.cli_command),
    cliArgs: json<string[]>(row.cli_args_json, []),
    hasApiKey: hasSecret(connectorKeyRef(id)),
    billingMode: reqStr(row.billing_mode, 'api_credits') as AiConnector['billingMode'],
    supportsVision: bool(row.supports_vision),
    supportsWebSearch: bool(row.supports_web_search),
    supportsStructuredOutput: bool(row.supports_structured_output),
    maxTokens: reqNum(row.max_tokens, 8000),
    effort: (str(row.effort) as AiConnector['effort']) ?? null,
    pricing: {
      inputPerMTok: num(row.price_input_per_mtok),
      outputPerMTok: num(row.price_output_per_mtok),
      webSearchPerThousand: num(row.price_search_per_k),
      currency: reqStr(row.currency, 'USD'),
    },
    extraParams: json<Record<string, unknown>>(row.extra_params_json, {}),
    enabled: bool(row.enabled),
    createdAt: reqStr(row.created_at),
    updatedAt: reqStr(row.updated_at),
  };
}

const SELECT = `
  id, name, provider, transport, base_url, model, cli_command, cli_args_json, billing_mode,
  supports_vision, supports_web_search, supports_structured_output, max_tokens, effort,
  price_input_per_mtok, price_output_per_mtok, price_search_per_k, currency,
  extra_params_json, enabled, created_at, updated_at
  FROM ai_connectors
`;

export class ConnectorService {
  constructor(private db: Database) {}

  getAll(): AiConnector[] {
    return all(this.db, `SELECT ${SELECT} ORDER BY name COLLATE NOCASE`).map(toConnector);
  }

  getEnabled(): AiConnector[] {
    return this.getAll().filter((c) => c.enabled);
  }

  getById(id: string): AiConnector | null {
    const row = one(this.db, `SELECT ${SELECT} WHERE id = ?`, [id]);
    return row ? toConnector(row) : null;
  }

  /**
   * The API key never leaves the main process. Only the job runner calls this,
   * immediately before building a request; nothing exposes it over IPC.
   */
  getApiKey(id: string): string | null {
    return getSecret(connectorKeyRef(id));
  }

  create(input: CreateConnectorInput): AiConnector {
    const id = uuidv4();
    const timestamp = now();
    const template = templateFor(input.provider);

    // Fall back to the provider template for anything the caller left out, so
    // the common case is "pick a provider, give it a name, done".
    const transport = template?.transport ?? 'http';
    const pricing = { ...(template?.defaultPricing ?? { inputPerMTok: null, outputPerMTok: null, webSearchPerThousand: null, currency: 'USD' }), ...input.pricing };

    this.db.run(
      `INSERT INTO ai_connectors
         (id, name, provider, transport, base_url, model, cli_command, cli_args_json, billing_mode,
          supports_vision, supports_web_search, supports_structured_output, max_tokens, effort,
          price_input_per_mtok, price_output_per_mtok, price_search_per_k, currency,
          extra_params_json, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.provider,
        transport,
        input.baseUrl ?? template?.defaultBaseUrl ?? null,
        input.model ?? template?.defaultModel ?? null,
        input.cliCommand ?? template?.defaultCliCommand ?? null,
        JSON.stringify(input.cliArgs ?? []),
        input.billingMode ?? template?.billingMode ?? 'api_credits',
        flag(input.supportsVision ?? template?.supportsVision ?? true),
        flag(input.supportsWebSearch ?? template?.supportsWebSearch ?? false),
        flag(input.supportsStructuredOutput ?? template?.supportsStructuredOutput ?? false),
        input.maxTokens ?? 8000,
        input.effort ?? null,
        pricing.inputPerMTok,
        pricing.outputPerMTok,
        pricing.webSearchPerThousand,
        pricing.currency ?? 'USD',
        JSON.stringify(input.extraParams ?? {}),
        flag(input.enabled ?? true),
        timestamp,
        timestamp,
      ]
    );

    if (input.apiKey) {
      setSecret(connectorKeyRef(id), input.apiKey);
    }

    saveDatabase(this.db);
    return this.getById(id)!;
  }

  update(id: string, input: UpdateConnectorInput): AiConnector {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Connector ${id} not found`);

    const update = buildUpdate({
      name: input.name,
      base_url: input.baseUrl === undefined ? undefined : input.baseUrl,
      model: input.model === undefined ? undefined : input.model,
      cli_command: input.cliCommand === undefined ? undefined : input.cliCommand,
      cli_args_json: input.cliArgs === undefined ? undefined : JSON.stringify(input.cliArgs),
      billing_mode: input.billingMode,
      supports_vision: input.supportsVision === undefined ? undefined : flag(input.supportsVision),
      supports_web_search: input.supportsWebSearch === undefined ? undefined : flag(input.supportsWebSearch),
      supports_structured_output:
        input.supportsStructuredOutput === undefined ? undefined : flag(input.supportsStructuredOutput),
      max_tokens: input.maxTokens,
      effort: input.effort === undefined ? undefined : input.effort,
      price_input_per_mtok: input.pricing?.inputPerMTok,
      price_output_per_mtok: input.pricing?.outputPerMTok,
      price_search_per_k: input.pricing?.webSearchPerThousand,
      currency: input.pricing?.currency,
      extra_params_json: input.extraParams === undefined ? undefined : JSON.stringify(input.extraParams),
      enabled: input.enabled === undefined ? undefined : flag(input.enabled),
    });

    if (update) {
      this.db.run(`UPDATE ai_connectors SET ${update.clause}, updated_at = ? WHERE id = ?`, [
        ...update.params,
        now(),
        id,
      ]);
    }

    // undefined leaves the stored key alone; null clears it. Distinguishing the
    // two is what lets the Settings form save without re-typing the key.
    if (input.apiKey !== undefined) {
      setSecret(connectorKeyRef(id), input.apiKey);
    }

    saveDatabase(this.db);
    return this.getById(id)!;
  }

  delete(id: string): void {
    deleteSecret(connectorKeyRef(id));
    this.db.run(`DELETE FROM ai_connectors WHERE id = ?`, [id]);
    saveDatabase(this.db);
  }

  // --- task bindings -------------------------------------------------------

  getBindings(): AiTaskBinding[] {
    const rows = all(this.db, `SELECT task, connector_id, prompt_override FROM ai_task_bindings`);
    const stored = new Map(
      rows.map((row) => [
        reqStr(row.task),
        { task: reqStr(row.task) as AiTask, connectorId: str(row.connector_id), promptOverride: str(row.prompt_override) },
      ])
    );

    // Always return a row per task, bound or not, so the UI can render the full
    // list without special-casing "never configured".
    return AI_TASKS.map(
      (task) => stored.get(task) ?? { task, connectorId: null, promptOverride: null }
    );
  }

  getBinding(task: AiTask): AiTaskBinding {
    return this.getBindings().find((b) => b.task === task)!;
  }

  /** Resolves the connector a task should run on, or null if unbound/disabled. */
  resolveConnector(task: AiTask): AiConnector | null {
    const binding = this.getBinding(task);
    if (!binding.connectorId) return null;
    const connector = this.getById(binding.connectorId);
    return connector && connector.enabled ? connector : null;
  }

  setBinding(task: AiTask, connectorId: string | null, promptOverride?: string | null): AiTaskBinding {
    this.db.run(
      `INSERT INTO ai_task_bindings (task, connector_id, prompt_override, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(task) DO UPDATE SET
         connector_id = excluded.connector_id,
         prompt_override = COALESCE(excluded.prompt_override, ai_task_bindings.prompt_override),
         updated_at = excluded.updated_at`,
      [task, connectorId, promptOverride ?? null, now()]
    );
    saveDatabase(this.db);
    return this.getBinding(task);
  }

  /**
   * Points every unbound task at a connector. Called after the first connector
   * is added so a new install is immediately usable without visiting the task
   * bindings screen.
   */
  bindUnboundTasksTo(connectorId: string): void {
    for (const binding of this.getBindings()) {
      if (!binding.connectorId) {
        this.setBinding(binding.task, connectorId);
      }
    }
  }
}
