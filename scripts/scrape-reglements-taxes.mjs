/**
 * Scraper quotidien : règlements-taxes en vigueur + points "taxe" à l'ordre du jour
 * pour les communes wallonnes référencées sur https://www.deliberations.be
 *
 * IMPORTANT — limites connues (à lire avant de considérer ce script "fini") :
 * - deliberations.be ne couvre QUE les communes wallonnes (décret du 18/05/2022,
 *   plateforme iMio). Les 19 communes bruxelloises n'y figurent pas : pour elles,
 *   il faut une autre source (site propre à chaque commune).
 * - Le filtrage repose sur le slug de l'URL et le texte des liens (regex /taxe/i,
 *   /précompte/i, /IPP/i). C'est robuste aux changements de mise en page, mais
 *   peut inclure de faux positifs (ex: un point qui mentionne "taxe" en passant)
 *   ou rater un règlement dont le titre ne contient pas ces mots-clés.
 * - Je n'ai pas pu exécuter ce script contre le site réel depuis mon environnement
 *   (accès réseau restreint). Il a été écrit à partir de pages réellement
 *   consultées, mais une première exécution manuelle (workflow_dispatch) pour
 *   vérifier la sortie est fortement recommandée avant de compter sur le cron.
 *
 * Sortie : src/data/reglements-taxes.json
 *   {
 *     "<Nom commune>": {
 *       "updatedAt": "2026-08-28T06:00:00.000Z",
 *       "reglementsEnVigueur": [ { titre, url, date, matiere } ],
 *       "prochainesTaxes":     [ { titre, url, matiere } ]
 *     },
 *     ...
 *   }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMUNES_FILE = path.join(__dirname, 'communes-deliberations.json');
const OUTPUT_FILE = path.join(__dirname, '../src/data/reglements-taxes.json');

const BASE = 'https://www.deliberations.be';
const USER_AGENT = 'VeilleFiscaleCommunale-bot/1.0 (+contact: voir depot GitHub)';

// Mots-clés utilisés pour repérer un point "fiscal" à partir du slug de l'URL ou du titre.
const TAX_KEYWORDS = /(taxe|precompte|pr%C3%A9compte|impot|imp%C3%B4t|ipp|redevance)/i;

// On s'arrête de paginer une fois qu'on a dépassé cette ancienneté (en années) :
// une "règlement-taxe" est en général revoté au moins une fois par législature (6 ans).
const MAX_AGE_YEARS = 4;
const MAX_PAGES_PER_COMMUNE = 60; // garde-fou anti-boucle infinie (augmenté : les grandes villes publient beaucoup plus de points par séance)
const PAGE_SIZE = 20; // pagination Plone par défaut (b_start:int)
const DELAY_MS = 900; // pause polie entre deux requêtes HTTP (augmentée pour éviter le rate-limiting)
const RETRY_DELAY_MS = 4000; // pause avant une nouvelle tentative après un échec réseau
const MAX_RETRIES = 2;

const MONTHS_FR = {
  'janvier': 0, 'fevrier': 1, 'février': 1, 'mars': 2, 'avril': 3, 'mai': 4, 'juin': 5,
  'juillet': 6, 'aout': 7, 'août': 7, 'septembre': 8, 'octobre': 9, 'novembre': 10, 'decembre': 11, 'décembre': 11,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch avec retry : distingue une vraie erreur réseau/rate-limit d'une absence légitime de contenu. */
async function fetchHtml(url, attempt = 0) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'fr' } });
  if (res.status === 429 || res.status === 503) {
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * (attempt + 1));
      return fetchHtml(url, attempt + 1);
    }
    throw new Error(`RATE_LIMITED (HTTP ${res.status}) pour ${url}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} pour ${url}`);
  }
  return res.text();
}

/** Extrait une date approximative à partir d'un slug du type "20-octobre-2025-20-00". */
function parseDateFromSlug(slug) {
  const m = slug.match(/(\d{1,2})-([a-zéû]+)-(\d{4})/i);
  if (!m) return null;
  const [, day, monthName, year] = m;
  const month = MONTHS_FR[monthName.toLowerCase()];
  if (month === undefined) return null;
  const d = new Date(Date.UTC(Number(year), month, Number(day)));
  return isNaN(d.getTime()) ? null : d;
}

