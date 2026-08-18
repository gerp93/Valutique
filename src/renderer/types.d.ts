import { Collection, CollectionSummary, CreateCollectionInput, UpdateCollectionInput } from '@shared/types/collection';
import { CreateFieldDefInput, FieldDef, SuggestedField, UpdateFieldDefInput } from '@shared/types/fieldDef';
import {
  CreateItemInput,
  Item,
  ItemDetail,
  ItemFieldValue,
  ItemFilter,
  ItemListEntry,
  UpdateItemInput,
} from '@shared/types/item';
import { AddPhotosResult, Photo } from '@shared/types/photo';
import { Appraisal } from '@shared/types/appraisal';
import {
  AiConnector,
  AiTask,
  AiTaskBinding,
  AiTier,
  ConnectorTestResult,
  CreateConnectorInput,
  UpdateConnectorInput,
} from '@shared/types/connector';
import { AiJob, BatchEstimate, CliLogEvent, QueueState } from '@shared/types/job';
import { CliEnvironment, CliInstallResult, CliStatus } from '@shared/types/cli';
import { UsageReport } from '@shared/types/usage';
import { ImportAnalysis, ImportPlan, ImportResult } from '@shared/types/import';
import { AppSettings, DbLocationInfo, MediaLocationInfo, UpdateCheckResult, UpdateSettingsInput } from '@shared/types/settings';

export interface DuplicateSuggestion {
  itemIds: string[];
  names: string[];
  similarity: number;
  reason: string;
}

export interface ValutiqueApi {
  collections: {
    getAll(): Promise<Collection[]>;
    getSummaries(): Promise<CollectionSummary[]>;
    getById(id: string): Promise<Collection | null>;
    create(input: CreateCollectionInput): Promise<Collection>;
    update(id: string, input: UpdateCollectionInput): Promise<Collection>;
    delete(id: string): Promise<{ success: boolean }>;
  };
  fields: {
    getForCollection(collectionId: string): Promise<FieldDef[]>;
    create(input: CreateFieldDefInput): Promise<FieldDef>;
    createMany(inputs: CreateFieldDefInput[]): Promise<FieldDef[]>;
    update(id: string, input: UpdateFieldDefInput): Promise<FieldDef>;
    delete(id: string): Promise<{ success: boolean }>;
    reorder(collectionId: string, orderedIds: string[]): Promise<FieldDef[]>;
    suggest(name: string, description: string): Promise<SuggestedField[]>;
  };
  items: {
    list(filter: ItemFilter): Promise<ItemListEntry[]>;
    getDetail(id: string): Promise<ItemDetail | null>;
    create(input: CreateItemInput): Promise<Item>;
    update(id: string, input: UpdateItemInput): Promise<Item>;
    delete(id: string): Promise<{ success: boolean }>;
    setFieldValues(itemId: string, values: Record<string, unknown>): Promise<ItemFieldValue[]>;
    clearAiNotes(itemId: string): Promise<Item>;
    merge(sourceIds: string[], targetId: string): Promise<ItemDetail | null>;
    splitPhoto(photoId: string): Promise<Item | null>;
    locations(collectionId: string): Promise<string[]>;
  };
  photos: {
    getForItem(itemId: string): Promise<Photo[]>;
    setPrimary(photoId: string): Promise<{ success: boolean }>;
    move(photoId: string, targetItemId: string): Promise<Photo | null>;
    delete(photoId: string): Promise<{ success: boolean }>;
    url(relativePath: string): Promise<string>;
    addToItem(itemId: string, filePaths: string[]): Promise<AddPhotosResult>;
  };
  import: {
    pickFiles(): Promise<string[]>;
    pickFolder(): Promise<string[]>;
    analyze(collectionId: string, filePaths: string[], useAi: boolean): Promise<ImportAnalysis>;
    commit(analysis: ImportAnalysis, plan: ImportPlan): Promise<ImportResult>;
  };
  duplicates: {
    findAll(collectionId: string): Promise<DuplicateSuggestion[]>;
    onSuggested(callback: (suggestion: DuplicateSuggestion) => void): () => void;
  };
  connectors: {
    getAll(): Promise<AiConnector[]>;
    create(input: CreateConnectorInput): Promise<AiConnector>;
    update(id: string, input: UpdateConnectorInput): Promise<AiConnector>;
    delete(id: string): Promise<{ success: boolean }>;
    test(id: string): Promise<ConnectorTestResult>;
    listModels(baseUrl: string, connectorId: string | null): Promise<string[]>;
    getBindings(): Promise<AiTaskBinding[]>;
    setBinding(task: AiTask, tier: AiTier, connectorId: string | null): Promise<AiTaskBinding>;
  };
  cli: {
    detect(): Promise<CliEnvironment>;
    probe(command: string): Promise<CliStatus>;
    install(provider: string): Promise<CliInstallResult>;
    onInstallProgress(callback: (chunk: string) => void): () => void;
  };
  queue: {
    getState(): Promise<QueueState>;
    enqueue(task: AiTask, tier: AiTier, itemIds: string[], collectionId: string | null): Promise<number>;
    estimate(task: AiTask, tier: AiTier, itemIds: string[], connectorId: string | null): Promise<BatchEstimate>;
    pause(): Promise<QueueState>;
    resume(): Promise<QueueState>;
    cancelAll(): Promise<number>;
    retryFailed(): Promise<number>;
    clearHistory(): Promise<{ success: boolean }>;
    recentJobs(limit?: number): Promise<AiJob[]>;
    jobsForItem(itemId: string): Promise<AiJob[]>;
    getLiveLog(jobId: string): Promise<string | null>;
    onState(callback: (state: QueueState) => void): () => void;
    onCliOutput(callback: (event: CliLogEvent) => void): () => void;
  };
  usage: {
    getReport(): Promise<UsageReport>;
  };
  appraisals: {
    getForItem(itemId: string): Promise<Appraisal[]>;
    delete(id: string): Promise<{ success: boolean }>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(input: UpdateSettingsInput): Promise<AppSettings>;
    encryptionAvailable(): Promise<boolean>;
  };
  dbLocation: {
    get(): Promise<DbLocationInfo>;
    browseExisting(): Promise<string | null>;
    browseNew(): Promise<string | null>;
    set(newPath: string): Promise<{ success: boolean }>;
    resetToDefault(): Promise<{ success: boolean }>;
  };
  mediaLocation: {
    get(): Promise<MediaLocationInfo>;
    browse(): Promise<string | null>;
    set(newPath: string): Promise<{ success: boolean }>;
    resetToDefault(): Promise<{ success: boolean }>;
  };
  shell: {
    openExternal(url: string): Promise<{ success: boolean }>;
    showItemInFolder(targetPath: string): Promise<{ success: boolean }>;
  };
  app: {
    getVersion(): Promise<string>;
  };
  updates: {
    check(): Promise<UpdateCheckResult>;
  };
}

declare global {
  interface Window {
    valutique: ValutiqueApi;
  }
}

export {};
