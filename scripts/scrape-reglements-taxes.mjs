/**
 * Scraper des règlements-taxes communaux via deliberations.be
 *
 * TEST : uniquement Liège
 * ANNÉE : 2026
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COMMUNES_FILE = path.join(
  __dirname,
  'communes-deliberations.json'
);

const OUTPUT_FILE = path.join(
  __dirname,
  '../src/data/reglements-taxes.json'
);

const BASE = 'https://www.deliberations.be';
const USER_AGENT = 'VeilleFiscaleCommunale-bot/1.0';

const TARGET_YEAR = 2026;

const PAGE_TIMEOUT_MS = 30000;
const RENDER_WAIT_MS = 2000;
const DELAY_BETWEEN_PAGES_MS = 300;


/* =========================================================
   MOIS
   ========================================================= */

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


/* =========================================================
   DÉTECTION FISCALE
   =========================================================
   
   IMPORTANT :
   - Les accents sont supprimés avant la recherche.
   - On évite donc les versions accentuées ici.
   - On ne considère PAS "Finances" comme fiscal.
   - On ne considère PAS "patrimoine", "parking",
     "stationnement", etc. comme fiscal par défaut.
   ========================================================= */

const STRONG_TAX_PATTERNS = [
  /\btaxe\b/i,
  /\btaxes\b/i,

  /\breglement[- ]taxe\b/i,
  /\breglement[- ]taxes\b/i,

  /\breglement[- ]redevance\b/i,
  /\breglement[- ]redevances\b/i,

  /\bredevance\b/i,
  /\bredevances\b/i,

  /\bprecompte\b/i,

  /\bimpot\b/i,
  /\bimpots\b/i,

  /\badditionnel\b/i,
  /\badditionnels\b/i,

  /\bcentimes additionnels\b/i,

  /\bfiscal\b/i,
  /\bfiscale\b/i,
  /\bfiscaux\b/i,
  /\bfiscalite\b/i,

  /\bimposition\b/i,
  /\bimpositions\b/i,

  /\bipp\b/i,

  /\bforce motrice\b/i,
];


/*
 * Expressions qui doivent empêcher une détection
 * lorsque le contexte est manifestement NON fiscal.
 */
const EXCLUDED_PATTERNS = [
  /\bzone de stationnement\b/i,
  /\bstationnement reserve\b/i,
  /\binterdiction d.?acces\b/i,

  /\bbail commercial\b/i,
  /\bbail-type\b/i,
  /\bconvention de bail\b/i,
  /\bemplacement de stationnement\b/i,

  /\bjournees? europeennes? du patrimoine\b/i,
  /\bpatrimoine\b/i,

  /\bsubvention\b/i,
  /\bsubventions\b/i,

  /\bcomptes annuels\b/i,
  /\bapprobation des comptes\b/i,

  /\bmarche public\b/i,
  /\bmarches publics\b/i,

  /\bpersonnel\b/i,
  /\brecrutement\b/i,
];


/* =========================================================
   OUTILS
   ========================================================= */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function normalizeText(value) {
  return (value || '')
    .replace(/\s+/g, ' ')
    .trim();
}


function normalizeForSearch(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}


function parseDateFromSlug(slug) {
  const match = slug.match(
    /(\d{1,2})-([a-zéûà]+)-(\d{4})/i
  );

  if (!match) {
    return null;
  }

  const [, day, monthName, year] = match;

  const month =
    MONTHS_FR[monthName.toLowerCase()];

  if (month === undefined) {
    return null;
  }

  const date = new Date(
    Date.UTC(
      Number(year),
      month,
      Number(day)
    )
  );

  return Number.isNaN(date.getTime())
    ? null
    : date;
}


function isTargetYear(date) {
  if (!date) {
    return false;
  }

  return date.getUTCFullYear() === TARGET_YEAR;
}


/* =========================================================
   CLASSIFICATION FISCALE
   ========================================================= */

