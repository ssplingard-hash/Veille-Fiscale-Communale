import { HashRouter as BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import MunicipalityDetail from './pages/MunicipalityDetail';
import Directory from './pages/Directory';
import Discussions from './pages/Discussions';
import Adoptions from './pages/Adoptions';

// Interception globale immédiate
if (typeof window !== 'undefined') {
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const url = String(args[0] || '');
    if (url.includes('api/fiscal-data')) {
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }
    return nativeFetch.apply(this, args);
  };
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="commune/:name" element={<MunicipalityDetail />} />
          <Route path="annuaire" element={<Directory />} />
          <Route path="discussions" element={<Discussions />} />
          <Route path="adoptions" element={<Adoptions />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
