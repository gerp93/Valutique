import { useEffect, useState } from 'react';
import {
  AiConnector,
  AiTaskBinding,
  AI_TASKS,
  AI_TASK_DESCRIPTIONS,
  AI_TASK_LABELS,
  BillingMode,
  ConnectorProvider,
  ConnectorTestResult,
  CreateConnectorInput,
} from '@shared/types/connector';
import { CliEnvironment, CliInstallResult, CliStatus } from '@shared/types/cli';
import { CUSTOM_MODEL, findModel, modelsFor, tokenizeArgs, validateCliArgs } from '@shared/modelCatalog';
import { AppSettings, DbLocationInfo, MediaLocationInfo, UpdateCheckResult } from '@shared/types/settings';
import { BILLING_MODE_BADGES, PROVIDER_TEMPLATES, templateFor } from '@shared/providerTemplates';
import { THEME_LABELS } from '../utils/themes';
import { useTheme } from '../context/ThemeContext';
import { formatBytes } from '../utils/format';

export default function Settings() {
  const [connectors, setConnectors] = useState<AiConnector[]>([]);
  const [bindings, setBindings] = useState<AiTaskBinding[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [dbLocation, setDbLocation] = useState<DbLocationInfo | null>(null);
  const [mediaLocation, setMediaLocation] = useState<MediaLocationInfo | null>(null);
  const [encryptionOk, setEncryptionOk] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AiConnector | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ConnectorTestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [cliEnvironment, setCliEnvironment] = useState<CliEnvironment | null>(null);
  const [tab, setTab] = useState<'ai' | 'app'>('ai');
  const { currentTheme, setTheme, availableThemes } = useTheme();

  // Probing spawns processes, so it runs once on mount and after an install
  // rather than on every render of the connector list.
  const detectCli = async () => {
    setCliEnvironment(await window.valutique.cli.detect());
  };

  const refresh = async () => {
    const [nextConnectors, nextBindings, nextSettings, nextDb, nextMedia, encryption] = await Promise.all([
      window.valutique.connectors.getAll(),
      window.valutique.connectors.getBindings(),
      window.valutique.settings.get(),
      window.valutique.dbLocation.get(),
      window.valutique.mediaLocation.get(),
      window.valutique.settings.encryptionAvailable(),
    ]);
    setConnectors(nextConnectors);
    setBindings(nextBindings);
    setSettings(nextSettings);
    setDbLocation(nextDb);
    setMediaLocation(nextMedia);
    setEncryptionOk(encryption);
  };

  useEffect(() => {
    void refresh();
    void detectCli();
  }, []);

  const patchSettings = async (patch: Parameters<typeof window.valutique.settings.update>[0]) => {
    setSettings(await window.valutique.settings.update(patch));
  };

  const test = async (connector: AiConnector) => {
    setTesting(connector.id);
    try {
      setTestResults({ ...testResults, [connector.id]: await window.valutique.connectors.test(connector.id) });
    } finally {
      setTesting(null);
    }
  };

  if (!settings) return <p className="text-muted">Loading…</p>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="subtitle">Connectors, processing, and where your data lives.</p>
        </div>
      </div>

      <div className="tab-bar">
        <button className={`tab-button${tab === 'ai' ? ' active' : ''}`} onClick={() => setTab('ai')}>
          AI Settings
        </button>
        <button className={`tab-button${tab === 'app' ? ' active' : ''}`} onClick={() => setTab('app')}>
          App Settings
        </button>
      </div>

      {tab === 'ai' && (
      <>
      {!encryptionOk && (
        <div className="banner banner-warn">
          Your system has no keychain available, so API keys are stored on disk without encryption. The CLI connectors
          need no key at all and avoid this entirely.
        </div>
      )}

      {/* --- connectors --- */}
      <div className="card">
        <h2>AI connectors</h2>
        <p className="card-hint">
          Add as many as you like and point each task at whichever you prefer. The CLI connectors run against a
          subscription you already pay for, so they cost nothing per item; API connectors are faster but metered.
        </p>

        {connectors.length === 0 ? (
          <p className="text-muted">None yet. Add one to start identifying and valuing items.</p>
        ) : (
          connectors.map((connector) => {
            const template = templateFor(connector.provider);
            const result = testResults[connector.id];
            // A CLI that was uninstalled after the connector was created would
            // otherwise only surface as a failed job mid-batch.
            const cliGone =
              connector.transport === 'cli' &&
              cliEnvironment !== null &&
              cliEnvironment.statuses[connector.provider]?.installed === false;

            return (
              <div key={connector.id} className="connector-row">
                <div className="connector-main">
                  <div className="connector-name">
                    {connector.name}
                    <span className={`pill${connector.billingMode === 'api_credits' ? '' : ' pill-good'}`}>
                      {BILLING_MODE_BADGES[connector.billingMode]}
                    </span>
                    {!connector.enabled && <span className="pill">disabled</span>}
                    {connector.supportsWebSearch && <span className="pill pill-good">web search</span>}
                    {!connector.supportsVision && <span className="pill pill-bad">no images</span>}
                    {cliGone && <span className="pill pill-bad">command not found</span>}
                  </div>

                  {cliGone && (
                    <div className="banner banner-bad" style={{ marginTop: 10, marginBottom: 0 }}>
                      <code>{connector.cliCommand}</code> is no longer on your PATH, so jobs on this connector will
                      fail. Reinstall it with <code>npm install -g {template?.npmPackage}</code>.
                    </div>
                  )}

                  <div className="connector-meta">
                    {template?.label}
                    {connector.model && ` · ${connector.model}`}
                    {connector.baseUrl && ` · ${connector.baseUrl}`}
                    {connector.transport === 'http' && !connector.hasApiKey && template?.requiresApiKey && (
                      <span className="pill pill-bad" style={{ marginLeft: 6 }}>
                        no API key
                      </span>
                    )}
                  </div>

                  {/* The whole point of the connector design is that these two
                      cost very different amounts -- say so, in plain words,
                      right where the choice is made. */}
                  <div className="connector-billing">
                    {template?.billingExplainer}
                    {connector.billingMode === 'api_credits' && connector.pricing.inputPerMTok !== null && (
                      <>
                        {' '}
                        Current prices: {connector.pricing.inputPerMTok} in / {connector.pricing.outputPerMTok} out per
                        million tokens
                        {connector.pricing.webSearchPerThousand
                          ? `, ${connector.pricing.webSearchPerThousand} per 1,000 searches`
                          : ''}
                        .
                      </>
                    )}
                  </div>

                  {result && (
                    <div className={`banner ${result.ok ? '' : 'banner-bad'}`} style={{ marginTop: 10, marginBottom: 0 }}>
                      {result.message}
                      {result.latencyMs !== null && ` (${(result.latencyMs / 1000).toFixed(1)}s)`}
                      {result.detail && <div className="text-muted" style={{ fontSize: 12 }}>{result.detail}</div>}
                    </div>
                  )}
                </div>

                <div className="connector-actions">
                  <button className="btn btn-small" disabled={testing === connector.id} onClick={() => void test(connector)}>
                    {testing === connector.id ? 'Testing…' : 'Test'}
                  </button>
                  <button className="btn btn-small" onClick={() => setEditing(connector)}>
                    Edit
                  </button>
                  <button
                    className="btn btn-small btn-danger"
                    onClick={async () => {
                      await window.valutique.connectors.delete(connector.id);
                      await refresh();
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })
        )}

        <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setAdding(true)}>
          Add connector
        </button>
      </div>

      {/* --- task bindings --- */}
      <div className="card">
        <h2>Which connector does what</h2>
        <p className="card-hint">
          Each task can run on a different connector. A common setup: a free CLI connector for the bulk identification
          work, and whichever connector searches best for appraisal.
        </p>

        {AI_TASKS.map((task) => {
          const binding = bindings.find((entry) => entry.task === task);
          const bound = connectors.find((connector) => connector.id === binding?.connectorId);
          const searchWarning = task === 'appraise' && bound && !bound.supportsWebSearch;

          return (
            <div key={task} className="field">
              <label>{AI_TASK_LABELS[task]}</label>
              <select
                value={binding?.connectorId ?? ''}
                onChange={async (event) => {
                  await window.valutique.connectors.setBinding(task, event.target.value || null);
                  await refresh();
                }}
              >
                <option value="">Not set</option>
                {connectors
                  .filter((connector) => connector.enabled)
                  .map((connector) => (
                    <option key={connector.id} value={connector.id}>
                      {connector.name} — {BILLING_MODE_BADGES[connector.billingMode]}
                    </option>
                  ))}
              </select>
              <span className="field-hint">{AI_TASK_DESCRIPTIONS[task]}</span>
              {searchWarning && (
                <span className="field-hint" style={{ color: 'var(--color-accent-red)' }}>
                  {bound.name} cannot search the web. Valuations will come from model memory with no real comparable
                  listings behind them.
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* --- processing --- */}
      <div className="card">
        <h2>Processing</h2>
        <p className="card-hint">
          Photo size is the single biggest cost lever — image tokens scale with pixel count, and 1024px is plenty to
          identify most collectibles.
        </p>

        <div className="grid-3">
          <div className="field">
            <label>Photo size sent to AI</label>
            <select
              value={settings.aiImageMaxEdge}
              onChange={(event) => void patchSettings({ aiImageMaxEdge: Number(event.target.value) })}
            >
              <option value={640}>640px — cheapest</option>
              <option value={1024}>1024px — recommended</option>
              <option value={1568}>1568px — more detail, ~2.5x cost</option>
            </select>
          </div>
          <div className="field">
            <label>Photos per item</label>
            <input
              type="number"
              min={1}
              max={8}
              value={settings.aiMaxPhotosPerItem}
              onChange={(event) => void patchSettings({ aiMaxPhotosPerItem: Number(event.target.value) })}
            />
          </div>
          <div className="field">
            <label>Jobs at once</label>
            <input
              type="number"
              min={1}
              max={8}
              value={settings.jobConcurrency}
              onChange={(event) => void patchSettings({ jobConcurrency: Number(event.target.value) })}
            />
            <span className="field-hint">Keep this low for CLI connectors — each job launches a process.</span>
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label>Web searches per appraisal</label>
            <input
              type="number"
              min={0}
              max={10}
              value={settings.maxSearchesPerAppraisal}
              onChange={(event) => void patchSettings({ maxSearchesPerAppraisal: Number(event.target.value) })}
            />
            <span className="field-hint">The main cost driver on appraisal. Zero disables searching entirely.</span>
          </div>
          <div className="field">
            <label>Currency</label>
            <input
              value={settings.defaultCurrency}
              onChange={(event) => void patchSettings({ defaultCurrency: event.target.value.toUpperCase() })}
            />
          </div>
        </div>

        <div className="field-inline">
          <input
            id="auto-import"
            type="checkbox"
            checked={settings.autoProcessOnImport}
            onChange={(event) => void patchSettings({ autoProcessOnImport: event.target.checked })}
          />
          <label htmlFor="auto-import">Start identifying as soon as photos are added</label>
        </div>
        <div className="field-inline">
          <input
            id="auto-appraise"
            type="checkbox"
            checked={settings.autoAppraiseAfterIdentify}
            onChange={(event) => void patchSettings({ autoAppraiseAfterIdentify: event.target.checked })}
          />
          <label htmlFor="auto-appraise">Appraise automatically once an item is identified</label>
        </div>
        <div className="field-inline">
          <input
            id="verify-urls"
            type="checkbox"
            checked={settings.verifyCompUrls}
            onChange={(event) => void patchSettings({ verifyCompUrls: event.target.checked })}
          />
          <label htmlFor="verify-urls">Check that every comparable link actually resolves</label>
        </div>
      </div>

      {/* --- eBay --- */}
      <div className="card">
        <h2>eBay listings (optional)</h2>
        <p className="card-hint">
          Adds structured listing data to appraisals. Note that eBay's free API returns <strong>active listings only</strong>{' '}
          — asking prices, not completed sales — so it is used as an upper bound rather than as sale evidence.
        </p>

        <div className="field-inline">
          <input
            id="ebay-enabled"
            type="checkbox"
            checked={settings.ebayEnabled}
            onChange={(event) => void patchSettings({ ebayEnabled: event.target.checked })}
          />
          <label htmlFor="ebay-enabled">Use eBay listings when appraising</label>
        </div>

        {settings.ebayEnabled && (
          <div className="grid-2">
            <div className="field">
              <label>App ID (Client ID)</label>
              <input
                type="password"
                placeholder={settings.hasEbayCredentials ? '•••••• stored' : 'not set'}
                onBlur={(event) => event.target.value && void patchSettings({ ebayClientId: event.target.value })}
              />
            </div>
            <div className="field">
              <label>Cert ID (Client Secret)</label>
              <input
                type="password"
                placeholder={settings.hasEbayCredentials ? '•••••• stored' : 'not set'}
                onBlur={(event) => event.target.value && void patchSettings({ ebayClientSecret: event.target.value })}
              />
            </div>
          </div>
        )}
      </div>
      </>
      )}

      {tab === 'app' && (
      <>
      {/* --- storage --- */}
      <div className="card">
        <h2>Where your data lives</h2>
        <p className="card-hint">
          Both can be moved into a cloud-synced folder for backup. API keys are deliberately kept out of the database
          and stored in your system keychain, so syncing your collection never syncs your credentials.
        </p>

        {dbLocation && (
          <div className="field">
            <label>Database</label>
            <div className="text-muted" style={{ fontSize: 13, wordBreak: 'break-all' }}>
              {dbLocation.path}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                className="btn btn-small"
                onClick={async () => {
                  const chosen = await window.valutique.dbLocation.browseNew();
                  if (chosen) await window.valutique.dbLocation.set(chosen);
                }}
              >
                Move it…
              </button>
              <button
                className="btn btn-small"
                onClick={async () => {
                  const chosen = await window.valutique.dbLocation.browseExisting();
                  if (chosen) await window.valutique.dbLocation.set(chosen);
                }}
              >
                Open an existing one…
              </button>
              {!dbLocation.isDefault && (
                <button className="btn btn-small" onClick={() => void window.valutique.dbLocation.resetToDefault()}>
                  Reset to default
                </button>
              )}
            </div>
            <span className="field-hint">Changing this restarts the app.</span>
          </div>
        )}

        {mediaLocation && (
          <div className="field">
            <label>Photos</label>
            <div className="text-muted" style={{ fontSize: 13, wordBreak: 'break-all' }}>
              {mediaLocation.path} · {mediaLocation.fileCount} files, {formatBytes(mediaLocation.totalBytes)}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                className="btn btn-small"
                onClick={async () => {
                  const chosen = await window.valutique.mediaLocation.browse();
                  if (chosen) {
                    await window.valutique.mediaLocation.set(chosen);
                    await refresh();
                  }
                }}
              >
                Move it…
              </button>
              <button
                className="btn btn-small"
                onClick={() => void window.valutique.shell.showItemInFolder(mediaLocation.path)}
              >
                Show in folder
              </button>
            </div>
          </div>
        )}
      </div>

      {/* --- appearance --- */}
      <div className="card">
        <h2>Appearance</h2>
        <div className="field">
          <label>Theme</label>
          <select value={currentTheme ?? ''} onChange={(event) => setTheme((event.target.value || null) as never)}>
            <option value="">Default</option>
            {availableThemes.map((theme) => (
              <option key={theme} value={theme}>
                {THEME_LABELS[theme]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* --- updates --- */}
      <div className="card">
        <h2>Updates</h2>
        <button
          className="btn"
          onClick={async () => setUpdateResult(await window.valutique.updates.check())}
        >
          Check for updates
        </button>
        {updateResult && (
          <p className="text-muted" style={{ marginTop: 10, fontSize: 13 }}>
            {updateResult.status === 'available' && `Version ${updateResult.version} is downloading.`}
            {updateResult.status === 'not-available' && "You're on the latest version."}
            {updateResult.status === 'unsupported' && 'Updates only apply to packaged builds.'}
            {updateResult.status === 'error' && (updateResult.message ?? 'Could not check for updates.')}
          </p>
        )}
      </div>
      </>
      )}

      {(adding || editing) && (
        <ConnectorModal
          existing={editing}
          cliEnvironment={cliEnvironment}
          onCliChanged={() => void detectCli()}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setAdding(false);
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </>
  );
}

function ConnectorModal({
  existing,
  cliEnvironment,
  onCliChanged,
  onClose,
  onSaved,
}: {
  existing: AiConnector | null;
  cliEnvironment: CliEnvironment | null;
  onCliChanged: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState<ConnectorProvider>(existing?.provider ?? 'claude_cli');
  const template = templateFor(provider);

  const [name, setName] = useState(existing?.name ?? template?.label ?? '');
  const [model, setModel] = useState(existing?.model ?? template?.defaultModel ?? '');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? template?.defaultBaseUrl ?? '');
  const [cliCommand, setCliCommand] = useState(existing?.cliCommand ?? template?.defaultCliCommand ?? '');
  const [apiKey, setApiKey] = useState('');
  const [billingMode, setBillingMode] = useState<BillingMode>(
    existing?.billingMode ?? template?.billingMode ?? 'api_credits'
  );
  const [inputPrice, setInputPrice] = useState(String(existing?.pricing.inputPerMTok ?? template?.defaultPricing.inputPerMTok ?? ''));
  const [outputPrice, setOutputPrice] = useState(String(existing?.pricing.outputPerMTok ?? template?.defaultPricing.outputPerMTok ?? ''));
  const [searchPrice, setSearchPrice] = useState(
    String(existing?.pricing.webSearchPerThousand ?? template?.defaultPricing.webSearchPerThousand ?? '')
  );
  const [supportsVision, setSupportsVision] = useState(existing?.supportsVision ?? template?.supportsVision ?? true);
  const [maxTokens, setMaxTokens] = useState(existing?.maxTokens ?? 16000);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cliArgsText, setCliArgsText] = useState((existing?.cliArgs ?? []).join(' '));
  const [showAdvanced, setShowAdvanced] = useState((existing?.cliArgs ?? []).length > 0);
  const [remoteModels, setRemoteModels] = useState<string[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [probe, setProbe] = useState<CliStatus | null>(null);
  const [probing, setProbing] = useState(false);

  const [installing, setInstalling] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState('');
  const [installResult, setInstallResult] = useState<CliInstallResult | null>(null);

  const cliStatus = template?.transport === 'cli' ? cliEnvironment?.statuses[provider] ?? null : null;
  const cliMissing = template?.transport === 'cli' && cliEnvironment !== null && cliStatus?.installed === false;

  // Detection may have found the tool somewhere this app's PATH doesn't cover
  // (Claude Code's native installer puts itself in ~/.local/bin, which a GUI
  // process on Windows usually can't see). Adopt the absolute path it found so
  // the connector actually runs, without making the user hunt for it.
  useEffect(() => {
    if (existing) return;
    if (cliStatus?.installed && cliStatus.resolvedPath && !cliStatus.foundOnPath) {
      setCliCommand(cliStatus.resolvedPath);
    }
  }, [existing, cliStatus?.resolvedPath, cliStatus?.foundOnPath, cliStatus?.installed]);

  const choose = (next: ConnectorProvider) => {
    const nextTemplate = templateFor(next);
    setProvider(next);
    setName(nextTemplate?.label ?? '');
    setModel(nextTemplate?.defaultModel ?? '');
    setBaseUrl(nextTemplate?.defaultBaseUrl ?? '');
    setCliCommand(nextTemplate?.defaultCliCommand ?? '');
    // Billing follows the provider. It is only editable for the one provider
    // where it genuinely varies, so this is the value that sticks everywhere else.
    setBillingMode(nextTemplate?.billingMode ?? 'api_credits');
    setSupportsVision(nextTemplate?.supportsVision ?? true);
    setInputPrice(String(nextTemplate?.defaultPricing.inputPerMTok ?? ''));
    setOutputPrice(String(nextTemplate?.defaultPricing.outputPerMTok ?? ''));
    setSearchPrice(String(nextTemplate?.defaultPricing.webSearchPerThousand ?? ''));
    setInstallResult(null);
    setRemoteModels(null);
    setProbe(null);
    setCliArgsText('');
  };

  /**
   * Applying a model applies its prices too. Leaving stale prices behind after
   * a model change is the quiet way every cost estimate becomes wrong.
   */
  const chooseModel = (id: string) => {
    setModel(id);
    const known = findModel(provider, id);
    if (known) {
      setInputPrice(String(known.inputPerMTok ?? ''));
      setOutputPrice(String(known.outputPerMTok ?? ''));
      setSearchPrice(String(known.webSearchPerThousand ?? ''));
    }
  };

  /**
   * Asks the endpoint what it serves. This is why the model field can be a
   * picker even for a connector whose model list is unknowable in advance --
   * every server in the OpenAI-compatible family exposes /v1/models.
   */
  const loadRemoteModels = async (url: string) => {
    if (!url) return;
    setLoadingModels(true);
    try {
      setRemoteModels(await window.valutique.connectors.listModels(url, existing?.id ?? null));
    } finally {
      setLoadingModels(false);
    }
  };

  const verifyCommand = async () => {
    setProbing(true);
    try {
      setProbe(await window.valutique.cli.probe(cliCommand));
    } finally {
      setProbing(false);
    }
  };

  /**
   * For the OpenAI-compatible connector the URL tells us what the billing
   * really is, so follow it rather than making the user remember to switch.
   */
  const onBaseUrlChange = (value: string) => {
    setBaseUrl(value);
    if (template?.billingModeEditable) {
      const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(value);
      setBillingMode(isLocal ? 'local_free' : 'api_credits');
    }
  };

  const install = async (target: ConnectorProvider) => {
    setInstalling(target);
    setInstallLog('');
    setInstallResult(null);

    const unsubscribe = window.valutique.cli.onInstallProgress((chunk) => {
      setInstallLog((previous) => (previous + chunk).slice(-4000));
    });

    try {
      const result = await window.valutique.cli.install(target);
      setInstallResult(result);
      onCliChanged();
    } catch (err) {
      setInstallResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        log: '',
        status: null,
      });
    } finally {
      unsubscribe();
      setInstalling(null);
    }
  };

  const catalogue = modelsFor(provider);
  const cliArgs = tokenizeArgs(cliArgsText);
  const argsProblem = validateCliArgs(cliArgs);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: CreateConnectorInput = {
        name,
        provider,
        model: model || null,
        baseUrl: baseUrl || null,
        cliCommand: cliCommand || null,
        cliArgs,
        billingMode,
        supportsVision,
        // Never taken from the form: whether a connector can search is a fact
        // about the adapter behind it, not a preference. Letting someone tick
        // it on a local model would just produce appraisals with no comps.
        supportsWebSearch: template?.supportsWebSearch ?? false,
        supportsStructuredOutput: template?.supportsStructuredOutput ?? false,
        maxTokens,
        pricing: {
          inputPerMTok: inputPrice ? Number(inputPrice) : null,
          outputPerMTok: outputPrice ? Number(outputPrice) : null,
          webSearchPerThousand: searchPrice ? Number(searchPrice) : null,
          currency: existing?.pricing.currency ?? 'USD',
        },
      };

      if (existing) {
        // An empty key field means "leave the stored key alone", never "clear
        // it" -- otherwise saving any other change would wipe the credential.
        await window.valutique.connectors.update(existing.id, {
          ...payload,
          ...(apiKey ? { apiKey } : {}),
        });
      } else {
        await window.valutique.connectors.create({ ...payload, apiKey: apiKey || null });
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={saving || installing ? undefined : onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <h2>{existing ? `Edit ${existing.name}` : 'Add a connector'}</h2>

        {!existing && (
          <>
            {cliEnvironment === null && (
              <p className="card-hint">Checking which command-line tools you have installed…</p>
            )}

            <div className="provider-choice">
              {PROVIDER_TEMPLATES.map((option) => {
                const status = cliEnvironment?.statuses[option.provider];
                const isCli = option.transport === 'cli';
                const notInstalled = isCli && cliEnvironment !== null && status?.installed === false;

                return (
                  <div
                    key={option.provider}
                    className={`provider-option${provider === option.provider ? ' selected' : ''}`}
                    onClick={() => choose(option.provider)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => event.key === 'Enter' && choose(option.provider)}
                  >
                    <div>
                      <div className="provider-option-label">
                        {option.label}
                        <span className={`pill${option.billingMode === 'api_credits' ? '' : ' pill-good'}`}>
                          {BILLING_MODE_BADGES[option.billingMode]}
                        </span>
                      </div>
                      <div className="provider-option-blurb">{option.blurb}</div>
                    </div>

                    {isCli && (
                      <div className="provider-option-side">
                        {status?.installed ? (
                          <span
                            className="pill pill-good"
                            title={status.foundOnPath ? 'Found on your PATH' : `Found at ${status.resolvedPath}`}
                          >
                            installed{status.version ? ` v${status.version}` : ''}
                          </span>
                        ) : notInstalled ? (
                          <>
                            <span className="pill pill-bad">not installed</span>
                            <button
                              className="btn btn-small"
                              disabled={installing !== null || !cliEnvironment?.npmAvailable}
                              title={
                                cliEnvironment?.npmAvailable
                                  ? `Runs: npm install -g ${option.npmPackage}`
                                  : 'npm was not found — install Node.js first.'
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                void install(option.provider);
                              }}
                            >
                              {installing === option.provider ? 'Installing…' : 'Install'}
                            </button>
                          </>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {installing && (
          <div className="banner">
            Running <code>npm install -g {templateFor(installing)?.npmPackage}</code>. This usually takes a minute.
            {installLog && <div className="install-log">{installLog}</div>}
          </div>
        )}

        {installResult && !installing && (
          <div className={`banner ${installResult.ok ? '' : 'banner-bad'}`}>
            {installResult.message}
            {!installResult.ok && installResult.log && <div className="install-log">{installResult.log}</div>}
          </div>
        )}

        {template && (
          <>
            <div className="connector-billing">{template.billingExplainer}</div>
            {template.notes.length > 0 && (
              <ul className="note-list">
                {template.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </>
        )}

        {cliMissing && !installResult?.ok && (
          <div className="banner banner-warn">
            <strong>{template?.label} isn't installed yet.</strong>{' '}
            {cliEnvironment?.npmAvailable
              ? 'Use the Install button above, or install it yourself with:'
              : 'npm was not found, so Valutique cannot install it for you. Install Node.js, then run:'}{' '}
            <code>npm install -g {template?.npmPackage}</code>
            {template?.postInstallHint && <div style={{ marginTop: 6 }}>{template.postInstallHint}</div>}
          </div>
        )}

        <div className="grid-2" style={{ marginTop: 18 }}>
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label>Model {template?.transport === 'cli' && '(optional)'}</label>

            {catalogue.length > 0 ? (
              <>
                <select
                  value={catalogue.some((entry) => entry.id === model) ? model : CUSTOM_MODEL}
                  onChange={(event) =>
                    event.target.value === CUSTOM_MODEL ? setModel('') : chooseModel(event.target.value)
                  }
                >
                  {catalogue.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                  <option value={CUSTOM_MODEL}>Something else...</option>
                </select>
                {!catalogue.some((entry) => entry.id === model) && (
                  <input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="model id"
                    style={{ marginTop: 6 }}
                  />
                )}
                <span className="field-hint">
                  {findModel(provider, model)?.note ??
                    'Not one of the known models, so the prices below will not follow it. Set them to match.'}
                </span>
              </>
            ) : template?.transport === 'http' ? (
              <>
                <div style={{ display: 'flex', gap: 6 }}>
                  {remoteModels && remoteModels.length > 0 ? (
                    <select
                      value={remoteModels.includes(model) ? model : CUSTOM_MODEL}
                      onChange={(event) =>
                        event.target.value === CUSTOM_MODEL ? setModel('') : setModel(event.target.value)
                      }
                      style={{ flex: 1 }}
                    >
                      {remoteModels.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                      <option value={CUSTOM_MODEL}>Something else...</option>
                    </select>
                  ) : (
                    <input
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                      placeholder="model id"
                      style={{ flex: 1 }}
                    />
                  )}
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={loadingModels || !baseUrl}
                    onClick={() => void loadRemoteModels(baseUrl)}
                  >
                    {loadingModels ? 'Asking...' : remoteModels ? 'Refresh' : 'List models'}
                  </button>
                </div>
                <span className="field-hint">
                  {remoteModels === null
                    ? 'This server can tell us what it has. Click List models once the URL is right.'
                    : remoteModels.length === 0
                      ? 'That server returned no models. Check the URL, or type the name yourself.'
                      : `${remoteModels.length} available. Pick a vision-capable one, or it cannot read your photos.`}
                </span>
              </>
            ) : (
              <>
                <input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="leave blank for the CLI default"
                />
                <span className="field-hint">
                  Optional. Blank uses whatever the CLI is already configured to use, which is usually right.
                </span>
              </>
            )}
          </div>
        </div>

        {template?.transport === 'cli' ? (
          <div className="field">
            <label>Executable</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={cliCommand}
                onChange={(event) => {
                  setCliCommand(event.target.value);
                  setProbe(null);
                }}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-small"
                disabled={probing || !cliCommand}
                onClick={() => void verifyCommand()}
              >
                {probing ? 'Checking...' : 'Verify'}
              </button>
            </div>

            {probe && (
              <span className="field-hint" style={{ color: probe.installed ? undefined : 'var(--color-accent-red)' }}>
                {probe.installed
                  ? `Runs${probe.version ? ` (v${probe.version})` : ''}.`
                  : 'That did not run. Give the full path to the executable if it is not on your PATH.'}
              </span>
            )}

            <span className="field-hint">
              {cliStatus?.installed
                ? cliStatus.foundOnPath
                  ? `Found on your PATH${cliStatus.version ? ` (v${cliStatus.version})` : ''}. Installed is not the same as signed in, so use Test after saving.`
                  : `Found outside the PATH this app can see, so the full path is used instead. Installed is not the same as signed in, so use Test after saving.`
                : 'Must be on your PATH, or give the full path to the executable.'}
            </span>

            <span className="field-hint">
              This is a path to a program, not a command line. Extra flags belong under Advanced.
            </span>

            {showAdvanced ? (
              <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
                <label>Extra arguments</label>
                <input
                  value={cliArgsText}
                  onChange={(event) => setCliArgsText(event.target.value)}
                  placeholder="--add-dir C:\\reference --settings profile.json"
                />
                <span className="field-hint">
                  Passed on every call, ahead of the arguments Valutique sets itself. Quoted sections stay together.
                  Flags that control the prompt or the output format are refused, because those are how results get
                  read back.
                </span>
                {argsProblem && (
                  <span className="field-hint" style={{ color: 'var(--color-accent-red)' }}>
                    {argsProblem}
                  </span>
                )}
              </div>
            ) : (
              <button
                type="button"
                className="btn-link"
                style={{ marginTop: 10, alignSelf: 'flex-start' }}
                onClick={() => setShowAdvanced(true)}
              >
                Advanced: pass extra arguments
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="field">
              <label>Base URL</label>
              <input value={baseUrl} onChange={(event) => onBaseUrlChange(event.target.value)} />
              {template?.billingModeEditable && (
                <span className="field-hint">
                  A localhost URL means a local server — free and unlimited. A hosted endpoint (OpenAI, OpenRouter,
                  GitHub Models) is billed per token; billing below follows the URL, and you can override it.
                </span>
              )}
            </div>
            <div className="field">
              <label>API key{!template?.requiresApiKey && ' (optional)'}</label>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={existing?.hasApiKey ? '•••••• stored — leave blank to keep it' : 'not set'}
              />
              <span className="field-hint">
                Encrypted with your system keychain and kept out of the database, so syncing your collection never
                syncs your credentials. It is never sent back to this screen.
              </span>
            </div>
          </>
        )}

        {/* Facts about the provider, not preferences. Showing them as controls
            let someone mark a metered connector as free and silently break
            every cost estimate. */}
        <div className="grid-2">
          <div className="derived-fact">
            <span className="derived-fact-label">Billing</span>
            {template?.billingModeEditable ? (
              <select value={billingMode} onChange={(event) => setBillingMode(event.target.value as BillingMode)}>
                <option value="local_free">Free — running locally</option>
                <option value="api_credits">Billed per token</option>
              </select>
            ) : (
              <span className="derived-fact-value">
                <span className={`pill${billingMode === 'api_credits' ? '' : ' pill-good'}`}>
                  {BILLING_MODE_BADGES[billingMode]}
                </span>
                <span className="text-muted" style={{ fontSize: 12.5 }}>
                  set by the provider
                </span>
              </span>
            )}
          </div>

          <div className="derived-fact">
            <span className="derived-fact-label">Capabilities</span>
            <span className="derived-fact-value">
              {template?.visionEditable ? (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5 }}>
                  <input
                    type="checkbox"
                    checked={supportsVision}
                    onChange={(event) => setSupportsVision(event.target.checked)}
                  />
                  Reads images
                </label>
              ) : (
                <span className="pill pill-good">reads images</span>
              )}
              <span className={`pill${template?.supportsWebSearch ? ' pill-good' : ' pill-warn'}`}>
                {template?.supportsWebSearch ? 'searches the web' : 'no web search'}
              </span>
            </span>
            {!template?.supportsWebSearch && (
              <span className="field-hint">
                Fine for identifying items. Appraisals from this connector come from model memory with no real
                comparable listings behind them.
              </span>
            )}
          </div>
        </div>

        {/* The CLI decides its own output budget, so this only means something
            for the HTTP connectors. */}
        {template?.transport === 'http' && (
          <div className="field" style={{ maxWidth: 220 }}>
            <label>Max tokens</label>
            <input type="number" value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} />
          </div>
        )}

        {billingMode === 'api_credits' && (
          <>
            <p className="card-hint" style={{ marginTop: 8 }}>
              Prices per million tokens, used only to estimate spend. Providers change these — correct them here so the
              estimates stay honest.
            </p>
            <div className="grid-3">
              <div className="field">
                <label>Input / Mtok</label>
                <input value={inputPrice} onChange={(event) => setInputPrice(event.target.value)} />
              </div>
              <div className="field">
                <label>Output / Mtok</label>
                <input value={outputPrice} onChange={(event) => setOutputPrice(event.target.value)} />
              </div>
              <div className="field">
                <label>Per 1,000 searches</label>
                <input
                  value={searchPrice}
                  onChange={(event) => setSearchPrice(event.target.value)}
                  disabled={!template?.supportsWebSearch}
                />
              </div>
            </div>
          </>
        )}

        {error && <div className="banner banner-bad">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={saving || installing !== null}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={
              saving || installing !== null || !name || Boolean(argsProblem) || (cliMissing && !installResult?.ok)
            }
            title={cliMissing && !installResult?.ok ? 'Install the command first.' : undefined}
          >
            {saving ? 'Saving…' : existing ? 'Save changes' : 'Add connector'}
          </button>
        </div>
      </div>
    </div>
  );
}
