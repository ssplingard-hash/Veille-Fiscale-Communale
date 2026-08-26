import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  app.post('/api/fiscal-data', async (req, res) => {
    try {
      const { municipality } = req.body;
      if (!municipality) {
        return res.status(400).json({ error: 'Municipality is required' });
      }

      const prompt = `Vous êtes l'Agent d'Intelligence Artificielle Spécialisé en Veille Fiscale Communale pour l'ensemble des communes de Wallonie et de Bruxelles.
Votre mission actuelle porte sur la commune de : ${municipality}.

RÔLE & MISSION :
1. Effectuer une veille en temps réel via Google Search Grounding sur le site officiel de la commune, ordres du jour, procès-verbaux (PV) de conseils communaux, et bulletins officiels pour ${municipality}.
2. Détecter l'ensemble des taxes en projet (prochainement discutées) et les règlements-taxes définitivement votés et en vigueur.
3. Extraire scrupuleusement l'URL exacte et fonctionnelle menant au PV, à l'ordre du jour ou au texte du règlement.
4. Classer chaque mesure par domaine : [Commerce, Environnement, Bureaux, Mobilité, PME, Professions libérales, Centimes additionnels IPP, Centimes additionnels PRI].
5. Identifier l'échevin(e) en charge des finances (Nom, Prénom, Email, Téléphone).

Retournez un objet JSON avec la structure exacte suivante, en remplissant au mieux avec les informations réelles trouvées. Si une information n'est pas trouvée (ex: pas de projets discutés ou url introuvable), mettez un tableau vide ou une chaîne vide.`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              commune: { type: Type.STRING },
              region: { type: Type.STRING },
              echevin_finances: {
                type: Type.OBJECT,
                properties: {
                  nom: { type: Type.STRING },
                  email: { type: Type.STRING },
                  telephone: { type: Type.STRING },
                },
              },
              taux_additionnels: {
                type: Type.OBJECT,
                properties: {
                  ipp_pourcentage: { type: Type.NUMBER },
                  pri_centimes: { type: Type.NUMBER },
                },
              },
              discussions_prochaines: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    titre: { type: Type.STRING },
                    domaine: { type: Type.STRING },
                    date_conseil: { type: Type.STRING },
                    statut: { type: Type.STRING },
                    resume: { type: Type.STRING },
                    url_document: { type: Type.STRING },
                  },
                },
              },
              reglements_en_vigueur: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    titre: { type: Type.STRING },
                    domaine: { type: Type.STRING },
                    statut: { type: Type.STRING },
                    taux_description: { type: Type.STRING },
                    url_reglement: { type: Type.STRING },
                  },
                },
              },
            },
            required: [
              'commune',
              'region',
              'echevin_finances',
              'taux_additionnels',
              'discussions_prochaines',
              'reglements_en_vigueur',
            ],
          },
        },
      });

      const text = response.text;
      if (!text) {
        throw new Error('No text returned from Gemini');
      }

      res.json(JSON.parse(text));
    } catch (error) {
      console.error('Error generating fiscal data:', error);
      
      // Check for quota or other errors and fallback to mock data
      console.warn('API Failed, using fallback data for:', req.body.municipality, error.message);
      return res.json({
        commune: req.body.municipality,
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

    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // For Express 4
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
