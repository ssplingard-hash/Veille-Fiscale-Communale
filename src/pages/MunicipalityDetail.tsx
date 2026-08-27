import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CommuneFiscalData } from '../types';
import { municipalities } from '../data/municipalities';
import { Loader2, Mail, Phone, ExternalLink, FileText, Activity, MapPin } from 'lucide-react';

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
    </div>
  );
}
