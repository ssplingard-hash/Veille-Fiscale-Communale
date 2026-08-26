import { Outlet, Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Users, Search, Bell, Activity, FileCheck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (search.trim()) {
      navigate(`/commune/${encodeURIComponent(search.trim())}`);
      setSearch('');
    }
  };

  const navItems = [
    { path: '/dashboard', icon: LayoutDashboard, label: 'Tableau de bord' },
    { path: '/discussions', icon: Activity, label: 'Taxes en discussion' },
    { path: '/adoptions', icon: FileCheck, label: 'Règlements adoptés' },
    { path: '/annuaire', icon: Users, label: 'Annuaire' },
  ];

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans flex">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-800 border-r border-slate-700 flex flex-col shrink-0">
        <div className="h-16 flex items-center gap-3 px-6 border-b border-slate-700">
          <div className="w-8 h-8 bg-indigo-500 rounded-lg flex items-center justify-center font-bold text-white">TW</div>
          <h1 className="text-xl font-bold text-slate-100 tracking-tight">TaxWatch</h1>
        </div>
        
        <nav className="flex-1 py-6 px-4 space-y-1">
          {navItems.map((item) => {
            const isActive = location.pathname.startsWith(item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive 
                    ? 'bg-indigo-500/10 text-indigo-400 font-medium border border-indigo-500/20' 
                    : 'text-slate-400 hover:bg-slate-700'
                }`}
              >
                <item.icon size={20} className={isActive ? 'text-indigo-400' : 'text-slate-600'} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-16 bg-slate-800 border-b border-slate-700 flex items-center justify-between px-8 shrink-0">
          <form onSubmit={handleSearch} className="relative w-96">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher une commune (ex: Namur)..."
              className="w-full pl-10 pr-4 py-2 bg-slate-700 border-transparent rounded-full text-slate-100 placeholder-slate-400 focus:bg-slate-600 focus:ring-2 focus:ring-indigo-500 transition-all outline-none text-sm"
            />
          </form>

          <div className="flex items-center gap-4">
            <button className="relative p-2 text-slate-400 hover:text-slate-100 transition-colors">
              <Bell size={20} />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full"></span>
            </button>
            <div className="w-8 h-8 bg-indigo-500 rounded-full flex items-center justify-center text-white font-medium text-sm">
              VF
            </div>
          </div>
        </header>

        {/* Page Content */}
        <div className="flex-1 overflow-auto p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
