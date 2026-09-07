/**
 * Scraper quotidien : règlements-taxes en vigueur pour les communes wallonnes
 * référencées sur https://www.deliberations.be
 *
 * VERSION PUPPETEER + DIAGNOSTIC LIÈGE
 *
 * TEST TEMPORAIRE :
 * - uniquement Liège
 * - année cible : 2026
 * - pagination complète
 * - affichage détaillé des décisions 2026 pour analyser
 *   la structure réelle des données de deliberations.be
 *
 * Sortie : src/data/reglements-taxes.json
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
  'VeilleFiscaleCommunale-bot/1.0 (+contact: voir depot GitHub)';

/*
 * Mots-clés utilisés pour la détection fiscale.
 *
 * IMPORTANT :
 * Ce n'est PAS encore la solution définitive.
 * Le diagnostic ci-dessous va nous permettre de voir
 * si les informations fiscales se trouvent ailleurs
 * dans la page que le simple titre du lien.
 */
const TAX_KEYWORDS =
  /(taxe|taxes|précompte|precompte|impôt|impot|ipp|redevance|fiscal|fiscale|fiscaux|imposition|taxation|centime|centimes|additionnel|additionnels|déchets|déchet|stationnement|occupation|enseigne|publicité|séjour|égout|égouts|immondices|piscine|parking)/i;

const PAGE_TIMEOUT_MS = 30000;
const RENDER_WAIT_MS = 2500;
const DELAY_BETWEEN_PAGES_MS = 300;
const DELAY_BETWEEN_COMMUNES_MS = 500;

const TARGET_YEAR = 2026;


/* ============================================================
   OUTILS
   ============================================================ */

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
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}


/* ============================================================
   DATE
   ============================================================ */

function parseDateFromSlug(slug) {
  const m = slug.match(
    /(\d{1,2})-([a-zéûà]+)-(\d{4})/i
  );

  if (!m) return null;

  const [, day, monthName, year] = m;

  const month =
    MONTHS_FR[monthName.toLowerCase()];

  if (month === undefined) return null;

  const d = new Date(
    Date.UTC(
      Number(year),
      month,
      Number(day)
    )
  );

  return isNaN(d.getTime())
    ? null
    : d;
}


/* ============================================================
   NORMALISATION
   ============================================================ */

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(
      /[\u0300-\u036f]/g,
      ''
    )
    .replace(
      /exercices?\s*\d{4}(\s*(a|à)\s*\d{4})?/g,
      ''
    )
    .replace(
      /[^a-z0-9]+/g,
      ' '
    )
    .trim();
}


/* ============================================================
   DÉDOUBLONNAGE
   ============================================================ */

function dedupeKeepLatest(items) {
  const byKey = new Map();

  for (const item of items) {
    const key = normalizeTitle(
      item.title || ''
    );

    const existing =
      byKey.get(key);

    if (!existing) {
      byKey.set(key, item);
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
      byKey.set(
        key,
        item
      );
    }
  }

  return [
    ...byKey.values(),
  ].sort(
    (a, b) =>
      (b.date || '').localeCompare(
        a.date || ''
      )
  );
}


/* ============================================================
   EXTRACTION DU CONTEXTE D'UNE DÉCISION
   ============================================================ */

/**
 * Essaie de récupérer le texte réellement associé
 * à une décision.
 *
 * deliberations.be semble utiliser plusieurs niveaux
 * de conteneurs autour du lien.
 *
 * On teste plusieurs niveaux afin de récupérer :
 * - le titre
 * - la matière
 * - le texte descriptif
 */
function extractDecisionContext($, el) {
  const contexts = [];

  let current = $(el);

  for (
    let level = 0;
    level < 6;
    level++
  ) {
    if (!current.length) break;

    const text =
      current
        .text()
        .replace(/\s+/g, ' ')
        .trim();

    if (
      text &&
      !contexts.includes(text)
    ) {
      contexts.push(text);
    }

    current =
      current.parent();
  }

  return contexts;
}


/* ============================================================
   EXTRACTION TITRE / MATIÈRE
   ============================================================ */

