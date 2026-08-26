import { useState } from 'react';
import { municipalities } from '../data/municipalities';
import { Mail, Phone, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function Directory() {
  const [filter, setFilter] = useState('');
  const navigate = useNavigate();

  const filtered = municipalities.filter(m => m.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white tracking-tight">Annuaire des Échevins des Finances</h1>
        <input
          type="text"
          placeholder="Filtrer par commune..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="px-4 py-2 bg-slate-800 border border-slate-700 text-white placeholder-slate-400 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none w-72"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filtered.map(muni => (
          <div key={muni.name} className="bg-slate-800 rounded-2xl border border-slate-700 p-6 shadow-lg flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-white cursor-pointer hover:text-indigo-400 transition-colors" onClick={() => navigate(`/commune/${encodeURIComponent(muni.name)}`)}>
                {muni.name}
              </h2>
              <span className="px-2.5 py-1 bg-slate-900 text-slate-400 text-xs font-medium rounded-md border border-slate-700">
                {muni.region}
              </span>
            </div>
            
            <div className="flex items-start gap-4 flex-1">
              <div className="p-3 bg-indigo-500/20 text-indigo-400 rounded-full">
                <User size={24} />
              </div>
              <div className="space-y-2 flex-1">
                <p className="font-medium text-white">Échevin(e) en charge</p>
                {/* Note: This is simulated data until the live lookup is done */}
                <a href="#" className="flex items-center gap-2 text-sm text-slate-400 hover:text-indigo-400 transition-colors">
                  <Mail size={16} />
                  finances@{muni.name.toLowerCase().replace(/[^a-z0-9]/g, '')}.be
                </a>
                <p className="flex items-center gap-2 text-sm text-slate-400">
                  <Phone size={16} />
                  02 / xxx xx xx
                </p>
              </div>
            </div>
            
            <button 
              onClick={() => navigate(`/commune/${encodeURIComponent(muni.name)}`)}
              className="mt-6 w-full py-2 bg-slate-700 hover:bg-slate-600 text-white font-medium rounded-lg transition-colors border border-transparent"
            >
              Voir le profil fiscal
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
