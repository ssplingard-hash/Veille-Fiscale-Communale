/**
 * Scraper quotidien : règlements-taxes en vigueur pour les 19 communes bruxelloises,
 * à partir du site officiel de CHAQUE commune (pas de portail centralisé équivalent
 * à deliberations.be pour Bruxelles — cf. scripts/communes-bruxelles.json).
 *
 * IMPORTANT — limites connues :
 * - Contrairement au scraper wallon (deliberations.be), il n'y a ici NI structure
 *   d'URL commune à tous, NI pagination standard : chaque commune a son propre site
 *   (Drupal, Plone, WordPress, PHP maison...). Ce script utilise une heuristique
 *   générique (tous les liens dont le texte ou l'URL contient "taxe", "règlement",
 *   "redevance", "impôt", "précompte") plutôt que des sélecteurs CSS par commune.
 *   Cela fonctionne raisonnablement sur des pages qui listent des PDF, mais peut
 *   rater des règlements ou inclure des faux positifs selon la mise en page.
 * - Certaines URLs du fichier de config ont un niveau de confiance "medium"/"low" :
 *   elles ont été trouvées par recherche web et n'ont pas pu être vérifiées
 *   manuellement en détail. Elles sont scrapées quand même, mais un résultat vide
 *   ou incohérent pour ces communes n'est pas forcément un bug du script.
 * - Koekelberg : aucune URL exploitable (règlements consultables uniquement sur
 *   rendez-vous, pas de publication en ligne) — la commune apparaîtra avec une
 *   liste vide et un message explicite.
 * - PAS d'équivalent "prochaines taxes à l'agenda" ici : il n'existe pas de portail
 *   listant les ordres du jour des conseils communaux bruxellois comme pour la
 *   Wallonie. Le champ prochainesTaxes restera donc vide pour toutes ces communes
 *   tant qu'une source n'aura pas été identifiée commune par commune.
 * - Comme pour le scraper wallon, ce code n'a pas pu être testé contre les sites
 *   réels depuis mon environnement (accès réseau restreint) : une vérification
 *   manuelle après la première exécution (workflow_dispatch) est recommandée.
 *
 * Fusionne son résultat dans le MÊME fichier de sortie que le scraper wallon :
 *   src/data/reglements-taxes.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMUNES_FILE = path.join(__dirname, 'communes-bruxelles.json');
const OUTPUT_FILE = path.join(__dirname, '../src/data/reglements-taxes.json');

const USER_AGENT = 'VeilleFiscaleCommunale-bot/1.0 (+contact: voir depot GitHub)';
// IMPORTANT : ne PAS inclure "règlement" seul ici — ce mot apparaît sur quasiment
// toutes les pages de règlements communaux (police, urbanisme, ordre intérieur...),
// pas seulement les taxes. Ça noyait les résultats bruxellois dans du bruit.
const TAX_KEYWORDS = /(taxe|redevance|impot|impôt|pr[eé]compte|centimes additionnels)/i;
const DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'fr' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} pour ${url}`);
  return res.text();
}

/** Résout une URL relative par rapport à la page d'origine. */
function resolveUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Scrape une seule page "liste des taxes / règlements" d'une commune.
 * Heuristique : tout lien (PDF ou page) dont le texte ou l'URL contient un mot-clé fiscal.
 */
async function scrapeCommune(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $('a[href]').each((_, el) => {
    const hrefRaw = $(el).attr('href') || '';
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (!text && !hrefRaw) return;

    // Ignore les liens non pertinents : email, réseaux sociaux, ancres pures
    if (/^mailto:/i.test(hrefRaw)) return;
    if (/^(tel|javascript):/i.test(hrefRaw)) return;
    if (/^#/.test(hrefRaw)) return;
    if (/(facebook|twitter|bsky\.app|instagram|linkedin|youtube)\.com/i.test(hrefRaw)) return;

    // Garde-fou anti-contenu aberrant : un vrai titre de règlement ne dépasse pas ~200
    // caractères. Un texte plus long est presque toujours une fuite de contenu binaire/
    // encodé capturé par erreur (ex: script ou ressource compressée mal isolée par le DOM).
    if (text.length > 200) return;

    const isTaxRelated = TAX_KEYWORDS.test(text) || TAX_KEYWORDS.test(hrefRaw);
    if (!isTaxRelated) return;

    // Ignore les liens de navigation génériques trop courts ou non pertinents
    if (text.length > 0 && text.length < 4) return;
    if (/^(accueil|home|contact|menu|recherche|search)$/i.test(text)) return;

    const absoluteUrl = resolveUrl(hrefRaw, url);
    if (!absoluteUrl) return;
    if (seen.has(absoluteUrl)) return;
    seen.add(absoluteUrl);

    const title = text || decodeURIComponent(absoluteUrl.split('/').filter(Boolean).pop() || '').replace(/[-_]/g, ' ');
    results.push({ titre: title, url: absoluteUrl, matiere: null, date: null });
  });

  return results;
}

async function main() {
  const communes = JSON.parse(await fs.readFile(COMMUNES_FILE, 'utf-8'));

  // Charge le fichier existant (déjà rempli par le scraper wallon) pour fusionner sans écraser.
  let output = {};
  try {
    output = JSON.parse(await fs.readFile(OUTPUT_FILE, 'utf-8'));
  } catch {
    output = {};
  }

  for (const { name, url, confidence, note } of communes) {
    console.log(`→ ${name}${url ? '' : ' (pas d’URL exploitable)'}`);

    if (!url) {
      output[name] = {
        updatedAt: new Date().toISOString(),
        reglementsEnVigueur: [],
        prochainesTaxes: [],
        error: note || 'Aucune source en ligne disponible pour cette commune.',
      };
      continue;
    }

    try {
      const reglements = await scrapeCommune(url);
      output[name] = {
        updatedAt: new Date().toISOString(),
        reglementsEnVigueur: reglements,
        prochainesTaxes: [], // pas de source identifiée pour l'instant côté Bruxelles
        ...(confidence && confidence !== 'high' ? { confidence, note } : {}),
      };
    } catch (err) {
      console.error(`  ✗ erreur pour ${name} : ${err.message}`);
      output[name] = {
        updatedAt: new Date().toISOString(),
        reglementsEnVigueur: [],
        prochainesTaxes: [],
        error: err.message,
      };
    }
    await sleep(DELAY_MS);
  }

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nTerminé. Écrit dans ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
