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
  name: string;
  region: string;
  province: string;
  ipp: number;
  pri: number;
  taxCount: number;
  financeOfficer: string;
  email: string;
  phone: string;
  website: string;
  regulations: ReglementVigueur[];
  discussions: DiscussionProchaine[];
}

export interface BaseCommune {
  name: string;
  region: 'Wallonie' | 'Bruxelles';
  province: string;
  ipp: number;
  pri: number;
  taxCount: number;
}

export interface ReglementTaxe {
  titre: string;
  url: string;
  matiere: string | null;
  date: string | null;
}

export interface ProchaineTaxe {
  titre: string;
  url: string;
  matiere: string | null;
}

export interface CommuneReglementsData {
  updatedAt: string;
  reglementsEnVigueur: ReglementTaxe[];
  prochainesTaxes: ProchaineTaxe[];
  error?: string;
}
