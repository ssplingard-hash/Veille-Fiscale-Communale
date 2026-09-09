import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

const TARGET_YEAR = 2026;
const BASE_URL = 'https://www.deliberations.be';

const COMMUNES = [
  {
    slug: 'liege',
    name: 'Liège'
  }
];

const MONTHS = {
  janvier: 0,
  fevrier: 1,
  mars: 2,
  avril: 3,
  mai: 4,
  juin: 5,
  juillet: 6,
  aout: 7,
  septembre: 8,
  octobre: 9,
  novembre: 10,
  decembre: 11
};

function normalizeText(value = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value = '') {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDateFromSlug(url) {
  const match = url.match(
    /\/(\d{1,2})-([a-zA-Zéèêëàâäîïôöùûüç]+)-(\d{4})-\d{2}-\d{2}/
  );

  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const monthName = normalizeText(match[2]);
  const year = Number(match[3]);

  const month = MONTHS[monthName];

  if (month === undefined) {
    return null;
  }

  return new Date(year, month, day);
}

/*
 * ============================================================
 * EXTRACTION DES LIENS DE DÉCISIONS
 * ============================================================
 */

async function extractDecisionLinks(page) {
  return await page.evaluate(() => {
    const results = [];

    const links = Array.from(
      document.querySelectorAll('a[href]')
    );

    for (const link of links) {
      const href = link.href || '';

      if (!href.includes('/decisions/')) {
        continue;
      }

      if (href.includes('@@faceted_query')) {
        continue;
      }

      const text =
        link.innerText ||
        link.textContent ||
        '';

      results.push({
        url: href,
        text: text.trim()
      });
    }

    return results;
  });
}

/*
 * ============================================================
 * DÉDOUBLONNAGE
 * ============================================================
 */

function dedupe(items) {
  const map = new Map();

  for (const item of items) {
    if (!item.url) {
      continue;
    }

    if (!map.has(item.url)) {
      map.set(item.url, item);
    }
  }

  return Array.from(map.values());
}

/*
 * ============================================================
 * EXTRACTION DES DÉTAILS D'UNE DÉCISION
 * ============================================================
 */

async function extractDecisionDetails(page, decision) {
  try {
    await page.goto(decision.url, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await new Promise(resolve => {
      setTimeout(resolve, 500);
    });

    return await page.evaluate(fallbackTitle => {

      function clean(value) {
        return (value || '')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }

      const bodyElement = document.body;

      const bodyText = clean(
        bodyElement
          ? bodyElement.innerText || ''
          : ''
      );

      /*
       * --------------------------------------------------------
       * TITRE
       * --------------------------------------------------------
       */

      let title = '';

      const h1 = document.querySelector('h1');

      if (h1) {
        title = clean(
          h1.innerText ||
          h1.textContent
        );
      }

      if (!title) {
        const ogTitle =
          document.querySelector(
            'meta[property="og:title"]'
          );

        if (ogTitle) {
          title = clean(
            ogTitle.getAttribute('content')
          );
        }
      }

      if (!title) {
        const titleTag =
          document.querySelector('title');

        if (titleTag) {
          title = clean(
            titleTag.innerText ||
            titleTag.textContent
          );
        }
      }

      /*
       * --------------------------------------------------------
       * MATIÈRE
       * --------------------------------------------------------
       *
       * On cherche plusieurs structures possibles.
       */

      let matiere = '';

      const lines = bodyText
        .split('\n')
        .map(line => clean(line))
        .filter(Boolean);

      for (let i = 0; i < lines.length; i++) {

        const line = lines[i];

        /*
         * Exemple :
         * Matière : Finances
         */
        const inlineMatch = line.match(
          /^mati[eè]re\s*[:\-]\s*(.+)$/i
        );

        if (inlineMatch) {
          matiere = clean(
            inlineMatch[1]
          );

          break;
        }

        /*
         * Exemple :
         *
         * Matière
         * Finances
         */
        if (
          /^mati[eè]re$/i.test(line)
        ) {
          if (lines[i + 1]) {
            matiere = clean(
              lines[i + 1]
            );

            break;
          }
        }
      }

      /*
       * Recherche également dans les éléments HTML
       * dont le texte contient "Matière".
       */

      if (!matiere) {

        const elements =
          Array.from(
            document.querySelectorAll('*')
          );

        for (const element of elements) {

          const text =
            clean(
              element.innerText ||
              element.textContent
            );

          if (!text) {
            continue;
          }

          const match = text.match(
            /^mati[eè]re\s*[:\-]\s*(.+)$/i
          );

          if (match) {

            matiere = clean(
              match[1]
            );

            break;
          }
        }
      }

      return {
        title:
          clean(title) ||
          clean(fallbackTitle),

        matiere:
          clean(matiere),

        bodyText
      };

    }, decision.text);

  } catch (error) {

    console.log(
      `  ⚠ Erreur lors de la lecture : ${error.message}`
    );

    return {
      title: decision.text || '',
      matiere: '',
      bodyText: ''
    };
  }
}

/*
 * ============================================================
 * CLASSIFICATION FISCALE
 * ============================================================
 *
 * IMPORTANT :
 *
 * On ne considère PAS "IPP" comme fiscal si le terme apparaît
 * simplement à l'intérieur d'un autre mot.
 *
 * Exemple :
 * "Philippet" ne doit PAS être détecté comme "IPP".
 */

/*
 * Termes très explicites.
 */
const STRONG_TAX_PATTERNS = [

  /\breglement[- ]taxe\b/,
  /\breglement[- ]taxes\b/,

  /\breglement[- ]redevance\b/,
  /\breglement[- ]redevances\b/,

  /\breglement fiscal\b/,
  /\breglement de taxation\b/,

  /\bprecompte immobilier\b/,
  /\bprecompte\b/,

  /\bcentimes additionnels\b/,

  /\badditionnels a l ipp\b/,

  /\bimpot des personnes physiques\b/,
  /\bimpot des personnes morales\b/,

  /\bforce motrice\b/,

  /\btaxe\b/,
  /\btaxes\b/,

  /\bredevance\b/,
  /\bredevances\b/,

  /\bfiscalite\b/,
  /\bfiscale\b/,
  /\bfiscal\b/,

  /\bimposition\b/,
  /\bimpositions\b/
];

/*
 * Termes qui peuvent signaler une taxe mais qui ne suffisent
 * pas seuls.
 */
const TAX_CONTEXT_PATTERNS = [

  /\bdechets\b/,
  /\bimmondices\b/,

  /\bseconde residence\b/,

  /\benseigne\b/,
  /\benseignes\b/,

  /\bpublicite\b/,
  /\bpublicitaire\b/,

  /\boccupation du domaine public\b/,

  /\bsurface commerciale\b/,
  /\bsurfaces commerciales\b/
];

/*
 * Faux positifs à exclure.
 */
const EXCLUDED_PATTERNS = [

  /\bmarche public\b/,
  /\bmarches publics\b/,

  /\bpersonnel\b/,
  /\brecrutement\b/,

  /\bsubvention\b/,
  /\bsubventions\b/,

  /\bcompte annuel\b/,
  /\bcomptes annuels\b/,

  /\bbudget\b/,

  /\bfabrique d eglise\b/,

  /\bcirculation\b/,

  /\bstationnement reserve\b/,

  /\bpersonnes handicapees\b/,

  /\blimitation de la vitesse\b/,

  /\bzone de stationnement\b/,

  /\binterdiction d acces\b/
];

function classifyFiscal(
  title,
  matiere,
  url,
  bodyText
) {

  const titleNorm =
    normalizeText(title);

  const matiereNorm =
    normalizeText(matiere);

  const urlNorm =
    normalizeText(url);

  const bodyNorm =
    normalizeText(bodyText);

  /*
   * ----------------------------------------------------------
   * 1. EXCLUSIONS
   * ----------------------------------------------------------
   */

  for (
    const pattern of EXCLUDED_PATTERNS
  ) {

    if (pattern.test(titleNorm)) {

      /*
       * Exception :
       * un règlement-taxe reste fiscal.
       */

      if (
        !/\breglement[- ]taxe\b/.test(titleNorm) &&
        !/\breglement[- ]taxes\b/.test(titleNorm) &&
        !/\breglement[- ]redevance\b/.test(titleNorm) &&
        !/\breglement fiscal\b/.test(titleNorm)
      ) {

        return {
          fiscal: false,
          reason: 'terme excluant'
        };
      }
    }
  }

  /*
   * ----------------------------------------------------------
   * 2. TITRE
   * ----------------------------------------------------------
   */

  for (
    const pattern of STRONG_TAX_PATTERNS
  ) {

    if (pattern.test(titleNorm)) {

      return {
        fiscal: true,
        reason: 'terme fiscal explicite dans le titre'
      };
    }
  }

  /*
   * ----------------------------------------------------------
   * 3. MATIÈRE
   * ----------------------------------------------------------
   *
   * Finances seul n'est volontairement PAS considéré comme
   * fiscal.
   */

  if (
    /\bfiscal/.test(matiereNorm) ||
    /\btax/.test(matiereNorm) ||
    /\bimpot/.test(matiereNorm) ||
    /\bredevance/.test(matiereNorm) ||
    /\bprecompte/.test(matiereNorm)
  ) {

    return {
      fiscal: true,
      reason: 'matière fiscale'
    };
  }

  /*
   * ----------------------------------------------------------
   * 4. URL
   * ----------------------------------------------------------
   */

  const URL_TAX_PATTERNS = [

    /\breglement[- ]taxe\b/,
    /\breglement[- ]redevance\b/,
    /\bprecompte\b/,
    /\bipp\b/,
    /\bfiscal/,
    /\btaxe\b/,
    /\bredevance\b/
  ];

  for (
    const pattern of URL_TAX_PATTERNS
  ) {

    if (pattern.test(urlNorm)) {

      return {
        fiscal: true,
        reason: 'terme fiscal dans URL'
      };
    }
  }

  /*
   * ----------------------------------------------------------
   * 5. CONTENU
   * ----------------------------------------------------------
   *
   * Ici on cherche des combinaisons suffisamment fortes.
   */

  const strongBodyPatterns = [

    /\breglement[- ]taxe\b/,
    /\breglement de taxation\b/,
    /\breglement[- ]redevance\b/,

    /\bprecompte immobilier\b/,

    /\bcentimes additionnels\b/,

    /\badditionnels a l ipp\b/,

    /\bimpot des personnes physiques\b/,

    /\bimpot des personnes morales\b/,

    /\bforce motrice\b/,

    /\bperception de la taxe\b/,

    /\btaux de la taxe\b/,

    /\btaux de taxe\b/,

    /\brecette fiscale\b/,
    /\brecettes fiscales\b/
  ];

  let strongHits = 0;

  for (
    const pattern of strongBodyPatterns
  ) {

    if (pattern.test(bodyNorm)) {
      strongHits++;
    }
  }

  /*
   * Plusieurs indices forts.
   */
  if (strongHits >= 2) {

    return {
      fiscal: true,
      reason: 'plusieurs indices fiscaux dans le contenu'
    };
  }

  /*
   * Règlement + taxe/redevance.
   */
  if (
    /\breglement\b/.test(bodyNorm) &&
    (
      /\btaxe\b/.test(bodyNorm) ||
      /\btaxes\b/.test(bodyNorm) ||
      /\bredevance\b/.test(bodyNorm) ||
      /\bredevances\b/.test(bodyNorm)
    )
  ) {

    return {
      fiscal: true,
      reason: 'règlement + taxe/redevance dans le contenu'
    };
  }

  /*
   * ----------------------------------------------------------
   * 6. CONTEXTE
   * ----------------------------------------------------------
   *
   * Un terme comme "déchets" ou "enseigne" ne suffit pas.
   * Il faut également un indice fiscal explicite.
   */

  const hasContext =
    TAX_CONTEXT_PATTERNS.some(
      pattern =>
        pattern.test(titleNorm)
    );

  const hasFiscalIndicator =
    (
      /\btaxe\b/.test(titleNorm) ||
      /\btaxes\b/.test(titleNorm) ||
      /\bredevance\b/.test(titleNorm) ||
      /\bredevances\b/.test(titleNorm) ||
      /\bprecompte\b/.test(titleNorm) ||
      /\badditionnel\b/.test(titleNorm) ||
      /\bfiscal\b/.test(titleNorm) ||
      /\bfiscale\b/.test(titleNorm) ||
      /\bimposition\b/.test(titleNorm)
    );

  if (
    hasContext &&
    hasFiscalIndicator
  ) {

    return {
      fiscal: true,
      reason: 'contexte fiscal dans le titre'
    };
  }

  /*
   * ----------------------------------------------------------
   * 7. NON FISCAL
   * ----------------------------------------------------------
   */

  return {
    fiscal: false,
    reason: 'aucun indice fiscal suffisamment fiable'
  };
}

/*
 * ============================================================
 * SCRAPING DE LIÈGE
 * ============================================================
 */

async function scrapeCommune(
  browser,
  commune
) {

  const page =
    await browser.newPage();

  page.setDefaultNavigationTimeout(
    60000
  );

  const queue = [
    `${BASE_URL}/${commune.slug}/decisions`
  ];

  const visited =
    new Set();

  const allLinks = [];

  while (
    queue.length > 0
  ) {

    const url =
      queue.shift();

    if (
      visited.has(url)
    ) {
      continue;
    }

    visited.add(url);

    console.log('');
    console.log(
      `Page ${visited.size}`
    );

    console.log(
      `  → ${url}`
    );

    try {

      await page.goto(
        url,
        {
          waitUntil: 'networkidle2',
          timeout: 60000
        }
      );

      await new Promise(resolve => {
        setTimeout(resolve, 500);
      });

      /*
       * Décisions.
       */

      const links =
        await extractDecisionLinks(
          page
        );

      const yearLinks =
        links.filter(link => {

          const date =
            parseDateFromSlug(
              link.url
            );

          return (
            date &&
            date.getFullYear() ===
              TARGET_YEAR
          );
        });

      console.log(
        `  ${links.length} lien(s) de décision`
      );

      console.log(
        `  ${yearLinks.length} décision(s) ${TARGET_YEAR}`
      );

      allLinks.push(
        ...yearLinks
      );

      /*
       * Pagination.
       */

      const pagination =
        await page.evaluate(() => {

          return Array.from(
            document.querySelectorAll(
              'a[href*="@@faceted_query"]'
            )
          ).map(
            link => link.href
          );

        });

      const uniquePagination =
        [
          ...new Set(
            pagination
          )
        ];

      console.log(
        `  ${uniquePagination.length} pagination(s)`
      );

      for (
        const nextUrl of
          uniquePagination
      ) {

        if (
          !visited.has(nextUrl)
        ) {

          queue.push(
            nextUrl
          );
        }
      }

    } catch (error) {

      console.log(
        `  ⚠ Erreur : ${error.message}`
      );
    }
  }

  await page.close();

  return dedupe(
    allLinks
  );
}

/*
 * ============================================================
 * PROGRAMME PRINCIPAL
 * ============================================================
 */

async function main() {

  console.log(
    `Lancement du scraper fiscal - année ${TARGET_YEAR}`
  );

  console.log('');
  console.log(
    'TEST UNIQUEMENT : Liège'
  );

  const browser =
    await puppeteer.launch({
      headless: true,

      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--ignore-certificate-errors'
      ]
    });

  const outputPath =
    path.join(
      process.cwd(),
      'src',
      'data',
      'reglements-taxes.json'
    );

  let existingData = {};

  try {

    existingData =
      JSON.parse(
        fs.readFileSync(
          outputPath,
          'utf8'
        )
      );

  } catch {

    existingData = {};
  }

  for (
    const commune of
      COMMUNES
  ) {

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      `→ ${commune.name}`
    );

    console.log(
      '========================================'
    );

    /*
     * Récupération des décisions.
     */

    const decisions =
      await scrapeCommune(
        browser,
        commune
      );

    console.log('');
    console.log(
      `TOTAL : ${decisions.length} décision(s) ${TARGET_YEAR}`
    );

    /*
     * Sécurité.
     *
     * Si le scraper récupère trop peu de décisions,
     * on ne vide pas les données existantes.
     */

    if (
      decisions.length < 20
    ) {

      console.log('');
      console.log(
        '⚠️ PROTECTION ACTIVÉE'
      );

      console.log(
        'Moins de 20 décisions récupérées.'
      );

      console.log(
        'Les données existantes ne sont PAS écrasées.'
      );

      continue;
    }

    /*
     * ========================================================
     * ANALYSE DES DÉCISIONS
     * ========================================================
     */

    const detailPage =
      await browser.newPage();

    detailPage.setDefaultNavigationTimeout(
      60000
    );

    const fiscalDecisions = [];

    for (
      let i = 0;
      i < decisions.length;
      i++
    ) {

      const decision =
        decisions[i];

      console.log(
        `Analyse ${i + 1}/${decisions.length}`
      );

      const details =
        await extractDecisionDetails(
          detailPage,
          decision
        );

      const classification =
        classifyFiscal(
          details.title,
          details.matiere,
          decision.url,
          details.bodyText
        );

      console.log(
        `  TITRE   : ${details.title}`
      );

      console.log(
        `  MATIERE : ${
          details.matiere ||
          '[VIDE]'
        }`
      );

      console.log(
        `  FISCAL  : ${
          classification.fiscal
            ? 'OUI'
            : 'NON'
        }`
      );

      if (
        classification.fiscal
      ) {

        console.log(
          `  RAISON  : ${
            classification.reason
          }`
        );

        const date =
          parseDateFromSlug(
            decision.url
          );

        fiscalDecisions.push({

          date:
            date
              ? date
                  .toISOString()
                  .slice(0, 10)
              : null,

          titre:
            details.title,

          matiere:
            details.matiere || '',

          url:
            decision.url
        });
      }
    }

    await detailPage.close();

    /*
     * ========================================================
     * RÉSULTAT
     * ========================================================
     */

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      `${fiscalDecisions.length} décision(s) fiscale(s) détectée(s)`
    );

    console.log(
      '========================================'
    );

    for (
      const item of
        fiscalDecisions
    ) {

      console.log('');

      console.log(
        `DATE    : ${item.date}`
      );

      console.log(
        `TITRE   : ${item.titre}`
      );

      console.log(
        `MATIERE : ${item.matiere}`
      );

      console.log(
        `URL     : ${item.url}`
      );
    }

    /*
     * ========================================================
     * SAUVEGARDE
     * ========================================================
     */

    existingData[
      commune.name
    ] = {

      updatedAt:
        new Date().toISOString(),

      reglementsEnVigueur:
        fiscalDecisions,

      prochainesTaxes: []
    };
  }

  /*
   * Écriture du fichier JSON.
   */

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      existingData,
      null,
      2
    ),
    'utf8'
  );

  await browser.close();

  console.log('');
  console.log(
    `✓ Fichier mis à jour : ${outputPath}`
  );

  console.log('');
  console.log(
    '✓ Scraping terminé.'
  );
}

/*
 * ============================================================
 * GESTION DES ERREURS
 * ============================================================
 */

main().catch(error => {

  console.error('');
  console.error(
    '❌ ERREUR FATALE'
  );

  console.error(
    error
  );

  process.exit(1);
});