/** Nettoie un titre de règlement pour permettre la déduplication (garde la même taxe, versions différentes). */
function normalizeTitle(title) {
  return title
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève les accents
    .replace(/exercices?\s*\d{4}(\s*(a|à)\s*\d{4})?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Scrape une section (decisions ou publications) d'une commune.
 * type: 'decisions' (règlements votés) ou 'publications' (projets avant vote / ordre du jour)
 */
async function scrapeSection(slug, type) {
  const results = [];
  let bStart = 0;
  let page = 0;

  while (page < MAX_PAGES_PER_COMMUNE) {
    const url = `${BASE}/${slug}/${type}${bStart ? `?b_start:int=${bStart}` : ''}`;
    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      if (page === 0) {
        // Échec dès la première page : soit la section n'existe vraiment pas pour cette
        // commune (404 attendu), soit c'est un vrai problème réseau/rate-limit (à distinguer
        // par le message). On remonte l'erreur pour qu'elle soit visible dans la sortie
        // plutôt que de la confondre silencieusement avec "aucun règlement".
        if (/^HTTP 404/.test(err.message)) break; // section absente, légitime
        throw err; // rate-limit ou autre échec réseau : à signaler
      }
      // Échec au-delà de la première page : on garde ce qu'on a déjà trouvé.
      break;
    }

    const $ = cheerio.load(html);

    // Repère tous les liens qui pointent vers un point individuel :
    //   /{slug}/decisions/{date}/{point}   ou   /{slug}/publications/{point}
    const pointLinkRegex =
      type === 'decisions'
        ? new RegExp(`/${slug}/decisions/[^/]+/[^/"?#]+`, 'i')
        : new RegExp(`/${slug}/publications/[^/"?#]+`, 'i');

    const found = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!pointLinkRegex.test(href)) return;

      const slugPart = href.split('/').filter(Boolean).pop() || '';
      let title = $(el).text().trim();
      if (!title) {
        // repli : titre voisin (h2/h3/h4) ou dérivé du slug de l'URL
        title = $(el).closest('article, div, li').find('h2,h3,h4').first().text().trim();
      }
      if (!title) {
        title = decodeURIComponent(slugPart).replace(/-/g, ' ');
      }

      const isTaxRelated = TAX_KEYWORDS.test(slugPart) || TAX_KEYWORDS.test(title);
      // Cherche la matière dans le texte environnant (best effort, dégrade proprement si absent)
      const container = $(el).closest('article, div, li').parent();
      const contextText = container.text();
      const matiereMatch = contextText.match(/Mati[eè]re\s*\n?\s*([A-ZÉÈÀÂÔÎ][^\n]{2,60})/);
      const matiere = matiereMatch ? matiereMatch[1].trim() : null;

      if (isTaxRelated) {
        const absoluteUrl = href.startsWith('http') ? href : `${BASE}${href}`;
        const date = type === 'decisions' ? parseDateFromSlug(href) : null;
        found.push({ title, url: absoluteUrl, matiere, date: date ? date.toISOString() : null });
      }
    });

    results.push(...found);

    // Condition d'arrêt : plus de 20 items sur la page => probablement dernière page atteinte
    const itemCountOnPage = $('a[href]').filter((_, el) => pointLinkRegex.test($(el).attr('href') || '')).length;
    if (itemCountOnPage === 0) break;

    // Arrête la pagination si on a dépassé l'ancienneté max (uniquement pertinent pour /decisions, daté)
    if (type === 'decisions') {
      const oldestOnPage = found
        .map((f) => (f.date ? new Date(f.date) : null))
        .filter(Boolean)
        .sort((a, b) => a - b)[0];
      if (oldestOnPage) {
        const ageYears = (Date.now() - oldestOnPage.getTime()) / (365.25 * 24 * 3600 * 1000);
        if (ageYears > MAX_AGE_YEARS) break;
      }
    }

    bStart += PAGE_SIZE;
    page += 1;
    await sleep(DELAY_MS);
  }

  return results;
}

/** Garde uniquement la version la plus récente de chaque règlement (par titre normalisé). */
function dedupeKeepLatest(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = normalizeTitle(item.title);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    const existingDate = existing.date ? new Date(existing.date).getTime() : 0;
    const itemDate = item.date ? new Date(item.date).getTime() : 0;
    if (itemDate > existingDate) byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

async function main() {
  const communes = JSON.parse(await fs.readFile(COMMUNES_FILE, 'utf-8'));
  const output = {};

  for (const { slug, name } of communes) {
    console.log(`→ ${name} (${slug})`);
    try {
      const decisions = await scrapeSection(slug, 'decisions');
      await sleep(DELAY_MS);
      const publications = await scrapeSection(slug, 'publications');

      // Certaines communes (notamment les grandes villes) publient une partie de leurs
      // règlements-taxes définitifs sous /publications/ plutôt que sous /decisions/ (le
      // procès-verbal de séance classique). On fusionne donc les deux sources pour la
      // liste "en vigueur", en dédupliquant par titre et en gardant la version la plus
      // récente — /publications/ n'étant plus réservé aux seuls projets non votés.
      const enVigueur = dedupeKeepLatest([...decisions, ...publications]);

      output[name] = {
        updatedAt: new Date().toISOString(),
        reglementsEnVigueur: enVigueur.map(({ title, url, matiere, date }) => ({
          titre: title,
          url,
          matiere,
          date,
        })),
        prochainesTaxes: [], // fusionné ci-dessus faute de pouvoir distinguer fiablement "projet" de "définitif" sur toutes les communes
      };
    } catch (err) {
      console.error(`  ✗ erreur pour ${name} : ${err.message}`);
      output[name] = { updatedAt: new Date().toISOString(), reglementsEnVigueur: [], prochainesTaxes: [], error: err.message };
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