function isTaxRelated(title, matiere, url) {
  const titleText = normalizeForSearch(title);
  const matiereText = normalizeForSearch(matiere);
  const urlText = normalizeForSearch(url);

  /*
   * Le TITRE est le critère principal.
   */
  const strongTitleMatch =
    STRONG_TAX_PATTERNS.some(
      (pattern) => pattern.test(titleText)
    );

  /*
   * La matière peut confirmer une détection,
   * mais "Finances" seul ne suffit jamais.
   */
  const strongMatiereMatch =
    STRONG_TAX_PATTERNS.some(
      (pattern) => pattern.test(matiereText)
    );

  /*
   * L'URL peut aider lorsqu'elle contient explicitement
   * reglement-taxe / taxe / redevance.
   */
  const strongUrlMatch =
    /\b(reglement[- ]taxe|reglement[- ]taxes|taxe|redevance|precompte|fiscal)\b/i.test(
      urlText
    );

  /*
   * Vérification des exclusions.
   *
   * On examine surtout le titre.
   */
  const excluded =
    EXCLUDED_PATTERNS.some(
      (pattern) => pattern.test(titleText)
    );

  if (excluded) {
    /*
     * Exception importante :
     * si le titre contient explicitement
     * "règlement-taxe", on garde la décision.
     */
    const explicitTaxRegulation =
      /\breglement[- ]taxe\b/i.test(titleText) ||
      /\breglement[- ]taxes\b/i.test(titleText);

    if (!explicitTaxRegulation) {
      return false;
    }
  }

  /*
   * Une mention fiscale explicite dans le titre suffit.
   */
  if (strongTitleMatch) {
    return true;
  }

  /*
   * Une mention fiscale explicite dans l'URL peut suffire.
   */
  if (strongUrlMatch) {
    return true;
  }

  /*
   * La matière ne suffit que si elle contient elle-même
   * une vraie notion fiscale.
   */
  if (
    strongMatiereMatch &&
    !/^finances?$/i.test(matiereText)
  ) {
    return true;
  }

  return false;
}


/* =========================================================
   CONTENEUR D'UNE DÉCISION
   ========================================================= */

function getDecisionContainer($, el) {
  /*
   * On cherche d'abord un conteneur proche.
   */

  const candidates = [
    $(el).closest('article'),
    $(el).closest('li'),
    $(el).closest('[class*="decision"]'),
    $(el).closest('[class*="item"]'),
  ];

  for (const candidate of candidates) {
    if (
      candidate.length &&
      candidate.text().trim().length > 0
    ) {
      return candidate.first();
    }
  }

  /*
   * Fallback limité.
   */

  let current = $(el);

  for (let i = 0; i < 4; i++) {
    current = current.parent();

    if (!current.length) {
      break;
    }

    const text =
      normalizeText(current.text());

    if (
      text.length >= 20 &&
      text.length <= 1000
    ) {
      return current;
    }
  }

  return $(el);
}


/* =========================================================
   MATIÈRE
   ========================================================= */

function extractMatiere(text) {
  const normalized =
    normalizeText(text);

  const patterns = [
    /Matière\s+(.+?)(?=\s+Mandataire\b)/i,
    /Matiere\s+(.+?)(?=\s+Mandataire\b)/i,
  ];

  for (const pattern of patterns) {
    const match =
      normalized.match(pattern);

    if (match && match[1]) {
      return normalizeText(match[1]);
    }
  }

  return null;
}


/* =========================================================
   TITRE
   ========================================================= */

function extractDecisionTitle(
  $,
  el,
  slugPart,
  containerText
) {
  const candidates = [];

  const directText =
    normalizeText($(el).text());

  if (directText) {
    candidates.push(directText);
  }

  const ariaLabel =
    normalizeText($(el).attr('aria-label'));

  if (ariaLabel) {
    candidates.push(ariaLabel);
  }

  const titleAttribute =
    normalizeText($(el).attr('title'));

  if (titleAttribute) {
    candidates.push(titleAttribute);
  }

  /*
   * IMPORTANT :
   * On ne prend le conteneur que comme dernier recours.
   */
  if (containerText) {
    candidates.push(containerText);
  }

  const generic = new Set([
    'projet de décision',
    'projet de decision',
    'décision',
    'decision',
    'voir',
    'plus',
    'détails',
    'details',
  ]);

  for (let candidate of candidates) {
    candidate =
      normalizeText(candidate);

    if (!candidate) {
      continue;
    }

    /*
     * Suppression des informations parasites.
     */
    candidate =
      candidate.replace(
        /\s+Matière\s+.+?(?=\s+Mandataire\b)/i,
        ''
      );

    candidate =
      candidate.replace(
        /\s+Matiere\s+.+?(?=\s+Mandataire\b)/i,
        ''
      );

    candidate =
      candidate.replace(
        /\s+Mandataire\s+.+$/i,
        ''
      );

    candidate =
      normalizeText(candidate);

    if (!candidate) {
      continue;
    }

    if (
      generic.has(
        candidate.toLowerCase()
      )
    ) {
      continue;
    }

    /*
     * Si le texte contient clairement plusieurs décisions,
     * on ne l'utilise pas comme titre.
     */
    const occurrences =
      (
        candidate.match(
          /Projet de décision/gi
        ) || []
      ).length;

    if (occurrences > 1) {
      continue;
    }

    if (candidate.length > 500) {
      continue;
    }

    return candidate;
  }

  try {
    return decodeURIComponent(
      slugPart
    ).replace(/-/g, ' ');
  } catch {
    return slugPart.replace(
      /-/g,
      ' '
    );
  }
}


