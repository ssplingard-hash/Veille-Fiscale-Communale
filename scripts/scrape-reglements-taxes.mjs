/**
 * Scraper quotidien : règlements-taxes en vigueur pour les communes wallonnes
 * référencées sur https://www.deliberations.be
 *
 * VERSION PUPPETEER
 *
 * Le scraper parcourt les pages de décisions tant qu'il trouve des décisions
 * de l'année cible (2026).
 *
 * Il ne conserve ensuite que les décisions / publications à caractère fiscal.
 *
 * Sortie : src/data/reglements-taxes.json
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

const TAX_KEYWORDS =
  /(taxe|taxes|precompte|pr%C3%A9compte|impot|imp%C3%B4t|ipp|redevance|fiscal|fiscale|fiscaux|imposition)/i;

const PAGE_TIMEOUT_MS = 30000;
const RENDER_WAIT_MS = 2500;
const DELAY_BETWEEN_PAGES_MS = 300;
const DELAY_BETWEEN_COMMUNES_MS = 500;

const TARGET_YEAR = 2026;

const MONTHS_FR = {
  janvier: 0,
  fevrier: 1,
  février: 1,
  mars: 2,
  avril: 3,
  mai: 4,
  juin: 5,
  juillet: 6,
  aout: 7,
  août: 7,
  septembre: 8,
  octobre: 9,
  novembre: 10,
  decembre: 11,
  décembre: 11,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDateFromSlug(slug) {
  const m = slug.match(/(\d{1,2})-([a-zéûà]+)-(\d{4})/i);

  if (!m) return null;

  const [, day, monthName, year] = m;
  const month = MONTHS_FR[monthName.toLowerCase()];

  if (month === undefined) return null;

  const d = new Date(
    Date.UTC(
      Number(year),
      month,
      Number(day)
    )
  );

  return isNaN(d.getTime()) ? null : d;
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(
      /exercices?\s*\d{4}(\s*(a|à)\s*\d{4})?/g,
      ''
    )
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

    const existingDate = existing.date
      ? new Date(existing.date).getTime()
      : 0;

    const itemDate = item.date
      ? new Date(item.date).getTime()
      : 0;

    if (itemDate > existingDate) {
      byKey.set(key, item);
    }
  }

  return [...byKey.values()].sort((a, b) =>
    (b.date || '').localeCompare(a.date || '')
  );
}

/**
 * Extrait toutes les décisions présentes sur la page.
 *
 * On extrait TOUTES les décisions, pas uniquement les décisions fiscales,
 * car nous avons besoin de savoir si la pagination contient encore
 * des décisions de l'année cible.
 */
function extractAllDecisions($, slug) {
  const found = [];

  const pointLinkRegex = new RegExp(
    `/${slug}/decisions/[^/]+/[^/"?#]+`,
    'i'
  );

  const seenUrls = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';

    if (!pointLinkRegex.test(href)) return;

    const absoluteUrl = href.startsWith('http')
      ? href
      : `${BASE}${href}`;

    if (seenUrls.has(absoluteUrl)) return;

    seenUrls.add(absoluteUrl);

    const slugPart =
      href.split('/').filter(Boolean).pop() || '';

    let title = $(el).text().trim();

    if (!title) {
      title = $(el)
        .closest('article, div, li')
        .find('h2,h3,h4')
        .first()
        .text()
        .trim();
    }

    if (!title) {
      try {
        title = decodeURIComponent(slugPart).replace(
          /-/g,
          ' '
        );
      } catch {
        title = slugPart.replace(/-/g, ' ');
      }
    }

    const date = parseDateFromSlug(href);

    const isTaxRelated =
      TAX_KEYWORDS.test(slugPart) ||
      TAX_KEYWORDS.test(title);

    const container = $(el)
      .closest('article, div, li')
      .parent();

    const contextText = container.text();

    const matiereMatch = contextText.match(
      /Mati[eè]re\s*\n?\s*([A-ZÉÈÀÂÔÎ][^\n]{2,60})/
    );

    const matiere = matiereMatch
      ? matiereMatch[1].trim()
      : null;

    found.push({
      title,
      url: absoluteUrl,
      matiere,
      date: date ? date.toISOString() : null,
      isTaxRelated,
    });
  });

  return found;
}

/**
 * Trouve le lien de pagination suivant.
 *
 * Deliberations.be utilise des URLs du type :
 * /decisions/@@faceted_query?b_start:int=20&...
 */
