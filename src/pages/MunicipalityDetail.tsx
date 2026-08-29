import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CommuneFiscalData, CommuneReglementsData } from '../types';
import { municipalities } from '../data/municipalities';
import reglementsTaxes from '../data/reglements-taxes.json';
import { Loader2, Mail, Phone, ExternalLink, FileText, Activity, MapPin, Calendar } from 'lucide-react';

const reglementsData = reglementsTaxes as Record<string, CommuneReglementsData>;

export default function MunicipalityDetail() {
  const { name } = useParams<{ name: string }>();
  const [data, setData] = useState<CommuneFiscalData | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'VIGUEUR' | 'PROJETS'>('VIGUEUR');

  useEffect(() => {
    if (!name) return;

    setLoading(true);
    setError('');

    try {
      const found = municipalities.find(
        (m) =>
          decodeURIComponent(m.name).toLowerCase().replace(/[- ]/g, '') ===
          decodeURIComponent(name || '').toLowerCase().replace(/[- ]/g, '')
      );

      if (!found) {
        throw new Error('Commune non trouvée');
      }

      // Casting sécurisé avec fallback pour satisfaire l'interface CommuneFiscalData
      const formattedData: CommuneFiscalData = {
        name: found.name,
        region: found.region,
        province: found.province,
        ipp: found.ipp,
        pri: found.pri,
        taxCount: found.taxCount,
        financeOfficer: (found as any).financeOfficer || 'Non renseigné',
        email: (found as any).email || '',
        phone: (found as any).phone || '',
        website: (found as any).website || '',
        regulations: (found as any).regulations || [],
        discussions: (found as any).discussions || []
      };

      setData(formattedData);
    } catch (err: any) {
      setError(err.message || 'Une erreur est survenue');
    } finally {
      setLoading(false);
    }
  }, [name]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 bg-red-900/20 border border-red-500/30 rounded-xl text-red-400">
        {error || 'Commune introuvable'}
      </div>
    );
  }

  const communeReglements = reglementsData[data.name];

  return (
    <div className="space-y-6">
      {/* En-tête de la commune */}
      <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 backdrop-blur-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white flex items-center gap-3">
              <MapPin className="w-8 h-8 text-blue-400" />
              {data.name}
            </h1>
            <p className="text-slate-400 mt-1">
              Province de {data.province} • Région {data.region}
            </p>
          </div>
          
          {data.financeOfficer && (
            <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-700/30">
              <span className="text-xs text-slate-400 uppercase tracking-wider block">Échevin(e) des finances</span>
              <span className="text-lg font-semibold text-white">{data.financeOfficer}</span>
            </div>
          )}
        </div>
      </div>

      {/* Cartes d'indicateurs fiscaux */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
          <div className="text-sm font-medium text-slate-400">Centimes additionnels IPP</div>
          <div className="text-3xl font-bold text-white mt-2">{data.ipp}%</div>
        </div>

        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
          <div className="text-sm font-medium text-slate-400">Centimes additionnels PRI</div>
          <div className="text-3xl font-bold text-emerald-400 mt-2">{data.pri}</div>
        </div>

        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
          <div className="text-sm font-medium text-slate-400">Nombre de taxes communales</div>
          <div className="text-3xl font-bold text-blue-400 mt-2">{data.taxCount}</div>
        </div>
      </div>

      {/* Règlements-taxes et ordre du jour (deliberations.be) */}
      <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 backdrop-blur-sm">
        {communeReglements?.updatedAt && (
          <p className="text-xs text-slate-500 mb-4">
            Dernière mise à jour : {new Date(communeReglements.updatedAt).toLocaleString('fr-BE')}
          </p>
        )}

        <div className="flex gap-2 border-b border-slate-700/50 mb-4">
          <button
            onClick={() => setActiveTab('VIGUEUR')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'VIGUEUR'
                ? 'border-blue-400 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            Règlements en vigueur ({communeReglements?.reglementsEnVigueur.length ?? 0})
          </button>
          <button
            onClick={() => setActiveTab('PROJETS')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'PROJETS'
                ? 'border-blue-400 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            À l'ordre du jour ({communeReglements?.prochainesTaxes.length ?? 0})
          </button>
        </div>

        {!communeReglements && (
          <p className="text-slate-400 text-sm">
            Pas encore de données pour cette commune (commune bruxelloise, ou pas encore couverte
            par deliberations.be).
          </p>
        )}

        {communeReglements && activeTab === 'VIGUEUR' && (
          <ul className="space-y-3">
            {communeReglements.reglementsEnVigueur.length === 0 && (
              <p className="text-slate-400 text-sm">Aucun règlement-taxe trouvé.</p>
            )}
            {communeReglements.reglementsEnVigueur.map((r, i) => (
              <li key={i} className="flex items-start gap-3 bg-slate-900/40 rounded-lg p-3">
                <FileText className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-white hover:text-blue-400 font-medium flex items-center gap-1"
                  >
                    {r.titre}
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                  </a>
                  <div className="text-xs text-slate-400 mt-1 flex gap-3">
                    {r.matiere && <span>{r.matiere}</span>}
                    {r.date && <span>{new Date(r.date).toLocaleDateString('fr-BE')}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {communeReglements && activeTab === 'PROJETS' && (
          <ul className="space-y-3">
            {communeReglements.prochainesTaxes.length === 0 && (
              <p className="text-slate-400 text-sm">Aucun point fiscal à l'ordre du jour actuellement.</p>
            )}
            {communeReglements.prochainesTaxes.map((p, i) => (
              <li key={i} className="flex items-start gap-3 bg-slate-900/40 rounded-lg p-3">
                <Calendar className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-white hover:text-blue-400 font-medium flex items-center gap-1"
                  >
                    {p.titre}
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                  </a>
                  {p.matiere && <div className="text-xs text-slate-400 mt-1">{p.matiere}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
