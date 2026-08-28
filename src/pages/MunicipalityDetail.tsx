import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { municipalities } from '../data/municipalities';
import { Loader2, ExternalLink, FileText, Calendar, ScrollText, MapPin } from 'lucide-react';

interface TaxRegulation {
  title: string;
  url: string;
}

interface CommuneDailyData {
  activeRegulationsCount: number;
  regulations: TaxRegulation[];
  upcomingAgendaTaxes: TaxRegulation[];
}

export default function MunicipalityDetail() {
  const { name } = useParams<{ name: string }>();
  const [data, setData] = useState<any | null>(null);
  const [dailyData, setDailyData] = useState<CommuneDailyData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    if (!name) return;

    const found = municipalities.find(
      (m) =>
        decodeURIComponent(m.name).toLowerCase().replace(/[- ]/g, '') ===
        decodeURIComponent(name || '').toLowerCase().replace(/[- ]/g, '')
    );

    if (found) {
      setData(found);
      
      // Chargement des données quotidiennes extraites par le script
      fetch('/data/daily_taxes.json')
        .then((res) => res.json())
        .then((json) => {
          if (json[found.name]) {
            setDailyData(json[found.name]);
          }
        })
        .catch(() => console.log('Pas de données quotidiennes disponibles'));
    }
    setLoading(false);
  }, [name]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 bg-red-900/20 border border-red-500/30 rounded-xl text-red-400">
        Commune introuvable.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 backdrop-blur-sm">
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <MapPin className="w-8 h-8 text-blue-400" />
          {data.name}
        </h1>
        <p className="text-slate-400 mt-1">
          Province de {data.province} • Région {data.region}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
          <span className="text-sm font-medium text-slate-400">Additionnels IPP (2026)</span>
          <div className="text-3xl font-bold text-white mt-2">{data.ipp}%</div>
        </div>

        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
          <span className="text-sm font-medium text-slate-400">Additionnels PRI (2026)</span>
          <div className="text-3xl font-bold text-emerald-400 mt-2">{data.pri}</div>
        </div>

        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
          <span className="text-sm font-medium text-slate-400">Règlements-Taxes Actifs</span>
          <div className="text-3xl font-bold text-blue-400 mt-2">
            {dailyData ? dailyData.activeRegulationsCount : 'En cours...'}
          </div>
        </div>
      </div>

      {/* Liste complète des règlements-taxes en vigueur */}
      <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 space-y-4">
        <h2 className="text-xl font-semibold text-white flex items-center gap-2">
          <ScrollText className="w-5 h-5 text-emerald-400" />
          Règlements-taxes en vigueur
        </h2>
        
        {dailyData && dailyData.regulations.length > 0 ? (
          <div className="grid grid-cols-1 gap-3">
            {dailyData.regulations.map((reg, idx) => (
              <a
                key={idx}
                href={reg.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-3 bg-slate-900/60 hover:bg-slate-700/50 border border-slate-700/40 rounded-lg text-slate-200 text-sm transition-colors"
              >
                <span>{reg.title}</span>
                <ExternalLink className="w-4 h-4 text-slate-400" />
              </a>
            ))}
          </div>
        ) : (
          <p className="text-slate-400 text-sm">Aucun règlement spécifique répertorié pour le moment.</p>
        )}
      </div>

      {/* Taxes à l'agenda des prochains Conseils communaux */}
      <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 space-y-4">
        <h2 className="text-xl font-semibold text-white flex items-center gap-2">
          <Calendar className="w-5 h-5 text-purple-400" />
          Prochaines taxes & modifications à l'agenda
        </h2>
        
        {dailyData && dailyData.upcomingAgendaTaxes.length > 0 ? (
          <div className="grid grid-cols-1 gap-3">
            {dailyData.upcomingAgendaTaxes.map((agenda, idx) => (
              <div key={idx} className="p-3 bg-slate-900/60 border border-slate-700/40 rounded-lg text-slate-200 text-sm">
                {agenda.title}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-slate-400 text-sm">Aucun projet de taxe détecté à l'ordre du jour des prochaines séances.</p>
        )}
      </div>
    </div>
  );
}
