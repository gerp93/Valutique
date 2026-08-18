import { contextBridge, ipcRenderer } from 'electron';
import { CreateCollectionInput, UpdateCollectionInput } from '../shared/types/collection';
import { CreateFieldDefInput, UpdateFieldDefInput } from '../shared/types/fieldDef';
import { CreateItemInput, ItemFilter, UpdateItemInput } from '../shared/types/item';
import { AiTask, CreateConnectorInput, UpdateConnectorInput } from '../shared/types/connector';
import { ImportAnalysis, ImportPlan } from '../shared/types/import';
import { UpdateSettingsInput } from '../shared/types/settings';
import { CliLogEvent, QueueState } from '../shared/types/job';
import { DuplicateSuggestion } from './duplicates';

/**
 * The renderer's entire view of the main process.
 *
 * Nothing here can read a credential: API keys and eBay secrets live in the OS
 * keychain and are only ever touched inside the job runner. The renderer can
 * ask whether a key exists, never what it is.
 */
contextBridge.exposeInMainWorld('valutique', {
  collections: {
    getAll: () => ipcRenderer.invoke('collections:getAll'),
    getSummaries: () => ipcRenderer.invoke('collections:getSummaries'),
    getById: (id: string) => ipcRenderer.invoke('collections:getById', id),
    create: (input: CreateCollectionInput) => ipcRenderer.invoke('collections:create', input),
    update: (id: string, input: UpdateCollectionInput) => ipcRenderer.invoke('collections:update', id, input),
    delete: (id: string) => ipcRenderer.invoke('collections:delete', id),
  },

  fields: {
    getForCollection: (collectionId: string) => ipcRenderer.invoke('fields:getForCollection', collectionId),
    create: (input: CreateFieldDefInput) => ipcRenderer.invoke('fields:create', input),
    createMany: (inputs: CreateFieldDefInput[]) => ipcRenderer.invoke('fields:createMany', inputs),
    update: (id: string, input: UpdateFieldDefInput) => ipcRenderer.invoke('fields:update', id, input),
    delete: (id: string) => ipcRenderer.invoke('fields:delete', id),
    reorder: (collectionId: string, orderedIds: string[]) =>
      ipcRenderer.invoke('fields:reorder', collectionId, orderedIds),
    suggest: (name: string, description: string) => ipcRenderer.invoke('fields:suggest', name, description),
  },

  items: {
    list: (filter: ItemFilter) => ipcRenderer.invoke('items:list', filter),
    getDetail: (id: string) => ipcRenderer.invoke('items:getDetail', id),
    create: (input: CreateItemInput) => ipcRenderer.invoke('items:create', input),
    update: (id: string, input: UpdateItemInput) => ipcRenderer.invoke('items:update', id, input),
    delete: (id: string) => ipcRenderer.invoke('items:delete', id),
    setFieldValues: (itemId: string, values: Record<string, unknown>) =>
      ipcRenderer.invoke('items:setFieldValues', itemId, values),
    clearAiNotes: (itemId: string) => ipcRenderer.invoke('items:clearAiNotes', itemId),
    merge: (sourceIds: string[], targetId: string) => ipcRenderer.invoke('items:merge', sourceIds, targetId),
    splitPhoto: (photoId: string) => ipcRenderer.invoke('items:splitPhoto', photoId),
    locations: (collectionId: string) => ipcRenderer.invoke('items:locations', collectionId),
  },

  photos: {
    getForItem: (itemId: string) => ipcRenderer.invoke('photos:getForItem', itemId),
    setPrimary: (photoId: string) => ipcRenderer.invoke('photos:setPrimary', photoId),
    move: (photoId: string, targetItemId: string) => ipcRenderer.invoke('photos:move', photoId, targetItemId),
    delete: (photoId: string) => ipcRenderer.invoke('photos:delete', photoId),
    url: (relativePath: string) => ipcRenderer.invoke('photos:url', relativePath),
    addToItem: (itemId: string, filePaths: string[]) => ipcRenderer.invoke('photos:addToItem', itemId, filePaths),
  },

  import: {
    pickFiles: () => ipcRenderer.invoke('import:pickFiles'),
    pickFolder: () => ipcRenderer.invoke('import:pickFolder'),
    analyze: (collectionId: string, filePaths: string[], useAi: boolean) =>
      ipcRenderer.invoke('import:analyze', collectionId, filePaths, useAi),
    commit: (analysis: ImportAnalysis, plan: ImportPlan) => ipcRenderer.invoke('import:commit', analysis, plan),
  },

  duplicates: {
    findAll: (collectionId: string) => ipcRenderer.invoke('duplicates:findAll', collectionId),
    onSuggested: (callback: (suggestion: DuplicateSuggestion) => void) => {
      const handler = (_: unknown, suggestion: DuplicateSuggestion) => callback(suggestion);
      ipcRenderer.on('duplicates:suggested', handler);
      return () => ipcRenderer.removeListener('duplicates:suggested', handler);
    },
  },

  connectors: {
    getAll: () => ipcRenderer.invoke('connectors:getAll'),
    create: (input: CreateConnectorInput) => ipcRenderer.invoke('connectors:create', input),
    update: (id: string, input: UpdateConnectorInput) => ipcRenderer.invoke('connectors:update', id, input),
    delete: (id: string) => ipcRenderer.invoke('connectors:delete', id),
    test: (id: string) => ipcRenderer.invoke('connectors:test', id),
    listModels: (baseUrl: string, connectorId: string | null) =>
      ipcRenderer.invoke('connectors:listModels', baseUrl, connectorId),
    getBindings: () => ipcRenderer.invoke('connectors:getBindings'),
    setBinding: (task: AiTask, connectorId: string | null) =>
      ipcRenderer.invoke('connectors:setBinding', task, connectorId),
  },

  cli: {
    detect: () => ipcRenderer.invoke('cli:detect'),
    probe: (command: string) => ipcRenderer.invoke('cli:probe', command),
    install: (provider: string) => ipcRenderer.invoke('cli:install', provider),
    onInstallProgress: (callback: (chunk: string) => void) => {
      const handler = (_: unknown, chunk: string) => callback(chunk);
      ipcRenderer.on('cli:installProgress', handler);
      return () => ipcRenderer.removeListener('cli:installProgress', handler);
    },
  },

  queue: {
    getState: () => ipcRenderer.invoke('queue:getState'),
    enqueue: (task: AiTask, itemIds: string[], collectionId: string | null) =>
      ipcRenderer.invoke('queue:enqueue', task, itemIds, collectionId),
    estimate: (task: AiTask, itemIds: string[], connectorId: string | null) =>
      ipcRenderer.invoke('queue:estimate', task, itemIds, connectorId),
    pause: () => ipcRenderer.invoke('queue:pause'),
    resume: () => ipcRenderer.invoke('queue:resume'),
    cancelAll: () => ipcRenderer.invoke('queue:cancelAll'),
    retryFailed: () => ipcRenderer.invoke('queue:retryFailed'),
    clearHistory: () => ipcRenderer.invoke('queue:clearHistory'),
    recentJobs: (limit = 50) => ipcRenderer.invoke('queue:recentJobs', limit),
    jobsForItem: (itemId: string) => ipcRenderer.invoke('queue:jobsForItem', itemId),
    getLiveLog: (jobId: string) => ipcRenderer.invoke('queue:getLiveLog', jobId),
    onState: (callback: (state: QueueState) => void) => {
      const handler = (_: unknown, state: QueueState) => callback(state);
      ipcRenderer.on('queue:state', handler);
      return () => ipcRenderer.removeListener('queue:state', handler);
    },
    onCliOutput: (callback: (event: CliLogEvent) => void) => {
      const handler = (_: unknown, event: CliLogEvent) => callback(event);
      ipcRenderer.on('queue:cliOutput', handler);
      return () => ipcRenderer.removeListener('queue:cliOutput', handler);
    },
  },

  usage: {
    getReport: () => ipcRenderer.invoke('usage:getReport'),
  },

  appraisals: {
    getForItem: (itemId: string) => ipcRenderer.invoke('appraisals:getForItem', itemId),
    delete: (id: string) => ipcRenderer.invoke('appraisals:delete', id),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (input: UpdateSettingsInput) => ipcRenderer.invoke('settings:update', input),
    encryptionAvailable: () => ipcRenderer.invoke('settings:encryptionAvailable'),
  },

  dbLocation: {
    get: () => ipcRenderer.invoke('dbLocation:get'),
    browseExisting: () => ipcRenderer.invoke('dbLocation:browseExisting'),
    browseNew: () => ipcRenderer.invoke('dbLocation:browseNew'),
    set: (newPath: string) => ipcRenderer.invoke('dbLocation:set', newPath),
    resetToDefault: () => ipcRenderer.invoke('dbLocation:resetToDefault'),
  },

  mediaLocation: {
    get: () => ipcRenderer.invoke('mediaLocation:get'),
    browse: () => ipcRenderer.invoke('mediaLocation:browse'),
    set: (newPath: string) => ipcRenderer.invoke('mediaLocation:set', newPath),
    resetToDefault: () => ipcRenderer.invoke('mediaLocation:resetToDefault'),
  },

  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    showItemInFolder: (targetPath: string) => ipcRenderer.invoke('shell:showItemInFolder', targetPath),
  },

  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
  },

  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
  },
});
