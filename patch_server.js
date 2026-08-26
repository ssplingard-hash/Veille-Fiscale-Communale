import fs from 'fs';

let serverCode = fs.readFileSync('server.ts', 'utf8');

const fallbackBlock = `
      // Check for quota or other errors and fallback to mock data
      console.warn('API Failed, using fallback data for:', municipality, error.message);
      return res.json({
        commune: municipality,
        region: "Région (Simulée)",
        echevin_finances: {
          nom: "API Limitée - Mode Démo",
          email: "demo@commune.be",
          telephone: "00/000.00.00"
        },
        taux_additionnels: {
          ipp_pourcentage: 8.0,
          pri_centimes: 2500
        },
        discussions_prochaines: [
          {
            titre: "Quota API Atteint - Projet Simulé",
            domaine: "Information",
            date_conseil: new Date().toISOString().split('T')[0],
            statut: "Projet",
            resume: "Cette donnée est simulée car l'API d'Intelligence Artificielle est actuellement limitée (Quota). L'application fonctionne correctement.",
            url_document: "#"
          }
        ],
        reglements_en_vigueur: [
          {
            titre: "Quota API Atteint - Règlement Simulé",
            domaine: "Information",
            statut: "En Vigueur",
            taux_description: "Cette donnée est simulée.",
            url_reglement: "#"
          }
        ]
      });
`;

serverCode = serverCode.replace(
  "res.status(500).json({ error: 'Failed to fetch fiscal data', details: error.message });",
  fallbackBlock
);

fs.writeFileSync('server.ts', serverCode);
