export interface NewsItem {
  commune: string;
  province: string;
  titre: string;
  date: string;
  url: string;
  domaine: string;
}

export const mockDiscussions: NewsItem[] = [
  { commune: 'Namur', province: 'Namur', titre: 'Taxe sur les immeubles inoccupés', date: 'Conseil communal du 15 Octobre', url: '#', domaine: 'Environnement' },
  { commune: 'Charleroi', province: 'Hainaut', titre: 'Modification taxe poubelles', date: 'Conseil communal du 18 Octobre', url: '#', domaine: 'Environnement' },
  { commune: 'Wavre', province: 'Brabant wallon', titre: 'Taxe sur les surfaces de bureaux', date: 'Conseil communal du 20 Octobre', url: '#', domaine: 'PME' },
  { commune: 'Liège', province: 'Liège', titre: 'Taxe sur les enseignes', date: 'Conseil communal du 22 Octobre', url: '#', domaine: 'Commerce' },
  { commune: 'Bruxelles', province: 'Bruxelles', titre: 'Taxe de séjour', date: 'Conseil communal du 25 Octobre', url: '#', domaine: 'Economie' },
  { commune: 'Mons', province: 'Hainaut', titre: 'Taxe sur les secondes résidences', date: 'Conseil communal du 28 Octobre', url: '#', domaine: 'Indépendants' },
  { commune: 'Arlon', province: 'Luxembourg', titre: 'Taxe égouts', date: 'Conseil communal du 30 Octobre', url: '#', domaine: 'Environnement' },
];

export const mockAdoptions: NewsItem[] = [
  { commune: 'Liège', province: 'Liège', titre: 'Taxe sur les surfaces commerciales', date: 'Entrée en vigueur: 1er Janvier', url: '#', domaine: 'Commerce' },
  { commune: 'Mons', province: 'Hainaut', titre: 'Taxe force motrice', date: 'Entrée en vigueur: 1er Février', url: '#', domaine: 'Economie' },
  { commune: 'Arlon', province: 'Luxembourg', titre: 'Taxe sur les terrasses', date: 'Entrée en vigueur: 1er Janvier', url: '#', domaine: 'Commerce' },
  { commune: 'Ixelles', province: 'Bruxelles', titre: "Taxe d'hébergement touristique", date: 'Entrée en vigueur: 15 Février', url: '#', domaine: 'Economie' },
  { commune: 'Namur', province: 'Namur', titre: 'Taxe sur les parcs de stationnement', date: 'Entrée en vigueur: 1er Mars', url: '#', domaine: 'Mobilité' },
  { commune: 'Ottignies-Louvain-la-Neuve', province: 'Brabant wallon', titre: 'Taxe sur les distributeurs bancaires', date: 'Entrée en vigueur: 1er Mars', url: '#', domaine: 'PME' },
];
