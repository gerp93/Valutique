import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as dns from 'dns';
import * as path from 'path';
import { Database } from 'sql.js';

// Node 17+ resolves `localhost` to IPv6 ::1 before IPv4, but local inference
// servers -- Ollama especially -- bind only to 127.0.0.1. The result is an
// instant ECONNREFUSED against a server that is plainly running, because a
// browser quietly falls back to IPv4 and Node does not. Preferring IPv4 makes
// the app behave the way the user's browser already does.
dns.setDefaultResultOrder('ipv4first');

import { initDatabase, saveDatabase } from './database/schema';
import { CollectionService } from './database/collectionService';
import { FieldDefService } from './database/fieldDefService';
import { PhotoService } from './database/photoService';
import { AppraisalService } from './database/appraisalService';
import { ItemService } from './database/itemService';
import { ConnectorService } from './database/connectorService';
import { JobService } from './database/jobService';
import { SettingsService } from './database/settingsService';
import { UsageService } from './database/usageService';

import { ProviderRegistry } from './ai/registry';
import { AiTasks } from './ai/tasks';
import { JobRunner } from './ai/jobRunner';
import { BatchEstimator } from './ai/batchEstimator';
import { ImportService } from './import/importService';
import { DuplicateDetector } from './duplicates';

import * as photoStore from './photoStore';
import { detectCli, detectEnvironment, installCli, listRemoteModels } from './cliDetect';
import {
  getDefaultDbPath,
  getEffectiveDbPath,
  isUsingDefaultLocation,
  resetToDefaultDbPath,
  setDbPath,
} from './dbLocation';
import { isEncryptionAvailable } from './secrets';

import { CreateCollectionInput, UpdateCollectionInput } from '../shared/types/collection';
import { CreateFieldDefInput, UpdateFieldDefInput } from '../shared/types/fieldDef';
import { CreateItemInput, ItemFilter, UpdateItemInput } from '../shared/types/item';
import { AiTask, AiTier, CreateConnectorInput, UpdateConnectorInput } from '../shared/types/connector';
import { ImportAnalysis, ImportPlan } from '../shared/types/import';
import { AddPhotosResult, Photo } from '../shared/types/photo';
import { UpdateSettingsInput, UpdateCheckResult } from '../shared/types/settings';

// Packaged builds resolve app.getPath('userData') from build.productName
// ("Valutique"), while `electron .` in dev resolves it from package.json's
// "name" ("valutique") -- pin it so both modes always read/write the same data
// folder instead of silently diverging.
app.setName('valutique');

// Must run before app ready for the scheme to count as standard and secure.
photoStore.registerPhotoProtocolScheme();

let mainWindow: BrowserWindow | null = null;
let db: Database | null = null;

let collections: CollectionService;
let fieldDefs: FieldDefService;
let photos: PhotoService;
let appraisals: AppraisalService;
let items: ItemService;
let connectors: ConnectorService;
let jobs: JobService;
let settings: SettingsService;
let usage: UsageService;
let tasks: AiTasks;
let runner: JobRunner;
let estimator: BatchEstimator;
let importer: ImportService;
let duplicates: DuplicateDetector;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    icon: path.join(__dirname, '../../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: 'default',
    backgroundColor: '#16202C',
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  db = await initDatabase();

  collections = new CollectionService(db);
  fieldDefs = new FieldDefService(db);
  photos = new PhotoService(db);
  appraisals = new AppraisalService(db);
  items = new ItemService(db, fieldDefs, photos, appraisals);
  connectors = new ConnectorService(db);
  jobs = new JobService(db);
  settings = new SettingsService(db);
  usage = new UsageService(db, connectors);

  const registry = new ProviderRegistry((connectorId) => connectors.getApiKey(connectorId));
  tasks = new AiTasks(collections, fieldDefs, items, photos, appraisals, settings, registry);
  estimator = new BatchEstimator(connectors, jobs, photos, settings);
  duplicates = new DuplicateDetector(items);
  importer = new ImportService(collections, items, photos, settings, connectors, jobs, tasks);

  runner = new JobRunner(
    jobs,
    connectors,
    items,
    settings,
    tasks,
    (itemId) => {
      // Surfaced as a prompt rather than acted on: merging is the user's call,
      // and a false positive that auto-merged two real items would be far worse
      // than one they dismiss.
      const item = items.getById(itemId);
      if (!item) return;
      const suggestion = duplicates.findFor(itemId, item.collectionId);
      if (suggestion) {
        mainWindow?.webContents.send('duplicates:suggested', suggestion);
      }
    },
    (event) => {
      mainWindow?.webContents.send('queue:cliOutput', event);
    }
  );

  runner.onStateChange((state) => {
    mainWindow?.webContents.send('queue:state', state);
  });

  photoStore.registerPhotoProtocol();
  registerIpcHandlers();

  createWindow();
  runner.start();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  runner?.stop();
  if (db) saveDatabase(db);
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// --- auto-update -----------------------------------------------------------

function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    dialog
      .showMessageBox(mainWindow!, {
        type: 'info',
        title: 'Update ready',
        message: `Valutique ${info.version} has been downloaded.`,
        detail: 'Restart now to install it, or it will install automatically the next time you quit.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Failed to check for updates:', err);
  });
}

