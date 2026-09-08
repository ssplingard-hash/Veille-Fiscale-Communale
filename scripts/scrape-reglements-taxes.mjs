/**
 * Scraper règlements-taxes wallons — deliberations.be
 *
 * Découverte clé (confirmée par les logs de test) : l'URL
 *   /{slug}/decisions/@@faceted_query?b_start:int=X
 * renvoie le vrai contenu (liste des décisions), y compris pour les grandes
 * villes (Liège...) qui n'affichent qu'un formulaire vide sur l'URL simple
 * /{slug}/decisions. On utilise donc CETTE URL pour toutes les communes,
 * à toutes les pages (y compris la première, b_start:int=0).
 *
 * Contrairement à une version précédente qui visitait CHAQUE décision
 * individuellement (384 pages rien que pour Liège → beaucoup trop lent, et le
 * titre récupéré sur la page individuelle était générique/inexploitable), on
 * extrait ici le titre et la matière DIRECTEMENT depuis la page de liste, où
 * chaque décision apparaît comme une carte avec son titre en texte de lien.
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
const PAGE_SIZE = 20;
const MAX_PAGES_PER_SECTION = 25; // garde-fou : ~500 décisions par commune/section
const MAX_AGE_YEARS = 3;
const RENDER_WAIT_MS = 1000;
const NAV_TIMEOUT_MS = 45000;

const TAX_KEYWORDS = /(taxe|precompte|pr[eé]compte|impot|imp[oô]t|\bipp\b|redevance|additionnel)/i;

const MONTHS_FR = {
  janvier: 0, fevrier: 1, février: 1, mars: 2, avril: 3, mai: 4, juin: 5,
  juillet: 6, aout: 7, août: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11, décembre: 11,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseDateFromSlug(url) {
  const m = url.match(/(\d{1,2})-([a-zéèêàûùôîï]+)-(\d{4})/i);
  if (!m) return null;
  const month = MONTHS_FR[m[2].toLowerCase()];
  if (month === undefined) return null;
  const d = new Date(Date.UTC(Number(m[3]), month, Number(m[1])));
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
    if (!existing || (item.date || '') > (existing.date || '')) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

/** Extrait titre + matière directement depuis une carte de la page de liste. */
function extractFromListing($, el, slug, type) {
  const href = $(el).attr('href') || '';
  let title = $(el).text().trim().replace(/\s+/g, ' ');

  // Titre générique/vide -> cherche un h2/h3/h4 dans le bloc parent
  if (!title || /^(d[eé]cision|projet)$/i.test(title)) {
    title = $(el).closest('article, div, li, tr').find('h2,h3,h4').first().text().trim();
  }
  if (!title) {
    const slugPart = decodeURIComponent(href.split('/').filter(Boolean).pop() || '');
    title = slugPart.replace(/-/g, ' ');
  }

  const container = $(el).closest('article, div, li, tr').parent().text();
  const matiereMatch = container.match(/Mati[eè]re\s*\n?\s*([A-ZÉÈÀÂÔÎ][^\n]{2,60})/);
  const matiere = matiereMatch ? matiereMatch[1].trim() : null;

  const date = type === 'decisions' ? parseDateFromSlug(href) : null;

  return { title, url: new URL(href, BASE).href, matiere, date: date ? date.toISOString() : null };
}

async function scrapeSection(page, slug, type) {
  const results = [];
  let offset = 0;
  let pageIndex = 0;

  while (pageIndex < MAX_PAGES_PER_SECTION) {
    const url = `${BASE}/${slug}/${type}/@@faceted_query?b_start:int=${offset}`;
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      if (pageIndex === 0) throw new Error(`Échec chargement ${url} : ${err.message}`);
      break;
    }
    if (response && response.status() === 404) break;

    await sleep(RENDER_WAIT_MS);
    const html = await page.content();
    const $ = cheerio.load(html);

    const pointLinkRegex =
      type === 'decisions'
        ? new RegExp(`/${slug}/decisions/[^/]+/[^/"?#]+`, 'i')
        : new RegExp(`/${slug}/publications/[^/"?#]+`, 'i');

    const linksOnPage = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (pointLinkRegex.test(href)) linksOnPage.push(el);
    });

    if (linksOnPage.length === 0) break;

    const seen = new Set();
    for (const el of linksOnPage) {
      const item = extractFromListing($, el, slug, type);
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      if (TAX_KEYWORDS.test(item.title) || TAX_KEYWORDS.test(item.url)) {
        results.push(item);
      }
    }

    if (type === 'decisions') {
      const oldest = linksOnPage
        .map((el) => parseDateFromSlug($(el).attr('href') || ''))
        .filter(Boolean)
        .sort((a, b) => a - b)[0];
      if (oldest) {
        const ageYears = (Date.now() - oldest.getTime()) / (365.25 * 24 * 3600 * 1000);
        if (ageYears > MAX_AGE_YEARS) break;
      }
    }

    offset += PAGE_SIZE;
    pageIndex += 1;
  }

  return results;
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
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

    for (const { slug, name } of communes) {
      console.log(`→ ${name} (${slug})`);
      try {
        const decisions = await scrapeSection(page, slug, 'decisions');
        const publications = await scrapeSection(page, slug, 'publications');
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
        console.log(`   ${enVigueur.length} règlement(s) fiscal(aux) trouvé(s)`);
      } catch (err) {
        console.error(`  ✗ erreur pour ${name} : ${err.message}`);
        output[name] = { updatedAt: new Date().toISOString(), reglementsEnVigueur: [], prochainesTaxes: [], error: err.message };
      }
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
