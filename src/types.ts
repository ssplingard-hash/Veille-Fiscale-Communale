export interface EchevinFinances {
  nom: string;
  email: string;
  telephone: string;
}

export interface TauxAdditionnels {
  ipp_pourcentage: number;
  pri_centimes: number;
}

export interface DiscussionProchaine {
  titre: string;
  domaine: string;
  date_conseil: string;
  statut: string;
  resume: string;
  url_document: string;
}

export interface ReglementVigueur {
  titre: string;
  domaine: string;
  statut: string;
  taux_description: string;
  url_reglement: string;
}

export interface CommuneFiscalData {
  commune: string;
  region: string;
  echevin_finances: EchevinFinances;
  taux_additionnels: TauxAdditionnels;
  discussions_prochaines: DiscussionProchaine[];
  reglements_en_vigueur: ReglementVigueur[];
}

export interface BaseCommune {
  name: string;
  region: 'Wallonie' | 'Bruxelles';
  ipp: number;
  pri: number;
  taxCount: number;
}
