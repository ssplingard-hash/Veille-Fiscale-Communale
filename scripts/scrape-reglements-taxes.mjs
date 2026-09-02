/**
 * Scraper quotidien : règlements-taxes en vigueur pour les communes wallonnes
 * référencées sur https://www.deliberations.be
 *
 * IMPORTANT — limites connues :
 * - deliberations.be ne couvre QUE les communes wallonnes qui ont adopté la
 *   plateforme iMio (décret du 18/05/2022). Une commune wallonne peut légitimement
 *   n'y figurer sous aucune forme (ex: Waterloo, Chaudfontaine, Eupen...). Dans ce
 *   cas, l'absence de résultat est correcte et ne doit JAMAIS être remplacée par
 *   un lien fabriqué ou une donnée inventée — mieux vaut une liste vide honnête
 *   qu'une fausse information qui a l'air réelle.
 * - Le filtrage repose sur le slug de l'URL et le texte des liens (regex /taxe/i,
 *   /précompte/i, /IPP/i, /redevance/i). Robuste aux changements de mise en page,
 *   mais peut inclure de faux positifs ou rater un règlement au titre atypique.
 * - Pour les grandes villes (Liège, Charleroi, Namur...), une partie des
 *   règlements officiellement en vigueur est publiée sous /publications/ plutôt
 *   que /decisions/ (procès-verbal de séance classique) — on fusionne donc les
 *   deux sources pour la liste "en vigueur".
 * - Pagination limitée à 60 pages (1200 points) par commune et par section pour
 *   couvrir les grandes villes à fort volume, avec repli automatique dès qu'on
 *   dépasse 4 ans d'ancienneté sur les décisions datées.
 * - Erreurs réseau/rate-limit (HTTP 429/503) : 2 tentatives avec pause avant
 *   d'abandonner et de le signaler explicitement dans le champ "error" — jamais
 *   confondu silencieusement avec "cette commune n'a rien".
 *
 * Sortie : src/data/reglements-taxes.json
 *   {
 *     "<Nom commune>": {
 *       "updatedAt": "...",
 *       "reglementsEnVigueur": [ { titre, url, date, matiere } ],
 *       "prochainesTaxes": []   // voir note plus bas
 *     },
 *     ...
 *   }
 *
 * Note sur "prochainesTaxes" : deliberations.be ne permet pas de distinguer
 * fiablement un projet non-voté d'un règlement définitif sur /publications/
 * pour toutes les communes. Ce champ reste donc vide pour l'instant plutôt que
 * de risquer d'étiqueter incorrectement un règlement en vigueur comme "projet".
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

const TAX_KEYWORDS = /(taxe|precompte|pr%C3%A9compte|impot|imp%C3%B4t|ipp|redevance)/i;

const MAX_AGE_YEARS = 4;
const MAX_PAGES_PER_COMMUNE = 60;
const PAGE_SIZE = 20;
const DELAY_MS = 900;
const RETRY_DELAY_MS = 4000;
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

/** Nettoie un titre de règlement pour permettre la déduplication. */
function normalizeTitle(title) {
  return title
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/exercices?\s*\d{4}(\s*(a|à)\s*\d{4})?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Scrape une section (decisions ou publications) d'une commune.
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
        if (/^HTTP 404/.test(err.message)) break; // section absente, légitime
        throw err; // rate-limit ou autre échec réseau : à signaler
      }
      break;
    }

    const $ = cheerio.load(html);

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
        title = $(el).closest('article, div, li').find('h2,h3,h4').first().text().trim();
      }
      if (!title) {
        title = decodeURIComponent(slugPart).replace(/-/g, ' ');
      }

      const isTaxRelated = TAX_KEYWORDS.test(slugPart) || TAX_KEYWORDS.test(title);
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

    const itemCountOnPage = $('a[href]').filter((_, el) => pointLinkRegex.test($(el).attr('href') || '')).length;
    if (itemCountOnPage === 0) break;

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

      const enVigueur = dedupeKeepLatest([...decisions, ...publications]);

      output[name] = {
        updatedAt: new Date().toISOString(),
        reglementsEnVigueur: enVigueur.map(({ title, url, matiere, date }) => ({
          titre: title,
          url,
          matiere,
          date,
        })),
        prochainesTaxes: [],
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
