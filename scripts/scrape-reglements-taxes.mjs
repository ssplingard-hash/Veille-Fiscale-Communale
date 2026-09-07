/**
 * Scraper quotidien : règlements-taxes en vigueur pour les communes wallonnes
 * référencées sur https://www.deliberations.be
 *
 * VERSION PUPPETEER — diagnostic complet effectué avant ce changement :
 * certaines communes (ex: Écaussinnes, Wavre) rendent la liste des délibérations
 * directement dans le HTML servi par le serveur, ce qu'une simple requête HTTP
 * peut lire. D'autres (ex: Liège, Aiseau-Presles) chargent cette liste via
 * JavaScript après le chargement initial de la page — une simple requête HTTP
 * ne voit alors qu'un squelette de formulaire vide, quel que soit le paramètre
 * d'URL essayé (testé et confirmé : aucun paramètre ne débloque le contenu sans
 * exécution JS réelle). Ce script utilise donc un navigateur headless (Chromium
 * piloté par Puppeteer) pour exécuter ce JavaScript et lire le contenu tel qu'il
 * apparaît réellement à l'écran, quelle que soit la technique utilisée par
 * chaque commune.
 *
 * COMPROMIS ASSUMÉ : pas de pagination profonde ici (contrairement à l'ancienne
 * version qui allait jusqu'à 60 pages). Chaque page réelle avec navigateur coûte
 * plusieurs secondes ; paginer en profondeur pour 200+ communes ferait durer
 * l'exécution des heures. On se limite donc à la première vue de chaque section
 * (/decisions et /publications), qui affiche normalement les éléments les plus
 * récents — suffisant pour les règlements-taxes, revotés chaque année civile.
 * Si une commune n'a pas revoté ses taxes depuis plus d'un an, elle pourrait
 * ne pas apparaître : c'est un compromis délibéré pour garder un temps
 * d'exécution raisonnable (~30-50 minutes au lieu de plusieurs heures).
 *
 * Sortie : src/data/reglements-taxes.json (même format qu'avant)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMUNES_FILE = path.join(__dirname, 'communes-deliberations.json');
const OUTPUT_FILE = path.join(__dirname, '../src/data/reglements-taxes.json');

const BASE = 'https://www.deliberations.be';
const USER_AGENT = 'VeilleFiscaleCommunale-bot/1.0 (+contact: voir depot GitHub)';
const TAX_KEYWORDS = /(taxe|precompte|pr%C3%A9compte|impot|imp%C3%B4t|ipp|redevance)/i;
const PAGE_TIMEOUT_MS = 30000;
const RENDER_WAIT_MS = 1800; // laisse le temps au JS de peupler la liste après le chargement réseau
const DELAY_BETWEEN_COMMUNES_MS = 500;

const MONTHS_FR = {
  'janvier': 0, 'fevrier': 1, 'février': 1, 'mars': 2, 'avril': 3, 'mai': 4, 'juin': 5,
  'juillet': 6, 'aout': 7, 'août': 7, 'septembre': 8, 'octobre': 9, 'novembre': 10, 'decembre': 11, 'décembre': 11,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDateFromSlug(slug) {
  const m = slug.match(/(\d{1,2})-([a-zéû]+)-(\d{4})/i);
  if (!m) return null;
  const [, day, monthName, year] = m;
  const month = MONTHS_FR[monthName.toLowerCase()];
  if (month === undefined) return null;
  const d = new Date(Date.UTC(Number(year), month, Number(day)));
  return isNaN(d.getTime()) ? null : d;
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/exercices?\s*\d{4}(\s*(a|à)\s*\d{4})?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

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

/**
 * Charge une section (decisions ou publications) via un navigateur headless
 * et extrait les points fiscaux visibles après exécution du JavaScript.
 */
async function scrapeSectionWithBrowser(browser, slug, type) {
  const url = `${BASE}/${slug}/${type}`;
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr' });

  try {
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT_MS });
    if (response && response.status() === 404) return [];
    if (response && !response.ok() && response.status() !== 200) {
      throw new Error(`HTTP ${response.status()} pour ${url}`);
    }

    // Laisse le temps au JS de peupler la liste après la fin des requêtes réseau
    await sleep(RENDER_WAIT_MS);

    const html = await page.content();
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

    return found;
  } finally {
    await page.close();
  }
}

async function main() {
  const communes = JSON.parse(await fs.readFile(COMMUNES_FILE, 'utf-8'));
  const output = {};

  console.log('Lancement du navigateur headless...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    for (const { slug, name } of communes) {
      console.log(`→ ${name} (${slug})`);
      try {
        const decisions = await scrapeSectionWithBrowser(browser, slug, 'decisions');
        const publications = await scrapeSectionWithBrowser(browser, slug, 'publications');

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
      await sleep(DELAY_BETWEEN_COMMUNES_MS);
    }
  } finally {
    await browser.close();
  }

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nTerminé. Écrit dans ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
