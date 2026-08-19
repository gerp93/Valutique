import { AiTask, AiTier } from '../../shared/types/connector';
import { BatchEstimate } from '../../shared/types/job';
import { BILLING_MODE_LABELS } from '../../shared/providerTemplates';
import { ConnectorService } from '../database/connectorService';
import { JobService } from '../database/jobService';
import { PhotoService } from '../database/photoService';
import { SettingsService } from '../database/settingsService';
import { CLI_SLOWDOWN_FACTOR, estimateCost, formatCost, TASK_TOKEN_BASELINE } from './cost';

/**
 * What a run will cost and how long it will take, shown before it starts.
 *
 * This is the point of the whole cost surface. "Appraise 42 items" means
 * something different on each connector -- a few dollars on an API key, nothing
 * at all on a subscription, twenty minutes versus overnight -- and the user
 * should see which before committing, not discover it afterwards on a bill.
 *
 * Estimates prefer the user's own observed history over any built-in
 * assumption: once jobs have run, their photos, their field count, and their
 * model are better predictors than anything hardcoded.
 */
export class BatchEstimator {
  constructor(
    private connectors: ConnectorService,
    private jobs: JobService,
    private photos: PhotoService,
    private settings: SettingsService
  ) {}

  estimate(task: AiTask, tier: AiTier, itemIds: string[], connectorId?: string | null): BatchEstimate {
    const connector = connectorId
      ? this.connectors.getById(connectorId)
      : this.connectors.resolveConnector(task, tier);

    const settings = this.settings.get();
    const baseline = TASK_TOKEN_BASELINE[task];
    const warnings: string[] = [];

    if (!connector) {
      return {
        itemCount: itemIds.length,
        task,
        tier,
        connectorId: null,
        connectorName: 'Not configured',
        billingMode: '—',
        estimatedCost: null,
        currency: settings.defaultCurrency,
        estimatedTokensIn: 0,
        estimatedTokensOut: 0,
        estimatedSearches: 0,
        estimatedSeconds: 0,
        costSummary: 'No connector is set up for this task.',
        warnings: ['Add a connector in Settings and bind it to this task before running.'],
      };
    }

    const observed = this.observedAverages(task, connector.id);

    // Image tokens are the dominant input cost and they are knowable exactly --
    // count the photos actually attached rather than assuming a number.
    const imageTokens = this.estimateImageTokens(itemIds, settings.aiMaxPhotosPerItem, settings.aiImageMaxEdge);

    const perItemIn = observed?.tokensIn ?? baseline.tokensIn + imageTokens.perItem - 3000;
    const perItemOut = observed?.tokensOut ?? baseline.tokensOut;

    const searchesPerItem =
      task === 'appraise' && tier === 'deep' && connector.supportsWebSearch
        ? Math.min(baseline.searches, settings.maxSearchesPerAppraisal)
        : 0;

    const count = itemIds.length;
    const tokensIn = Math.round(perItemIn * count);
    const tokensOut = Math.round(perItemOut * count);
    const searches = searchesPerItem * count;

    const cost = estimateCost(connector, { tokensIn, tokensOut, webSearches: searches });

    const perItemSeconds =
      observed?.seconds ??
      (connector.transport === 'cli' ? baseline.seconds * CLI_SLOWDOWN_FACTOR : baseline.seconds);
    const seconds = Math.round((perItemSeconds * count) / Math.max(1, settings.jobConcurrency));

    // Capability problems are worth surfacing here rather than as 300 identical
    // job errors later.
    if (task === 'appraise' && tier === 'deep' && !connector.supportsWebSearch) {
      warnings.push(
        `"${connector.name}" cannot search the web, so values will come from model memory alone and no real comparable listings will be saved.`
      );
    }
    if (!connector.supportsVision) {
      warnings.push(`"${connector.name}" is not set up for images, so it cannot read your photos.`);
    }
    if (connector.billingMode === 'subscription' && count > 50) {
      warnings.push(
        `A batch this size will likely hit a usage window on "${connector.name}". The queue pauses and resumes on its own, so it may finish over several hours rather than in one go.`
      );
    }
    if (connector.billingMode === 'api_credits' && connector.pricing.inputPerMTok === null) {
      warnings.push(`No prices are set for "${connector.name}", so this run cannot be costed. Add them in Settings.`);
    }

    return {
      itemCount: count,
      task,
      tier,
      connectorId: connector.id,
      connectorName: connector.name,
      billingMode: BILLING_MODE_LABELS[connector.billingMode] ?? connector.billingMode,
      estimatedCost: cost,
      currency: connector.pricing.currency,
      estimatedTokensIn: tokensIn,
      estimatedTokensOut: tokensOut,
      estimatedSearches: searches,
      estimatedSeconds: seconds,
      costSummary: summarize(connector.billingMode, cost, connector.pricing.currency, connector.name, observed !== null),
      warnings,
    };
  }

  /** Real per-item figures from this user's completed jobs, once there are enough to mean anything. */
  private observedAverages(
    task: AiTask,
    connectorId: string
  ): { tokensIn: number; tokensOut: number; seconds: number } | null {
    const duration = this.jobs.averageDurationMs(task, connectorId);
    const recent = this.jobs
      .getRecent(200)
      .filter((job) => job.task === task && job.connectorId === connectorId && job.status === 'done');

    // Three samples is enough to beat a generic baseline and few enough that
    // the estimate becomes personal almost immediately. Below that, fall back
    // to the baseline entirely -- a half-observed estimate mixing real token
    // counts with a guessed duration is worse than a consistent guess.
    const withTokens = recent.filter((job) => job.tokensIn !== null);
    if (withTokens.length < 3) return null;

    const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

    return {
      tokensIn: avg(withTokens.map((job) => job.tokensIn ?? 0)),
      tokensOut: avg(withTokens.map((job) => job.tokensOut ?? 0)),
      seconds: duration ? duration / 1000 : TASK_TOKEN_BASELINE[task].seconds,
    };
  }

  private estimateImageTokens(itemIds: string[], maxPhotos: number, maxEdge: number): { perItem: number } {
    if (itemIds.length === 0) return { perItem: 0 };

    // Sampling a handful is plenty -- photo counts are consistent within a
    // batch, and this avoids a query per item on a 300-item estimate.
    const sample = itemIds.slice(0, 10);
    const counts = sample.map((id) => Math.min(this.photos.getForItem(id).length, maxPhotos));
    const avgPhotos = counts.length > 0 ? counts.reduce((a, b) => a + b, 0) / counts.length : 1;

    // A downscaled photo is at most maxEdge on the long side; assume 4:3.
    const pixels = maxEdge * (maxEdge * 0.75);
    return { perItem: Math.round((pixels / 750) * avgPhotos) };
  }
}

function summarize(
  billingMode: string,
  cost: number | null,
  currency: string,
  connectorName: string,
  fromHistory: boolean
): string {
  const basis = fromHistory ? 'based on your actual usage so far' : 'estimated';

  switch (billingMode) {
    case 'subscription':
      return `Free — runs on your ${connectorName} subscription rather than API credits.`;
    case 'local_free':
      return `Free — runs locally on your own hardware.`;
    default:
      if (cost === null) return 'Cannot be costed until prices are set for this connector.';
      if (cost < 0.01) return `Under a cent (${basis}).`;
      return `About ${formatCost(cost, currency)} (${basis}).`;
  }
}