function extractTitleAndMatiere(
  $,
  el,
  slugPart
) {
  const contexts =
    extractDecisionContext(
      $,
      el
    );

  let title =
    $(el)
      .text()
      .replace(/\s+/g, ' ')
      .trim();

  /*
   * Certains liens peuvent simplement afficher
   * "PROJET DE DÉCISION".
   *
   * On cherche alors les éléments de titre autour du lien.
   */
  if (
    !title ||
    /projet de décision/i.test(title)
  ) {
    const nearby =
      $(el)
        .closest(
          'article, li, section, div'
        );

    const candidateSelectors = [
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      '[class*="title"]',
      '[class*="titre"]',
      '[class*="subject"]',
      '[class*="matiere"]',
    ];

    for (
      const selector
      of candidateSelectors
    ) {
      const candidate =
        nearby
          .find(selector)
          .filter((_, node) => {
            return node !== el;
          })
          .first()
          .text()
          .replace(/\s+/g, ' ')
          .trim();

      if (
        candidate &&
        !/projet de décision/i.test(
          candidate
        )
      ) {
        title = candidate;
        break;
      }
    }
  }

  /*
   * Si aucun titre clair n'a été trouvé,
   * on utilise le slug de l'URL.
   */
  if (
    !title ||
    /projet de décision/i.test(title)
  ) {
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

  /*
   * Recherche de la matière dans les différents
   * contextes disponibles.
   */
  let matiere = null;

  for (
    const context
    of contexts
  ) {
    const match =
      context.match(
        /Mati[eè]re\s*:?\s*(.+?)(?=\s+(?:Décision|Date|N°|Numéro|Index)\b|$)/i
      );

    if (
      match &&
      match[1]
    ) {
      matiere =
        match[1]
          .replace(/\s+/g, ' ')
          .trim();

      break;
    }
  }

  return {
    title,
    matiere,
    contexts,
  };
}


/* ============================================================
   EXTRACTION DE TOUTES LES DÉCISIONS
   ============================================================ */

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
        $(el).attr('href') ||
        '';

      if (
        !pointLinkRegex.test(
          href
        )
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
          .pop() ||
        '';

      const extracted =
        extractTitleAndMatiere(
          $,
          el,
          slugPart
        );

      const title =
        extracted.title;

      const matiere =
        extracted.matiere;

      /*
       * Pour la détection fiscale,
       * on teste plusieurs informations :
       * - slug URL
       * - titre
       * - matière
       * - contexte autour de la décision
       */
      const searchableText =
        [
          slugPart,
          title,
          matiere,
          ...extracted.contexts,
        ]
          .filter(Boolean)
          .join(' ');

      const isTaxRelated =
        TAX_KEYWORDS.test(
          searchableText
        );

      const date =
        parseDateFromSlug(
          href
        );

      found.push({
        title,
        url: absoluteUrl,
        matiere,
        date: date
          ? date.toISOString()
          : null,
        isTaxRelated,
        diagnosticContext:
          extracted.contexts,
      });
    }
  );

  return found;
}


/* ============================================================
   PAGINATION
   ============================================================ */

function findNextPageUrl(
  $,
  currentUrl
) {
  const candidates = [];

  $('a[href]').each(
    (_, el) => {
      const href =
        $(el).attr('href') ||
        '';

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

      if (!match) return;

      const start =
        Number(match[1]);

      candidates.push({
        start,
        href,
      });
    }
  );

  if (
    !candidates.length
  ) {
    return null;
  }

  const currentMatch =
    currentUrl.match(
      /b_start(?::int)?=(\d+)/i
    );

  const currentStart =
    currentMatch
      ? Number(
          currentMatch[1]
        )
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
          a.start -
          b.start
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


/* ============================================================
   PAGE DE DÉCISIONS
   ============================================================ */

async function scrapeDecisionPage(
  browser,
  url,
  slug
) {
  const page =
    await browser.newPage();

  await page.setUserAgent(
    USER_AGENT
  );

  await page.setExtraHTTPHeaders({
    'Accept-Language':
      'fr',
  });

  try {
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
      response.status() ===
        404
    ) {
      return {
        allItems: [],
        taxItems: [],
        nextPage: null,
        targetYearItems: [],
      };
    }

    if (
      response &&
      !response.ok() &&
      response.status() !==
        200
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
      cheerio.load(
        html
      );

    const allItems =
      extractAllDecisions(
        $,
        slug
      );

    const targetYearItems =
      allItems.filter(
        (item) => {
          if (!item.date) {
            return false;
          }

          return (
            new Date(
              item.date
            ).getUTCFullYear() ===
            TARGET_YEAR
          );
        }
      );

    /*
     * ========================================================
     * DIAGNOSTIC LIÈGE
     * ========================================================
     *
     * On affiche les décisions 2026 afin de voir
     * exactement ce que le scraper récupère.
     */
    if (
      slug === 'liege'
    ) {
      console.log(
        `\n    ========================================================`
      );

      console.log(
        `    DÉCISIONS ${TARGET_YEAR} DE LIÈGE`
      );

      console.log(
        `    ========================================================`
      );

      targetYearItems.forEach(
        (
          item,
          index
        ) => {
          console.log(
            `\n    [${index + 1}]`
          );

          console.log(
            `    Date     : ${
              item.date
                ? item.date.slice(
                    0,
                    10
                  )
                : 'VIDE'
            }`
          );

          console.log(
            `    Titre    : ${
              item.title ||
              'VIDE'
            }`
          );

          console.log(
            `    Matière  : ${
              item.matiere ||
              'VIDE'
            }`
          );

          console.log(
            `    Fiscal   : ${
              item.isTaxRelated
                ? 'OUI'
                : 'NON'
            }`
          );

          console.log(
            `    URL      : ${item.url}`
          );

          /*
           * On n'affiche les contextes HTML que lorsque
           * le scraper considère actuellement la décision
           * comme NON fiscale.
           *
           * Cela évite de rendre le log inutilement énorme
           * pour les décisions déjà détectées.
           */
          if (
            !item.isTaxRelated &&
            item.diagnosticContext &&
            item.diagnosticContext.length
          ) {
            console.log(
              `    Contexte :`
            );

            item.diagnosticContext
              .slice(
                0,
                3
              )
              .forEach(
                (
                  context,
                  contextIndex
                ) => {
                  console.log(
                    `      ${
                      contextIndex + 1
                    }. ${context.slice(
                      0,
                      500
                    )}`
                  );
                }
              );
          }
        }
      );

      console.log(
        `\n    ========================================================`
      );

      console.log(
        `    FIN DU DIAGNOSTIC LIÈGE`
      );

      console.log(
        `    ========================================================\n`
      );
    }

    const taxItems =
      allItems
        .filter(
          (item) =>
            item.isTaxRelated
        )
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

    const nextPage =
      findNextPageUrl(
        $,
        url
      );

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
      target
