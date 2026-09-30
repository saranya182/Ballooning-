import { useEffect, useMemo, useState } from 'react';
import { Routes, Route, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, FilePlus2, LogOut, CheckCircle2, ClipboardList, FileText, Send } from 'lucide-react';
import api from './services/api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import NewProject from './pages/NewProject';
import DrawingWorkspace from './pages/DrawingWorkspace';
import Approval from './pages/Approval';
import Export from './pages/Export';

const ProtectedRoute = ({ children }) => {
  const token = localStorage.getItem('token');
  if (!token) return <Navigate to="/login" replace />;
  return children;
};

const AppShell = ({ children }) => {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // Drawing workspace header must sit flush against the black
  // top bar, so that page gets no top padding inside <main>.
  const flushTop = /^\/projects\/[^/]+$/.test(pathname);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/login');
  };

  return (
    <div className="h-screen flex flex-col bg-slate-100 overflow-hidden">
      <header className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between shadow sticky top-0 z-50 flex-shrink-0">
        <div>
          <div className="text-lg font-semibold">Manufacturing Drawing Ballooning & Inspection</div>
          <div className="text-sm text-slate-400">Engineering inspection workflow</div>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/dashboard" className="flex items-center gap-2 rounded px-3 py-2 hover:bg-slate-800">
            <LayoutDashboard size={16} /> Dashboard
          </Link>
          <Link to="/new-project" className="flex items-center gap-2 rounded px-3 py-2 hover:bg-slate-800">
            <FilePlus2 size={16} /> New project
          </Link>
          <button onClick={handleLogout} className="flex items-center gap-2 rounded px-3 py-2 hover:bg-slate-800">
            <LogOut size={16} /> Logout
          </button>
        </div>
      </header>
      <main className={`flex-1 overflow-y-auto px-6 pb-6 ${flushTop ? 'pt-0' : 'pt-6'}`}>{children}</main>
    </div>
  );
};

function App() {
  const [user, setUser] = useState(() => JSON.parse(localStorage.getItem('user') || 'null'));
  useEffect(() => {
    api.get('/health').catch(() => {});
  }, []);

  return (
    <Routes>
      <Route path="/login" element={<Login onLogin={setUser} />} />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<ProtectedRoute><AppShell><Dashboard /></AppShell></ProtectedRoute>} />
      <Route path="/new-project" element={<ProtectedRoute><AppShell><NewProject /></AppShell></ProtectedRoute>} />
      <Route path="/projects/:id" element={<ProtectedRoute><AppShell><DrawingWorkspace /></AppShell></ProtectedRoute>} />
      <Route path="/projects/:id/approval" element={<ProtectedRoute><AppShell><Approval /></AppShell></ProtectedRoute>} />
      <Route path="/projects/:id/export" element={<ProtectedRoute><AppShell><Export /></AppShell></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default App;
