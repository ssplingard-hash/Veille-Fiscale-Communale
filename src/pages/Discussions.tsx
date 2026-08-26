import { useState } from 'react';
import { mockDiscussions } from '../data/news';
import { BellRing, ExternalLink, MapPin } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function Discussions() {
  const navigate = useNavigate();
  const [selectedProvince, setSelectedProvince] = useState<string>('Toutes');
  const provinces = ['Toutes', 'Bruxelles', 'Brabant wallon', 'Hainaut', 'Liège', 'Luxembourg', 'Namur'];
  const [selectedDomaine, setSelectedDomaine] = useState<string>('Tous');
  const domaines = ['Tous', 'Environnement', 'Economie', 'Commerce', 'PME', 'Indépendants', 'Mobilité', 'Professions libérales'];

  const filtered = mockDiscussions.filter(d => (selectedProvince === 'Toutes' || d.province === selectedProvince) && (selectedDomaine === 'Tous' || d.domaine === selectedDomaine));

  return (
    <div className="space-y-8 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-amber-500/20 text-amber-400 rounded-xl">
            <BellRing size={28} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Nouvelles taxes en discussion</h1>
            <p className="text-slate-400 text-sm mt-1">Projets et débats en cours dans les conseils communaux</p>
          </div>
        </div>
        
                <div className="flex gap-3">
          <select
            value={selectedProvince}
            onChange={(e) => setSelectedProvince(e.target.value)}
            className="px-4 py-2 bg-slate-800 border border-slate-700 text-sm font-medium text-white rounded-lg outline-none focus:ring-2 focus:ring-amber-500"
          >
            {provinces.map(p => (
              <option key={p} value={p}>{p === 'Toutes' ? 'Toutes provinces' : p}</option>
            ))}
          </select>

          <select
            value={selectedDomaine}
            onChange={(e) => setSelectedDomaine(e.target.value)}
            className="px-4 py-2 bg-slate-800 border border-slate-700 text-sm font-medium text-white rounded-lg outline-none focus:ring-2 focus:ring-amber-500"
          >
            {domaines.map(d => (
              <option key={d} value={d}>{d === 'Tous' ? 'Toutes matières' : d}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filtered.length === 0 ? (
          <p className="text-slate-500 col-span-full">Aucun projet en cours pour cette province.</p>
        ) : (
          filtered.map((item, idx) => (
            <div key={idx} className="bg-slate-800 rounded-2xl border border-slate-700 p-6 shadow-lg hover:border-amber-500/50 transition-colors flex flex-col">
              <div className="flex items-start justify-between mb-4">
                <span className="px-3 py-1 bg-slate-900 border border-slate-700 rounded-full text-xs font-medium text-slate-300 flex items-center gap-1.5">
                  <span className="px-2 py-0.5 bg-slate-800 rounded text-[10px] uppercase font-bold text-slate-400 mr-2">{item.domaine}</span>
                  <MapPin size={12} className="text-amber-500" />
                  {item.commune}
                </span>
                <span className="text-xs font-semibold text-amber-500 bg-amber-500/10 px-2 py-1 rounded-md">
                  En cours
                </span>
              </div>
              
              <h3 className="text-lg font-bold text-white leading-snug mb-2">{item.titre}</h3>
              <p className="text-sm text-slate-400 mb-6 flex-1">{item.date}</p>
              
              <div className="flex items-center gap-3 mt-auto">
                <button
                  onClick={() => navigate(`/commune/${encodeURIComponent(item.commune)}`)}
                  className="flex-1 py-2 px-4 bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium rounded-xl transition-colors text-center"
                >
                  Voir profil fiscal
                </button>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="p-2 bg-slate-700 hover:bg-amber-600 hover:text-white text-slate-300 rounded-xl transition-colors"
                  title="Voir le PV ou l'Ordre du jour"
                >
                  <ExternalLink size={18} />
                </a>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
