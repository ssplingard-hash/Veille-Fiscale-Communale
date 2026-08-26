import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { municipalities } from '../data/municipalities';
import { mockDiscussions, mockAdoptions } from '../data/news';
import { BellRing, CheckCircle, TrendingUp, Map } from 'lucide-react';
import MapComponent from '../components/MapComponent';

export default function Dashboard() {
  const navigate = useNavigate();
  const [mapType, setMapType] = useState<'IPP' | 'PRI' | 'TAXES'>('IPP');
  const [selectedProvince, setSelectedProvince] = useState<string>('Toutes');

  const provinces = ['Toutes', 'Bruxelles', 'Brabant wallon', 'Hainaut', 'Liège', 'Luxembourg', 'Namur'];

  const filteredMunis = selectedProvince === 'Toutes' 
    ? municipalities 
    : municipalities.filter(m => m.province === selectedProvince);

  

  

  const filteredDiscussions = selectedProvince === 'Toutes' ? mockDiscussions : mockDiscussions.filter(d => d.province === selectedProvince);
  const filteredAdoptions = selectedProvince === 'Toutes' ? mockAdoptions : mockAdoptions.filter(a => a.province === selectedProvince);


  // Simple sort for the visual maps
  const sortedMunis = [...filteredMunis].sort((a, b) => {
    if (mapType === 'IPP') return b.ipp - a.ipp;
    if (mapType === 'PRI') return b.pri - a.pri;
    return b.taxCount - a.taxCount;
  });

  const getHeatmapColor = (index: number, total: number) => {
    // Red (high) to Green (low)
    const ratio = index / (total - 1 || 1);
    // HSL: 0 is Red, 120 is Green
    const hue = ratio * 120;
    return `hsl(${hue}, 70%, 50%)`;
  };

  const getHeatmapBg = (index: number, total: number) => {
    const ratio = index / (total - 1 || 1);
    const hue = ratio * 120;
    return `hsl(${hue}, 30%, 15%)`;
  };

  return (
    <div className="space-y-8 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white tracking-tight">Tableau de bord Fiscale</h1>
      </div>

      {/* Alerts Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-slate-800 rounded-2xl border border-slate-700 p-6 shadow-lg">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-amber-500/20 text-amber-400 rounded-lg">
              <BellRing size={20} />
            </div>
            <h2 className="text-lg font-semibold text-white flex-1">Nouvelles taxes en discussion</h2><button onClick={() => navigate("/discussions")} className="text-sm font-medium text-amber-500 hover:text-amber-400 transition-colors">Voir tout</button>
          </div>
          <ul className="space-y-3">
            {filteredDiscussions.length === 0 ? (
              <li className="text-sm text-slate-500">Aucune nouvelle taxe en discussion pour cette province.</li>
            ) : (
              filteredDiscussions.map((item, idx) => (
                <li key={idx} className="flex items-start gap-3 text-sm">
                  <span className="w-2 h-2 mt-1.5 rounded-full bg-amber-500 shrink-0"></span>
                  <div>
                    <span className="font-medium text-white">{item.commune}</span> - {item.titre}
                    <div className="flex items-center gap-2 mt-0.5"><span className="text-[10px] uppercase font-bold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">{item.domaine}</span><p className="text-slate-400 text-xs">{item.date}</p></div>
                  </div>
                </li>
              ))
            )}
          </ul>
        </div>
        <div className="bg-slate-800 rounded-2xl border border-slate-700 p-6 shadow-lg">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-emerald-500/20 text-emerald-400 rounded-lg">
              <CheckCircle size={20} />
            </div>
            <h2 className="text-lg font-semibold text-white flex-1">Règlements récemment adoptés</h2><button onClick={() => navigate("/adoptions")} className="text-sm font-medium text-emerald-500 hover:text-emerald-400 transition-colors">Voir tout</button>
          </div>
          <ul className="space-y-3">
            {filteredAdoptions.length === 0 ? (
              <li className="text-sm text-slate-500">Aucun règlement récemment adopté pour cette province.</li>
            ) : (
              filteredAdoptions.map((item, idx) => (
                <li key={idx} className="flex items-start gap-3 text-sm">
                  <span className="w-2 h-2 mt-1.5 rounded-full bg-emerald-500 shrink-0"></span>
                  <div>
                    <span className="font-medium text-white">{item.commune}</span> - {item.titre}
                    <div className="flex items-center gap-2 mt-0.5"><span className="text-[10px] uppercase font-bold text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded">{item.domaine}</span><p className="text-slate-400 text-xs">{item.date}</p></div>
                  </div>
                </li>
              ))
            )}
          </ul>
        </div>
      </div>

      {/* Heatmap Section */}
      <div className="bg-slate-800 rounded-2xl border border-slate-700 shadow-lg overflow-hidden">
        <div className="p-6 border-b border-slate-700 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/20 text-indigo-400 rounded-lg">
              <Map size={20} />
            </div>
            <h2 className="text-lg font-semibold text-white">Cartographie Fiscale</h2>
          </div>
          
          <div className="flex flex-col sm:flex-row gap-3">
            <select
              value={selectedProvince}
              onChange={(e) => setSelectedProvince(e.target.value)}
              className="px-3 py-1.5 bg-slate-900 border border-slate-700 text-sm font-medium text-white rounded-md outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {provinces.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <div className="flex p-1 bg-slate-900 rounded-lg shrink-0">
              <button
                onClick={() => setMapType('IPP')}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${mapType === 'IPP' ? 'bg-slate-700 shadow-sm text-white' : 'text-slate-400 hover:text-white'}`}
              >
                IPP
              </button>
              <button
                onClick={() => setMapType('PRI')}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${mapType === 'PRI' ? 'bg-slate-700 shadow-sm text-white' : 'text-slate-400 hover:text-white'}`}
              >
                PRI
              </button>
              <button
                onClick={() => setMapType('TAXES')}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${mapType === 'TAXES' ? 'bg-slate-700 shadow-sm text-white' : 'text-slate-400 hover:text-white'}`}
              >
                Volume Taxes
              </button>
            </div>
          </div>
        </div>
        
        <div className="p-6">
          <div className="flex items-center justify-between mb-6 text-sm font-medium text-slate-400">
            <span>Plus taxateur (Rouge)</span>
            <div className="h-2 w-64 rounded-full bg-gradient-to-r from-red-500 via-yellow-400 to-green-500"></div>
            <span>Moins taxateur (Vert)</span>
          </div>
          
          {/* Geographical Map */}
          <div className="mb-10">
            <MapComponent mapType={mapType} selectedProvince={selectedProvince} />
          </div>

          <h3 className="text-md font-bold text-white mb-4">Top 10 - Les Plus Taxatrices ({selectedProvince})</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {sortedMunis.slice(0, 10).map((muni, index) => {
              const color = getHeatmapColor(index, sortedMunis.length);
              const bgColor = getHeatmapBg(index, sortedMunis.length);
              return (
                <button
                  key={muni.name}
                  onClick={() => navigate(`/commune/${encodeURIComponent(muni.name)}`)}
                  className="flex flex-col p-4 rounded-xl border border-transparent transition-all hover:scale-105 hover:shadow-md text-left"
                  style={{ backgroundColor: bgColor, borderColor: color }}
                >
                  <span className="font-semibold text-white mb-1 line-clamp-1 text-sm">{muni.name}</span>
                  <span className="text-xs font-medium" style={{ color }}>
                    {mapType === 'IPP' && `${muni.ipp}%`}
                    {mapType === 'PRI' && `${muni.pri} centimes`}
                    {mapType === 'TAXES' && `${muni.taxCount} règlements`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