function findNextPageUrl($, currentUrl) {
  const candidates = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';

    if (!href.includes('/@@faceted_query')) return;

    const match = href.match(
      /b_start(?::int)?=(\d+)/i
    );

    if (!match) return;

    const start = Number(match[1]);

    candidates.push({
      start,
      href,
    });
  });

  if (!candidates.length) return null;

  const currentMatch = currentUrl.match(
    /b_start(?::int)?=(\d+)/i
  );

  const currentStart = currentMatch
    ? Number(currentMatch[1])
    : 0;

  const next = candidates
    .filter((item) => item.start > currentStart)
    .sort((a, b) => a.start - b.start)[0];

  if (!next) return null;

  return next.href.startsWith('http')
    ? next.href
    : `${BASE}${next.href}`;
}

/**
 * Charge une page de décisions via Puppeteer.
 */
async function scrapeDecisionPage(browser, url, slug) {
  const page = await browser.newPage();

  await page.setUserAgent(USER_AGENT);

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'fr',
  });

  try {
    console.log(`    → ${url}`);

    const response = await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: PAGE_TIMEOUT_MS,
    });

    if (response && response.status() === 404) {
      return {
        allItems: [],
        taxItems: [],
        nextPage: null,
      };
    }

    if (
      response &&
      !response.ok() &&
      response.status() !== 200
    ) {
      throw new Error(
        `HTTP ${response.status()} pour ${url}`
      );
    }

    await sleep(RENDER_WAIT_MS);

    const html = await page.content();
    const $ = cheerio.load(html);

    const allItems = extractAllDecisions($, slug);

    const taxItems = allItems
      .filter((item) => item.isTaxRelated)
      .map(
        ({
          title,
          url,
          matiere,
          date,
        }) => ({
          title,
          url,
          matiere,
          date,
        })
      );

    const nextPage = findNextPageUrl($, url);

    const targetYearItems = allItems.filter((item) => {
      if (!item.date) return false;

      return (
        new Date(item.date).getUTCFullYear() ===
        TARGET_YEAR
      );
    });

    console.log(
      `    ${allItems.length} décision(s) trouvée(s)`
    );

    console.log(
      `    ${taxItems.length} décision(s) fiscale(s) trouvée(s)`
    );

    console.log(
      `    ${targetYearItems.length} décision(s) de ${TARGET_YEAR}`
    );

    return {
      allItems,
      taxItems,
      nextPage,
      targetYearItems,
    };
  } finally {
    await page.close();
  }
}

/**
 * Parcourt les décisions jusqu'à sortir de l'année 2026.
 *
 * IMPORTANT :
 * La décision de continuer ou d'arrêter est maintenant basée sur
 * TOUTES les décisions de la page, et non uniquement sur les décisions fiscales.
 */
async function scrapeDecisionsForYear(browser, slug) {
  const allTaxItems = [];

  let currentUrl = `${BASE}/${slug}/decisions`;
  let pageNumber = 1;

  const visited = new Set();

  while (
    currentUrl &&
    !visited.has(currentUrl)
  ) {
    visited.add(currentUrl);

    console.log(
      `  Page décisions ${pageNumber}`
    );

    const result =
      await scrapeDecisionPage(
        browser,
        currentUrl,
        slug
      );

    allTaxItems.push(...result.taxItems);

    /*
     * On continue tant que la page contient au moins
     * une décision de 2026.
     */
    const hasTargetYear =
      result.targetYearItems.length > 0;

    if (!hasTargetYear) {
      console.log(
        `    Fin de la recherche ${TARGET_YEAR} pour ${slug}`
      );

      break;
    }

    if (!result.nextPage) {
      console.log(
        `    Plus de page disponible pour ${slug}`
      );

      break;
    }

    currentUrl = result.nextPage;
    pageNumber++;

    await sleep(
      DELAY_BETWEEN_PAGES_MS
    );

    /*
     * Sécurité contre une éventuelle boucle infinie.
     */
    if (pageNumber > 100) {
      console.log(
        `    Limite de sécurité atteinte pour ${slug}`
      );

      break;
    }
  }

  return allTaxItems;
}

/**
 * Charge les publications.
 *
 * Les publications sont conservées sur la première page.
 */