/* =========================================================
   EXTRACTION DES DÉCISIONS
   ========================================================= */

function extractAllDecisions($, slug) {
  const found = [];

  const pointLinkRegex =
    new RegExp(
      `/${slug}/decisions/[^/]+/[^/"?#]+`,
      'i'
    );

  const seenUrls = new Set();

  $('a[href]').each(
    (_, el) => {
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

      seenUrls.add(absoluteUrl);

      const slugPart =
        href
          .split('/')
          .filter(Boolean)
          .pop() || '';

      const date =
        parseDateFromSlug(href);

      if (!date) {
        return;
      }

      const container =
        getDecisionContainer(
          $,
          el
        );

      const containerText =
        normalizeText(
          container.text()
        );

      const matiere =
        extractMatiere(
          containerText
        );

      const title =
        extractDecisionTitle(
          $,
          el,
          slugPart,
          containerText
        );

      const fiscal =
        isTaxRelated(
          title,
          matiere,
          absoluteUrl
        );

      found.push({
        title,
        url: absoluteUrl,
        matiere,
        date: date.toISOString(),
        isTaxRelated: fiscal,
      });
    }
  );

  return found;
}


/* =========================================================
   PAGINATION
   ========================================================= */

function findNextPageUrl(
  $,
  currentUrl
) {
  const candidates = [];

  $('a[href]').each(
    (_, el) => {
      const href =
        $(el).attr('href') || '';

      if (
        !href.includes(
          '/@@faceted_query'
        )
      ) {
        return;
      }

      const match =
        href.match(
          /b_start(?::int)?=(\d+)/i
        );

      if (!match) {
        return;
      }

      candidates.push({
        start: Number(match[1]),
        href,
      });
    }
  );

  if (!candidates.length) {
    return null;
  }

  const currentMatch =
    currentUrl.match(
      /b_start(?::int)?=(\d+)/i
    );

  const currentStart =
    currentMatch
      ? Number(currentMatch[1])
      : 0;

  const next =
    candidates
      .filter(
        (item) =>
          item.start > currentStart
      )
      .sort(
        (a, b) =>
          a.start - b.start
      )[0];

  if (!next) {
    return null;
  }

  return next.href.startsWith('http')
    ? next.href
    : `${BASE}${next.href}`;
}


/* =========================================================
   SCRAPE D'UNE PAGE
   ========================================================= */