function checkForUpdatesNow(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) return Promise.resolve({ status: 'unsupported' });

  return new Promise((resolve) => {
    const cleanup = () => {
      autoUpdater.removeListener('update-available', onAvailable);
      autoUpdater.removeListener('update-not-available', onNotAvailable);
      autoUpdater.removeListener('error', onError);
    };
    const onAvailable = (info: { version: string }) => {
      cleanup();
      resolve({ status: 'available', version: info.version });
    };
    const onNotAvailable = () => {
      cleanup();
      resolve({ status: 'not-available' });
    };
    const onError = (err: Error) => {
      cleanup();
      const message = err?.message ?? String(err);
      // A CI release job uploads the installer before it generates the update
      // manifest, so a check landing in that gap 404s even though the release
      // itself is live.
      resolve({
        status: 'error',
        message: message.includes('Cannot find latest')
          ? 'A new version may still be uploading — try again in a few minutes.'
          : message,
      });
    };

    autoUpdater.once('update-available', onAvailable);
    autoUpdater.once('update-not-available', onNotAvailable);
    autoUpdater.once('error', onError);
    autoUpdater.checkForUpdates().catch(onError);
  });
}

// --- IPC -------------------------------------------------------------------

function registerIpcHandlers() {
  // Collections
  ipcMain.handle('collections:getAll', () => collections.getAll());
  ipcMain.handle('collections:getSummaries', () => collections.getSummaries());
  ipcMain.handle('collections:getById', (_, id: string) => collections.getById(id));
  ipcMain.handle('collections:create', (_, input: CreateCollectionInput) => collections.create(input));
  ipcMain.handle('collections:update', (_, id: string, input: UpdateCollectionInput) => collections.update(id, input));
  ipcMain.handle('collections:delete', (_, id: string) => {
    collections.delete(id);
    return { success: true };
  });

  // Custom fields
  ipcMain.handle('fields:getForCollection', (_, collectionId: string) => fieldDefs.getForCollection(collectionId));
  ipcMain.handle('fields:create', (_, input: CreateFieldDefInput) => fieldDefs.create(input));
  ipcMain.handle('fields:createMany', (_, inputs: CreateFieldDefInput[]) => fieldDefs.createMany(inputs));
  ipcMain.handle('fields:update', (_, id: string, input: UpdateFieldDefInput) => fieldDefs.update(id, input));
  ipcMain.handle('fields:delete', (_, id: string) => {
    fieldDefs.delete(id);
    return { success: true };
  });
  ipcMain.handle('fields:reorder', (_, collectionId: string, orderedIds: string[]) =>
    fieldDefs.reorder(collectionId, orderedIds)
  );
  ipcMain.handle('fields:suggest', async (_, name: string, description: string) => {
    const connector = connectors.resolveConnector('suggest_fields');
    if (!connector) {
      throw new Error('No connector is bound to the "Suggest custom fields" task. Set one up in Settings.');
    }
    const { fields } = await tasks.suggestFields(name, description, connector);
    return fields;
  });

  // Items
  ipcMain.handle('items:list', (_, filter: ItemFilter) => items.list(filter));
  ipcMain.handle('items:getDetail', (_, id: string) => items.getDetail(id));
  ipcMain.handle('items:create', (_, input: CreateItemInput) => items.create(input));
  ipcMain.handle('items:update', (_, id: string, input: UpdateItemInput) => items.update(id, input));
  ipcMain.handle('items:delete', (_, id: string) => {
    items.delete(id);
    return { success: true };
  });
  ipcMain.handle('items:setFieldValues', (_, itemId: string, values: Record<string, unknown>) =>
    items.setFieldValuesByKey(itemId, values, { fromAi: false })
  );
  ipcMain.handle('items:clearAiNotes', (_, itemId: string) => items.setAiNotes(itemId, null));
  ipcMain.handle('items:merge', (_, sourceIds: string[], targetId: string) => items.merge(sourceIds, targetId));
  ipcMain.handle('items:splitPhoto', (_, photoId: string) => items.splitPhotoToNewItem(photoId));
  ipcMain.handle('items:locations', (_, collectionId: string) => items.distinctLocations(collectionId));

  // Photos
  ipcMain.handle('photos:getForItem', (_, itemId: string) => photos.getForItem(itemId));
  ipcMain.handle('photos:setPrimary', (_, photoId: string) => {
    photos.setPrimary(photoId);
    return { success: true };
  });
  ipcMain.handle('photos:move', (_, photoId: string, targetItemId: string) => photos.moveToItem(photoId, targetItemId));
  ipcMain.handle('photos:delete', (_, photoId: string) => {
    photos.delete(photoId);
    return { success: true };
  });
  ipcMain.handle('photos:url', (_, relativePath: string) => photoStore.photoUrl(relativePath));

  // Adds photos straight to a known item. Deliberately not routed through
  // ImportService: that pipeline exists to work out which photos belong to
  // which item, a question that's already answered here -- the user opened
  // this exact item and is dropping more angles of the same physical thing.
  ipcMain.handle('photos:addToItem', (_, itemId: string, filePaths: string[]): AddPhotosResult => {
    const added: Photo[] = [];
    const failed: { fileName: string; error: string }[] = [];

    for (const filePath of filePaths) {
      const fileName = path.basename(filePath);
      if (!photoStore.isSupportedImage(filePath)) {
        failed.push({ fileName, error: 'Not a supported image type.' });
        continue;
      }
      try {
        const ingested = photoStore.ingest(filePath);
        added.push(photos.addToItem(itemId, ingested, fileName));
      } catch (err) {
        // One unreadable file in the batch shouldn't drop the rest, but the
        // failure needs to reach the user -- silently dropping it here is
        // indistinguishable from the button just not working.
        console.error(`Failed to add photo "${filePath}":`, err);
        failed.push({ fileName, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { added, failed };
  });

  // Import
  ipcMain.handle('import:pickFiles', async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add photos',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('import:pickFolder', async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add every photo in a folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return [];

    const fs = await import('fs');
    const folder = result.filePaths[0];
    return fs
      .readdirSync(folder)
      .map((name) => path.join(folder, name))
      .filter((filePath) => photoStore.isSupportedImage(filePath));
  });
  ipcMain.handle('import:analyze', (_, collectionId: string, filePaths: string[], useAi: boolean) =>
    importer.analyze(collectionId, filePaths, { useAi })
  );
  ipcMain.handle('import:commit', (_, analysis: ImportAnalysis, plan: ImportPlan) => importer.commit(analysis, plan));

  // Duplicates
  ipcMain.handle('duplicates:findAll', (_, collectionId: string) => duplicates.findAll(collectionId));

  // Connectors
  ipcMain.handle('connectors:getAll', () => connectors.getAll());
  ipcMain.handle('connectors:create', (_, input: CreateConnectorInput) => {
    const created = connectors.create(input);
    // A first connector should make the app usable immediately rather than
    // requiring a separate trip to the task-bindings screen.
    connectors.bindUnboundTasksTo(created.id);
    return created;
  });
  ipcMain.handle('connectors:update', (_, id: string, input: UpdateConnectorInput) => connectors.update(id, input));
  ipcMain.handle('connectors:delete', (_, id: string) => {
    connectors.delete(id);
    return { success: true };
  });
  ipcMain.handle('connectors:test', async (_, id: string) => {
    const connector = connectors.getById(id);
    if (!connector) throw new Error('Connector not found.');
    const registry = new ProviderRegistry((connectorId) => connectors.getApiKey(connectorId));
    return registry.for(connector).test(connector);
  });
  // CLI availability. Probed before the picker offers a CLI connector, so a
  // missing command is caught at setup rather than as a confusing ENOENT on the
  // first job of a 300-item batch.
  ipcMain.handle('cli:detect', () => detectEnvironment());
  ipcMain.handle('cli:probe', (_, command: string) => detectCli(command));

  // Lets the model field be a picker for local servers, whose model list can't
  // be known ahead of time but can simply be asked for.
  ipcMain.handle('connectors:listModels', (_, baseUrl: string, connectorId: string | null) =>
    listRemoteModels(baseUrl, connectorId ? connectors.getApiKey(connectorId) : null)
  );
  ipcMain.handle('cli:install', (event, provider: string) =>
    installCli(provider, (chunk) => {
      // npm is chatty and slow; streaming it means the button doesn't look hung.
      event.sender.send('cli:installProgress', chunk);
    })
  );

  ipcMain.handle('connectors:getBindings', () => connectors.getBindings());
  ipcMain.handle('connectors:setBinding', (_, task: AiTask, tier: AiTier, connectorId: string | null) =>
    connectors.setBinding(task, tier, connectorId)
  );

  // Queue
  ipcMain.handle('queue:getState', () => runner.getState());
  ipcMain.handle(
    'queue:enqueue',
    (_, task: AiTask, tier: AiTier, itemIds: string[], collectionId: string | null) => {
      const connector = connectors.resolveConnector(task, tier);
      const created = jobs.enqueueMany(task, tier, itemIds, collectionId, connector?.id ?? null);
      for (const id of itemIds) items.setAiStatus(id, 'queued');
      return created.length;
    }
  );
  ipcMain.handle(
    'queue:estimate',
    (_, task: AiTask, tier: AiTier, itemIds: string[], connectorId: string | null) =>
      estimator.estimate(task, tier, itemIds, connectorId)
  );
  ipcMain.handle('queue:pause', () => {
    runner.pause();
    return runner.getState();
  });
  ipcMain.handle('queue:resume', () => {
    runner.resume();
    return runner.getState();
  });
  ipcMain.handle('queue:cancelAll', () => runner.cancelAll());
  ipcMain.handle('queue:retryFailed', () => jobs.requeueFailed());
  ipcMain.handle('queue:clearHistory', () => {
    jobs.clearHistory();
    return { success: true };
  });
  ipcMain.handle('queue:recentJobs', (_, limit: number) => jobs.getRecent(limit));
  ipcMain.handle('queue:jobsForItem', (_, itemId: string) => jobs.getForItem(itemId));
  ipcMain.handle('queue:getLiveLog', (_, jobId: string) => runner.getLiveLog(jobId));

  // Usage and cost
  ipcMain.handle('usage:getReport', () => usage.getReport());

  // Appraisals
  ipcMain.handle('appraisals:getForItem', (_, itemId: string) => appraisals.getForItem(itemId));
  ipcMain.handle('appraisals:delete', (_, id: string) => {
    appraisals.delete(id);
    return { success: true };
  });

  // Settings
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:update', (_, input: UpdateSettingsInput) => settings.update(input));
  ipcMain.handle('settings:encryptionAvailable', () => isEncryptionAvailable());

  // Database location
  ipcMain.handle('dbLocation:get', () => ({
    path: getEffectiveDbPath(),
    isDefault: isUsingDefaultLocation(),
    defaultPath: getDefaultDbPath(),
  }));
  ipcMain.handle('dbLocation:browseExisting', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an existing Valutique database file',
      properties: ['openFile'],
      filters: [{ name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dbLocation:browseNew', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Choose where to store the Valutique database',
      defaultPath: 'valutique.db',
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    });
    return result.canceled ? null : result.filePath ?? null;
  });
  ipcMain.handle('dbLocation:set', (_, newPath: string) => {
    if (db) saveDatabase(db);
    setDbPath(newPath);
    // An open sql.js database cannot be repointed at a new file, so a restart
    // is the honest way to adopt one.
    app.relaunch();
    app.exit();
    return { success: true };
  });
  ipcMain.handle('dbLocation:resetToDefault', () => {
    if (db) saveDatabase(db);
    resetToDefaultDbPath();
    app.relaunch();
    app.exit();
    return { success: true };
  });

  // Media library location
  ipcMain.handle('mediaLocation:get', () => ({
    path: photoStore.getEffectiveMediaPath(),
    isDefault: photoStore.isUsingDefaultMediaLocation(),
    defaultPath: photoStore.getDefaultMediaPath(),
    ...photoStore.libraryStats(),
  }));
  ipcMain.handle('mediaLocation:browse', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose where to store your photos',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('mediaLocation:set', (_, newPath: string) => {
    photoStore.setMediaPath(newPath);
    return { success: true };
  });
  ipcMain.handle('mediaLocation:resetToDefault', () => {
    photoStore.resetToDefaultMediaPath();
    return { success: true };
  });

  // Shell
  ipcMain.handle('shell:openExternal', (_, url: string) => {
    // Only ever open real web links -- these URLs come from model output.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { success: true };
  });
  ipcMain.handle('shell:showItemInFolder', (_, targetPath: string) => {
    shell.showItemInFolder(targetPath);
    return { success: true };
  });

  // App / updates
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('updates:check', () => checkForUpdatesNow());
}
