import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Collections from './pages/Collections';
import CollectionDetail from './pages/CollectionDetail';
import ItemDetail from './pages/ItemDetail';
import Settings from './pages/Settings';
import Usage from './pages/Usage';
import Logs from './pages/Logs';
import { ThemeProvider } from './context/ThemeContext';
import './themes.css';

function App() {
  return (
    <ThemeProvider>
      <Router>
        <Layout>
          <Routes>
            <Route path="/" element={<Collections />} />
            <Route path="/collections/:collectionId" element={<CollectionDetail />} />
            <Route path="/items/:itemId" element={<ItemDetail />} />
            <Route path="/usage" element={<Usage />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </Router>
    </ThemeProvider>
  );
}

export default App;
