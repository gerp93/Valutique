import { ReactNode, useEffect, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { CollectionSummary } from '@shared/types/collection';
import { ImportBatch, ImportProgressEvent } from '@shared/types/import';
import './Layout.css';
import logo from '../assets/logo.png';
import QueueBar from './QueueBar';
import CliConsole from './CliConsole';
import { formatMoney } from '../utils/format';

const NAV_ITEMS = [
  { to: '/', label: 'Collections', end: true },
  { to: '/usage', label: 'Cost & Usage' },
  { to: '/connectors', label: 'Connectors' },
  { to: '/logs', label: 'Logs' },
  { to: '/settings', label: 'Settings' },
];

export default function Layout({ children }: { children: ReactNode }) {
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [version, setVersion] = useState('');
  const navigate = useNavigate();
  const params = useParams();

  useEffect(() => {
    void window.valutique.collections.getSummaries().then(setCollections);
    void window.valutique.app.getVersion().then(setVersion);
  }, []);

  // Collection totals shift as appraisals land, so refresh the sidebar
  // whenever the queue reports progress rather than only on navigation.
  useEffect(() => {
    return window.valutique.queue.onState(() => {
      void window.valutique.collections.getSummaries().then(setCollections);
    });
  }, []);

  // Imports run in the main process, so they outlive the page that started
  // them. Tracked here so progress stays visible wherever the user goes.
  const [batches, setBatches] = useState<Record<string, ImportBatch>>({});
  const [progress, setProgress] = useState<ImportProgressEvent | null>(null);

  useEffect(() => {
    const offBatch = window.valutique.import.onBatch((batch) => {
      setBatches((current) => ({ ...current, [batch.collectionId]: batch }));
    });
    const offProgress = window.valutique.import.onProgress(setProgress);
    return () => {
      offBatch();
      offProgress();
    };
  }, []);

  const total = collections.reduce((sum, collection) => sum + collection.estimatedValue, 0);
  const activeBatches = Object.values(batches).filter((batch) => batch.status !== 'failed');

  return (
    <div className="app-root">
      <QueueBar />
      <CliConsole />
      <div className="app-shell">
        <nav className="sidebar">
          <div className="sidebar-title">
            <img src={logo} alt="" className="sidebar-logo" />
            Valutique
          </div>

          <ul>
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} className={({ isActive }) => (isActive ? 'active' : '')}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>

          {collections.length > 0 && (
            <>
              <div className="sidebar-section">Your collections</div>
              {collections.map((collection) => (
                <button
                  key={collection.id}
                  className={`sidebar-collection${params.collectionId === collection.id ? ' active' : ''}`}
                  onClick={() => navigate(`/collections/${collection.id}`)}
                  title={`${collection.itemCount} items`}
                >
                  {collection.name}
                </button>
              ))}
            </>
          )}

          {activeBatches.length > 0 && (
            <div className="sidebar-imports">
              <div className="sidebar-section">Importing</div>
              {activeBatches.map((batch) => {
                const name = collections.find((c) => c.id === batch.collectionId)?.name ?? 'Collection';
                const live = progress && progress.batchId === batch.batchId ? progress : null;
                const ready = batch.status === 'done';
                return (
                  <button
                    key={batch.batchId}
                    className="sidebar-import"
                    onClick={() => navigate(`/collections/${batch.collectionId}`)}
                    title={ready ? 'Ready to review' : live?.message || 'Working…'}
                  >
                    <span className="sidebar-import-name">
                      {!ready && <span className="spinner" aria-hidden="true" />}
                      {name}
                    </span>
                    <span className="sidebar-import-state">
                      {ready
                        ? 'Ready to review'
                        : live?.phase === 'grouping'
                        ? 'Grouping…'
                        : live && live.total > 0
                        ? `${Math.min(live.completed + 1, live.total)} of ${live.total}`
                        : 'Reading…'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="sidebar-footer">
            {collections.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                Estimated total {formatMoney(total)}
              </div>
            )}
            {version && <div>v{version}</div>}
          </div>
        </nav>

        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
