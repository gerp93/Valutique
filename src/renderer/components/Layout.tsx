import { ReactNode, useEffect, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { CollectionSummary } from '@shared/types/collection';
import './Layout.css';
import logo from '../assets/logo.png';
import QueueBar from './QueueBar';
import CliConsole from './CliConsole';
import { formatMoney } from '../utils/format';

const NAV_ITEMS = [
  { to: '/', label: 'Collections', end: true },
  { to: '/usage', label: 'Cost & Usage' },
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

  const total = collections.reduce((sum, collection) => sum + collection.estimatedValue, 0);

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
