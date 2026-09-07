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

const USER_AGENT =
  'VeilleFiscaleCommunale-bot/1.0';

const TARGET_YEAR = 2026;

const PAGE_TIMEOUT_MS = 30000;
const RENDER_WAIT_MS = 2000;
const DELAY_BETWEEN_PAGES_MS = 300;

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

/*
 * IMPORTANT :
 * On utilise des mots entiers.
 *
 * Cela évite par exemple que "Philippet" soit détecté
 * comme fiscal parce qu'il contient "ipp".
 */
const TAX_PATTERNS = [
  /\btaxe\b/i,
  /\btaxes\b/i,
  /\btaxe[- ]communale\b/i,
  /\brèglement[- ]taxe\b/i,
  /\brèglement[- ]taxes\b/i,
  /\bredevance\b/i,
  /\bredevances\b/i,
  /\bprécompte\b/i,
  /\bprecompte\b/i,
  /\bimpôt\b/i,
  /\bimpots?\b/i,
  /\badditionnels?\b/i,
  /\bcentimes additionnels\b/i,
  /\bfiscal\b/i,
  /\bfiscale\b/i,
  /\bfiscaux\b/i,
  /\bfiscalité\b/i,
  /\bimposition\b/i,
  /\bimpositions\b/i,
  /\bIPP\b/i,
  /\bpersonnes physiques\b/i,
  /\bpersonnes morales\b/i,
  /\bpatrimoine\b/i,
  /\bforce motrice\b/i,
  /\benseigne\b/i,
  /\bterrasse\b/i,
  /\boccupation du domaine public\b/i,
  /\bstationnement\b/i,
  /\bparking\b/i,
  /\bimmondices\b/i,
  /\bdéchets\b/i,
  /\bdéchets ménagers\b/i,
];

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

  return (
    date.getUTCFullYear() === TARGET_YEAR
  );
}

/**
 * Détermine si un texte contient réellement
 * un indice fiscal.
 */
function isTaxRelated(text) {
  const normalized =
    normalizeForSearch(text);

  return TAX_PATTERNS.some(
    (pattern) =>
      pattern.test(normalized)
  );
}

/**
 * Retourne les informations contenues dans
 * le conteneur DIRECT d'une décision.
 *
 * On évite volontairement de prendre toute la page.
 */
function getDecisionContainer($, el) {
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
   * Fallback : on remonte seulement quelques niveaux.
   */
  let current = $(el);

  for (let i = 0; i < 4; i++) {
    current = current.parent();

    if (!current.length) {
      break;
    }

    const text =
      normalizeText(
        current.text()
      );

    if (
      text.length >= 20 &&
      text.length <= 1500
    ) {
      return current;
    }
  }

  return $(el);
}

/**
 * Extrait le numéro de décision depuis
 * le conteneur.
 */
function extractDecisionNumber(text) {
  const match = normalizeText(text).match(
    /\b(\d{1,4})\s*$/
  );

  return match
    ? match[1]
    : null;
}

/**
 * Extrait la matière.
 */
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
      return normalizeText(
        match[1]
      );
    }
  }

  return null;
}

/**
 * Extrait le titre réel.
 *
 * Exemple :
 * "Projet de décision Modification du règlement-taxe
 * relatif à ..."
 *
 * On retire les informations de matière/mandataire.
 */
