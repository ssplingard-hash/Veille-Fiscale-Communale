import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CommuneFiscalData } from '../types';
import { Loader2, Mail, Phone, ExternalLink, FileText, Activity, MapPin } from 'lucide-react';

export default function MunicipalityDetail() {
  const { name } = useParams<{ name: string }>();
  const [data, setData] = useState<CommuneFiscalData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'VIGUEUR' | 'PROJETS'>('VIGUEUR');

  useEffect(() => {
    if (!name) return;
    const fetchData = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch('/api/fiscal-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ municipality: name }),
        });
        
        if (!response.ok) {
          throw new Error('Erreur lors de la récupération des données');
        }
        
        const result = await response.json();
        setData(result);
      } catch (err: any) {
        setError(err.message || 'Une erreur est survenue');
      } finally {
        setLoading(false);
      }
    };
    
    fetchData();
  }, [name]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] space-y-4">
        <Loader2 className="animate-spin text-indigo-500" size={48} />
        <p className="text-slate-300 font-medium">Recherche en temps réel via l'agent d'IA pour {name}...</p>
        <p className="text-slate-500 text-sm">Analyse des PV, ordres du jour et sites officiels en cours</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 bg-red-500/20 text-red-400 rounded-xl border border-red-500/30">
        <h2 className="font-bold text-lg mb-2">Erreur</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-12">
      {/* Header */}
      <div className="bg-slate-800 rounded-2xl border border-slate-700 p-8 shadow-lg">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-3xl font-extrabold text-white tracking-tight">{data.commune}</h1>
              <span className="px-3 py-1 bg-slate-900 text-slate-400 font-medium rounded-full text-sm flex items-center gap-1.5 border border-slate-700">
                <MapPin size={16} />
                {data.region}
              </span>
            </div>
            <p className="text-slate-400">Profil fiscal complet généré en temps réel.</p>
          </div>
          
          <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-5 min-w-[280px]">
            <h3 className="text-sm font-bold text-indigo-400 uppercase tracking-wider mb-3">Échevin(e) des Finances</h3>
            <p className="font-bold text-white text-lg mb-3">{data.echevin_finances?.nom || 'Non trouvé'}</p>
            <div className="space-y-2 text-sm text-slate-300">
              {data.echevin_finances?.email && (
                <a href={`mailto:${data.echevin_finances.email}`} className="flex items-center gap-2 hover:text-indigo-400 transition-colors">
                  <Mail size={16} className="text-indigo-400" /> {data.echevin_finances.email}
                </a>
              )}
              {data.echevin_finances?.telephone && (
                <p className="flex items-center gap-2">
                  <Phone size={16} className="text-indigo-400" /> {data.echevin_finances.telephone}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Additionnels IPP & PRI */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-slate-800 rounded-2xl border border-slate-700 p-6 shadow-lg flex items-center gap-6">
          <div className="w-16 h-16 rounded-2xl bg-indigo-500/20 flex items-center justify-center shrink-0 border border-indigo-500/30">
            <span className="text-indigo-400 font-bold text-2xl">%</span>
          </div>
          <div>
            <h3 className="text-slate-400 font-medium mb-1">Centimes additionnels IPP</h3>
            <p className="text-3xl font-extrabold text-white">
                            {data.taux_additionnels?.ipp_pourcentage ? `${data.taux_additionnels.ipp_pourcentage}%` : 'N/A'}
            </p>
          </div>
        </div>
        
        <div className="bg-slate-800 rounded-2xl border border-slate-700 p-6 shadow-lg flex items-center gap-6">
          <div className="w-16 h-16 rounded-2xl bg-teal-500/20 flex items-center justify-center shrink-0 border border-teal-500/30">
            <span className="text-teal-400 font-bold text-2xl">¢</span>
          </div>
          <div>
            <h3 className="text-slate-400 font-medium mb-1">Centimes additionnels PRI</h3>
            <p className="text-3xl font-extrabold text-white">
                            {data.taux_additionnels?.pri_centimes ? `${data.taux_additionnels.pri_centimes}` : 'N/A'}
            </p>
          </div>
        </div>
      </div>

      {/* Taxes Tabs */}
      <div className="bg-slate-800 rounded-2xl border border-slate-700 shadow-lg overflow-hidden">
        <div className="flex border-b border-slate-700">
          <button
            onClick={() => setActiveTab('VIGUEUR')}
            className={`flex-1 py-4 px-6 text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${
              activeTab === 'VIGUEUR' 
                ? 'bg-slate-800 text-indigo-400 border-b-2 border-indigo-500' 
                : 'bg-slate-900 text-slate-500 hover:bg-slate-800/80'
            }`}
          >
            <FileText size={18} />
            Règlements en Vigueur ({data.reglements_en_vigueur?.length || 0})
          </button>
          <button
            onClick={() => setActiveTab('PROJETS')}
            className={`flex-1 py-4 px-6 text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${
              activeTab === 'PROJETS' 
                ? 'bg-slate-800 text-indigo-400 border-b-2 border-indigo-500' 
                : 'bg-slate-900 text-slate-500 hover:bg-slate-800/80'
            }`}
          >
            <Activity size={18} />
            Discussions & Projets ({data.discussions_prochaines?.length || 0})
          </button>
        </div>

        <div className="p-6">
          {activeTab === 'VIGUEUR' && (
            <div className="space-y-4">
              {(!data.reglements_en_vigueur || data.reglements_en_vigueur.length === 0) ? (
                <p className="text-slate-500 text-center py-8">Aucun règlement trouvé.</p>
              ) : (
                data.reglements_en_vigueur.map((reg, idx) => (
                  <div key={idx} className="p-5 rounded-xl border border-slate-700 bg-slate-900/50 hover:bg-slate-700/50 transition-colors group">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-2">
                        <div className="flex items-center gap-3">
                          <span className="px-2.5 py-1 bg-emerald-500/20 text-emerald-400 text-xs font-bold rounded-md uppercase tracking-wider">
                            {reg.domaine || 'Non classé'}
                          </span>
                          <span className="text-emerald-500 text-sm font-medium flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-emerald-500"></span> {reg.statut}
                          </span>
                        </div>
                        <h4 className="text-lg font-bold text-white leading-snug">{reg.titre}</h4>
                        <p className="text-slate-300 font-medium text-sm">{reg.taux_description}</p>
                      </div>
                      {reg.url_reglement && (
                        <a 
                          href={reg.url_reglement} 
                          target="_blank" 
                          rel="noreferrer"
                          className="p-3 rounded-full bg-slate-800 border border-slate-700 text-slate-400 hover:text-indigo-400 hover:border-indigo-500/50 transition-colors shrink-0"
                        >
                          <ExternalLink size={20} />
                        </a>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'PROJETS' && (
            <div className="space-y-4">
              {(!data.discussions_prochaines || data.discussions_prochaines.length === 0) ? (
                <p className="text-slate-500 text-center py-8">Aucun projet en discussion trouvé.</p>
              ) : (
                data.discussions_prochaines.map((proj, idx) => (
                  <div key={idx} className="p-5 rounded-xl border border-amber-500/30 bg-amber-900/10 hover:bg-amber-900/30 transition-colors">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-2">
                        <div className="flex items-center gap-3">
                          <span className="px-2.5 py-1 bg-amber-500/20 text-amber-400 text-xs font-bold rounded-md uppercase tracking-wider">
                            {proj.domaine || 'Non classé'}
                          </span>
                          <span className="text-amber-500 text-sm font-medium flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-amber-500"></span> {proj.date_conseil || 'Date inconnue'}
                          </span>
                        </div>
                        <h4 className="text-lg font-bold text-white leading-snug">{proj.titre}</h4>
                        <p className="text-slate-300 text-sm leading-relaxed">{proj.resume}</p>
                      </div>
                      {proj.url_document && (
                        <a 
                          href={proj.url_document} 
                          target="_blank" 
                          rel="noreferrer"
                          className="p-3 rounded-full bg-slate-800 border border-amber-500/30 text-amber-500 hover:bg-amber-500/10 transition-colors shrink-0"
                        >
                          <ExternalLink size={20} />
                        </a>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