async function scrapeDecisionPage(
  browser,
  url,
  slug,
  pageNumber
) {
  const page =
    await browser.newPage();

  await page.setUserAgent(
    USER_AGENT
  );

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'fr',
  });

  try {
    console.log(
      `\n  Page décisions ${pageNumber}`
    );

    console.log(
      `    → ${url}`
    );

    const response =
      await page.goto(
        url,
        {
          waitUntil: 'networkidle2',
          timeout: PAGE_TIMEOUT_MS,
        }
      );

    if (
      response &&
      response.status() === 404
    ) {
      return {
        allItems: [],
        taxItems: [],
        targetYearItems: [],
        nextPage: null,
      };
    }

    if (
      response &&
      !response.ok() &&
      response.status() !== 200
    ) {
      throw new Error(
        `HTTP ${response.status()}`
      );
    }

    await sleep(
      RENDER_WAIT_MS
    );

    const html =
      await page.content();

    const $ =
      cheerio.load(html);

    const allItems =
      extractAllDecisions(
        $,
        slug
      );

    const targetYearItems =
      allItems.filter(
        (item) =>
          isTargetYear(
            new Date(item.date)
          )
      );

    const taxItems =
      targetYearItems.filter(
        (item) =>
          item.isTaxRelated
      );

    console.log(
      `    ${allItems.length} décision(s) trouvée(s)`
    );

    console.log(
      `    ${targetYearItems.length} décision(s) de ${TARGET_YEAR}`
    );

    console.log(
      `    ${taxItems.length} décision(s) fiscale(s) trouvée(s)`
    );

    if (taxItems.length) {
      console.log(
        `\n    ===== DÉTECTIONS FISCALES =====`
      );

      for (const item of taxItems) {
        console.log(
          `    DATE : ${
            item.date.slice(0, 10)
          }`
        );

        console.log(
          `    TITRE : ${item.title}`
        );

        console.log(
          `    MATIÈRE : ${
            item.matiere ||
            'NON IDENTIFIÉE'
          }`
        );

        console.log(
          `    URL : ${item.url}`
        );

        console.log(
          `    ----------------------------------------`
        );
      }

      console.log(
        `    ===== FIN DÉTECTIONS FISCALES =====\n`
      );
    }

    const nextPage =
      findNextPageUrl(
        $,
        url
      );

    return {
      allItems,
      taxItems,
      targetYearItems,
      nextPage,
    };
  } finally {
    await page.close();
  }
}


/* =========================================================
   PARCOURS DES PAGES 2026
   ========================================================= */

async function scrapeDecisionsForYear(
  browser,
  slug
) {
  const taxItems = [];

  let currentUrl =
    `${BASE}/${slug}/decisions`;

  let pageNumber = 1;

  const visited =
    new Set();

  while (
    currentUrl &&
    !visited.has(currentUrl)
  ) {
    visited.add(currentUrl);

    const result =
      await scrapeDecisionPage(
        browser,
        currentUrl,
        slug,
        pageNumber
      );

    taxItems.push(
      ...result.taxItems
    );

    /*
     * On continue tant que la page contient
     * encore des décisions de 2026.
     */
    if (
      result.targetYearItems.length === 0
    ) {
      console.log(
        `    Fin des décisions ${TARGET_YEAR}.`
      );

      break;
    }

    if (!result.nextPage) {
      console.log(
        `    Plus de page disponible.`
      );

      break;
    }

    currentUrl =
      result.nextPage;

    pageNumber++;

    await sleep(
      DELAY_BETWEEN_PAGES_MS
    );

    if (pageNumber > 100) {
      console.log(
        `    Limite de sécurité atteinte.`
      );

      break;
    }
  }

  return taxItems;
}


/* =========================================================
   DÉDOUBLONNAGE
   ========================================================= */

function dedupeItems(items) {
  const map = new Map();

  for (const item of items) {
    const key =
      item.url ||
      `${item.title}|${item.date}`;

    if (!map.has(key)) {
      map.set(key, item);
    }
  }

  return [
    ...map.values(),
  ].sort(
    (a, b) =>
      (b.date || '').localeCompare(
        a.date || ''
      )
  );
}


/* =========================================================
   MAIN
   ========================================================= */

async function main() {
  const communes =
    JSON.parse(
      await fs.readFile(
        COMMUNES_FILE,
        'utf-8'
      )
    );

  /*
   * =======================================================
   * TEST UNIQUEMENT LIÈGE
   * =======================================================
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
      const {
        slug,
        name,
      } of communesATester
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

        const filtered =
          dedupeItems(
            decisions
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
          `\n  ✓ ${filtered.length} règlement(s)/décision(s) fiscal(aux) conservé(s) pour ${name}`
        );

        console.log(
          `  IMPORTANT : test limité à Liège.`
        );
      } catch (error) {
        console.error(
          `  ✗ erreur pour ${name} : ${error.message}`
        );

        output[name] = {
          updatedAt:
            new Date().toISOString(),

          reglementsEnVigueur: [],

          prochainesTaxes: [],

          error: error.message,
        };
      }
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
    `\nTerminé. Écrit dans : ${OUTPUT_FILE}`
  );
}


main().catch(
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