function extractDecisionTitle(
  $,
  el,
  slugPart,
  containerText
) {
  const directText =
    normalizeText(
      $(el).text()
    );

  const candidates = [];

  if (directText) {
    candidates.push(
      directText
    );
  }

  const ariaLabel =
    normalizeText(
      $(el).attr('aria-label')
    );

  if (ariaLabel) {
    candidates.push(
      ariaLabel
    );
  }

  const titleAttribute =
    normalizeText(
      $(el).attr('title')
    );

  if (titleAttribute) {
    candidates.push(
      titleAttribute
    );
  }

  if (containerText) {
    candidates.push(
      containerText
    );
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
     * Retire la matière et le mandataire
     * lorsqu'ils sont collés au titre.
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
      candidate.replace(
        /^\d+\s+/,
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

    if (candidate.length > 600) {
      continue;
    }

    /*
     * Si le candidat commence par "Projet de décision",
     * on le conserve : le véritable intitulé est juste après.
     */
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

/**
 * Extrait toutes les décisions présentes
 * sur la page.
 */
function extractAllDecisions(
  $,
  slug
) {
  const found = [];

  const pointLinkRegex =
    new RegExp(
      `/${slug}/decisions/[^/]+/[^/"?#]+`,
      'i'
    );

  const seenUrls =
    new Set();

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
        seenUrls.has(
          absoluteUrl
        )
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

      const date =
        parseDateFromSlug(
          href
        );

      /*
       * Pour déterminer si la décision est
       * pertinente, on travaille uniquement
       * avec son propre conteneur.
       */
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

      /*
       * On cherche les indices fiscaux
       * dans le TITRE + MATIÈRE + URL.
       *
       * On n'utilise PAS le reste de la page.
       */
      const searchableText = [
        title,
        matiere || '',
        slugPart,
      ].join(' ');

      const fiscal =
        isTaxRelated(
          searchableText
        );

      found.push({
        title,
        url: absoluteUrl,
        matiere,
        date: date
          ? date.toISOString()
          : null,
        isTaxRelated: fiscal,
      });
    }
  );

  return found;
}

/**
 * Pagination deliberations.be.
 */
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
        start:
          Number(match[1]),
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
          item.start >
          currentStart
      )
      .sort(
        (a, b) =>
          a.start - b.start
      )[0];

  if (!next) {
    return null;
  }

  return next.href.startsWith(
    'http'
  )
    ? next.href
    : `${BASE}${next.href}`;
}

/**
 * Charge une page.
 */
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
          waitUntil:
            'networkidle2',
          timeout:
            PAGE_TIMEOUT_MS,
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
            item.date
              ? new Date(
                  item.date
                )
              : null
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

    /*
     * Affichage uniquement des décisions
     * détectées comme fiscales.
     */
    if (
      taxItems.length
    ) {
      console.log(
        `\n    ===== DÉTECTIONS FISCALES =====`
      );

      for (
        const item
        of taxItems
      ) {
        console.log(
          `    DATE : ${
            item.date
              ? item.date.slice(
                  0,
                  10
                )
              : 'SANS DATE'
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

/**
 * Parcourt toutes les pages contenant
 * des décisions 2026.
 */
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
    !visited.has(
      currentUrl
    )
  ) {
    visited.add(
      currentUrl
    );

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
     * Tant qu'il existe des décisions 2026,
     * on continue.
     */
    if (
      result.targetYearItems.length === 0
    ) {
      console.log(
        `    Fin des décisions ${TARGET_YEAR}.`
      );

      break;
    }

    if (
      !result.nextPage
    ) {
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

    if (
      pageNumber > 100
    ) {
      console.log(
        `    Limite de sécurité atteinte.`
      );

      break;
    }
  }

  return taxItems;
}

/**
 * Déduplication.
 */
function dedupeItems(items) {
  const map =
    new Map();

  for (const item of items) {
    const key =
      item.url ||
      `${item.title}|${item.date}`;

    const existing =
      map.get(key);

    if (!existing) {
      map.set(
        key,
        item
      );
      continue;
    }

    const existingDate =
      existing.date
        ? new Date(
            existing.date
          ).getTime()
        : 0;

    const itemDate =
      item.date
        ? new Date(
            item.date
          ).getTime()
        : 0;

    if (
      itemDate >
      existingDate
    ) {
      map.set(
        key,
        item
      );
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

/**
 * Main
 */
async function main() {
  const communes =
    JSON.parse(
      await fs.readFile(
        COMMUNES_FILE,
        'utf-8'
      )
    );

  /*
   * TEST UNIQUEMENT LIÈGE.
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
      }
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
                titre:
                  title,
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

          error:
            error.message,
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
    console.error(
      error
    );

    process.exit(1);
  }
);