async function scrapePublications(
  browser,
  slug
) {
  const url =
    `${BASE}/${slug}/publications`;

  const page =
    await browser.newPage();

  await page.setUserAgent(
    USER_AGENT
  );

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'fr',
  });

  try {
    const response =
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: PAGE_TIMEOUT_MS,
      });

    if (
      response &&
      response.status() === 404
    ) {
      return [];
    }

    if (
      response &&
      !response.ok() &&
      response.status() !== 200
    ) {
      throw new Error(
        `HTTP ${response.status()} pour ${url}`
      );
    }

    await sleep(
      RENDER_WAIT_MS
    );

    const html =
      await page.content();

    const $ =
      cheerio.load(html);

    const pointLinkRegex =
      new RegExp(
        `/${slug}/publications/[^/"?#]+`,
        'i'
      );

    const found = [];
    const seenUrls = new Set();

    $('a[href]').each((_, el) => {
      const href =
        $(el).attr('href') || '';

      if (
        !pointLinkRegex.test(href)
      ) {
        return;
      }

      const absoluteUrl =
        href.startsWith('http')
          ? href
          : `${BASE}${href}`;

      if (
        seenUrls.has(absoluteUrl)
      ) {
        return;
      }

      seenUrls.add(
        absoluteUrl
      );

      const slugPart =
        href
          .split('/')
          .filter(Boolean)
          .pop() || '';

      let title =
        $(el)
          .text()
          .trim();

      if (!title) {
        title =
          $(el)
            .closest(
              'article, div, li'
            )
            .find(
              'h2,h3,h4'
            )
            .first()
            .text()
            .trim();
      }

      if (!title) {
        try {
          title =
            decodeURIComponent(
              slugPart
            ).replace(
              /-/g,
              ' '
            );
        } catch {
          title =
            slugPart.replace(
              /-/g,
              ' '
            );
        }
      }

      const isTaxRelated =
        TAX_KEYWORDS.test(
          slugPart
        ) ||
        TAX_KEYWORDS.test(
          title
        );

      if (!isTaxRelated) {
        return;
      }

      const container =
        $(el)
          .closest(
            'article, div, li'
          )
          .parent();

      const contextText =
        container.text();

      const matiereMatch =
        contextText.match(
          /Mati[eè]re\s*\n?\s*([A-ZÉÈÀÂÔÎ][^\n]{2,60})/
        );

      const matiere =
        matiereMatch
          ? matiereMatch[1].trim()
          : null;

      found.push({
        title,
        url: absoluteUrl,
        matiere,
        date: null,
      });
    });

    console.log(
      `  ${found.length} publication(s) fiscale(s) trouvée(s)`
    );

    return found;
  } finally {
    await page.close();
  }
}

async function main() {
  const communes =
    JSON.parse(
      await fs.readFile(
        COMMUNES_FILE,
        'utf-8'
      )
    );

  /*
   * TEST TEMPORAIRE :
   * on ne traite que Liège.
   *
   * Une fois le scraper validé, cette ligne pourra être supprimée
   * pour revenir à toutes les communes.
   */
  const communesATester =
    communes.filter(
      ({ slug }) =>
        slug === 'liege'
    );

  const output = {};

  console.log(
    `Lancement du navigateur headless pour l'année ${TARGET_YEAR}...`
  );

  const browser =
    await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

  try {
    for (
      const { slug, name }
      of communesATester
    ) {
      console.log(
        `\n→ ${name} (${slug})`
      );

      try {
        const decisions =
          await scrapeDecisionsForYear(
            browser,
            slug
          );

        const publications =
          await scrapePublications(
            browser,
            slug
          );

        const enVigueur =
          dedupeKeepLatest([
            ...decisions,
            ...publications,
          ]);

        /*
         * Pour les décisions, on conserve uniquement 2026.
         *
         * Les publications sans date restent conservées si elles
         * correspondent à un mot-clé fiscal.
         */
        const filtered =
          enVigueur.filter(
            (item) => {
              if (!item.date) {
                return true;
              }

              return (
                new Date(
                  item.date
                ).getUTCFullYear() ===
                TARGET_YEAR
              );
            }
          );

        output[name] = {
          updatedAt:
            new Date().toISOString(),

          reglementsEnVigueur:
            filtered.map(
              ({
                title,
                url,
                matiere,
                date,
              }) => ({
                titre: title,
                url,
                matiere,
                date,
              })
            ),

          prochainesTaxes: [],
        };

        console.log(
          `  ✓ ${filtered.length} élément(s) fiscal(aux) conservé(s) pour ${name}`
        );
      } catch (err) {
        console.error(
          `  ✗ erreur pour ${name} : ${err.message}`
        );

        output[name] = {
          updatedAt:
            new Date().toISOString(),

          reglementsEnVigueur: [],

          prochainesTaxes: [],

          error:
            err.message,
        };
      }

      await sleep(
        DELAY_BETWEEN_COMMUNES_MS
      );
    }
  } finally {
    await browser.close();
  }

  await fs.mkdir(
    path.dirname(
      OUTPUT_FILE
    ),
    {
      recursive: true,
    }
  );

  await fs.writeFile(
    OUTPUT_FILE,
    JSON.stringify(
      output,
      null,
      2
    ),
    'utf-8'
  );

  console.log(
    `\nTerminé. Écrit dans ${OUTPUT_FILE}`
  );
}

main().catch(
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
