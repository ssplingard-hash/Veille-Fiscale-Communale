import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

const TARGET_YEAR = 2026;
const BASE_URL = 'https://www.deliberations.be';

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

const MONTHS = {
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
  décembre: 11
};

function parseDateFromSlug(url) {
  const match = url.match(
    /\/(\d{1,2})-([a-zA-Zéèêëàâäîïôöùûüç]+)-(\d{4})-\d{2}-\d{2}\//
  );

  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = MONTHS[normalizeText(match[2])];
  const year = Number(match[3]);

  if (month === undefined) {
    return null;
  }

  return new Date(year, month, day);
}

/*
 * IMPORTANT :
 * On récupère d'abord TOUS les liens /decisions/ présents
 * dans le HTML rendu par Chromium.
 *
 * On ne tente PAS encore de déterminer la matière ici.
 */
async function extractDecisionLinks(page) {
  return await page.evaluate(() => {
    function clean(value) {
      return (value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const results = [];

    for (const link of document.querySelectorAll('a[href]')) {
      const href = link.href || '';

      if (!href.includes('/decisions/')) {
        continue;
      }

      if (href.includes('@@faceted_query')) {
        continue;
      }

      const text = clean(
        link.innerText ||
        link.textContent ||
        ''
      );

      if (!text) {
        continue;
      }

      results.push({
        url: href,
        text
      });
    }

    return results;
  });
}

function dedupe(items) {
  const map = new Map();

  for (const item of items) {
    if (!map.has(item.url)) {
      map.set(item.url, item);
    }
  }

  return [...map.values()];
}

/*
 * Classification volontairement très stricte.
 *
 * On ne regarde QUE le titre de la décision.
 * On ne regarde surtout pas toute la page.
 */
const FISCAL_PATTERNS = [
  /\breglement[- ]taxe\b/,
  /\breglement[- ]taxes\b/,
  /\breglement[- ]de[- ]taxe\b/,
  /\breglement[- ]des[- ]taxes\b/,

  /\breglement[- ]redevance\b/,
  /\breglement[- ]redevances\b/,
  /\breglement[- ]de[- ]redevance\b/,
  /\breglement[- ]des[- ]redevances\b/,

  /\breglement fiscal\b/,
  /\breglement de taxation\b/,

  /\bprecompte immobilier\b/,
  /\bprecompte\b/,

  /\bcentimes additionnels\b/,
  /\badditionnels a l ipp\b/,

  /\bimpot des personnes physiques\b/,
  /\bimpot des personnes morales\b/,

  /\bforce motrice\b/,

  /\btaxe sur\b/,
  /\btaxe communale\b/,
  /\btaxe additionnelle\b/,
  /\btaxe locale\b/,

  /\bredevance sur\b/,
  /\bredevance communale\b/
];

const EXCLUDED_PATTERNS = [
  /\bbail commercial\b/,
  /\bbail-type\b/,
  /\bbail type\b/,
  /\bconvention de bail\b/,
  /\bemplacement de stationnement\b/,
  /\bstationnement non securise\b/,

  /\bmarche public\b/,
  /\bmarches publics\b/,

  /\bsubvention\b/,
  /\bsubventions\b/,

  /\bpersonnel\b/,
  /\brecrutement\b/,

  /\bcompte annuel\b/,
  /\bcomptes annuels\b/,

  /\bbudget\b/,

  /\bcirculation\b/,
  /\blimitation de la vitesse\b/,
  /\bzone 30\b/,
  /\bvoie du\b/
];

function classifyFiscal(title) {
  const normalized = normalizeText(title);

  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.test(normalized)) {
      return false;
    }
  }

  return FISCAL_PATTERNS.some(pattern =>
    pattern.test(normalized)
  );
}

async function scrapeLiege(browser) {
  const page = await browser.newPage();

  await page.setViewport({
    width: 1440,
    height: 1000
  });

  page.setDefaultNavigationTimeout(90000);

  const firstUrl =
    `${BASE_URL}/liege/decisions`;

  const queue = [firstUrl];
  const visited = new Set();

  const allDecisions = [];

  while (queue.length > 0) {
    const url = queue.shift();

    if (visited.has(url)) {
      continue;
    }

    visited.add(url);

    console.log('');
    console.log(`PAGE ${visited.size}`);
    console.log(`URL : ${url}`);

    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 90000
      });

      /*
       * Le site charge une partie du contenu en JS.
       * On attend suffisamment longtemps avant extraction.
       */
      await new Promise(resolve =>
        setTimeout(resolve, 2000)
      );

      /*
       * On attend explicitement que des liens /decisions/
       * existent dans le DOM.
       */
      try {
        await page.waitForFunction(
          () =>
            document.querySelectorAll(
              'a[href*="/decisions/"]'
            ).length > 0,
          {
            timeout: 30000
          }
        );
      } catch {
        console.log(
          '  ⚠ Aucun lien de décision détecté après attente'
        );
      }

      const links =
        await extractDecisionLinks(page);

      console.log(
        `  ${links.length} lien(s) de décision`
      );

      const yearLinks = links.filter(item => {
        const date =
          parseDateFromSlug(item.url);

        return (
          date &&
          date.getFullYear() === TARGET_YEAR
        );
      });

      console.log(
        `  ${yearLinks.length} décision(s) ${TARGET_YEAR}`
      );

      for (const item of yearLinks) {
        console.log(
          `    - ${item.text.substring(0, 180)}`
        );
      }

      allDecisions.push(...yearLinks);

      /*
       * Pagination :
       * on récupère toutes les URLs faceted_query
       * réellement présentes sur la page.
       */
      const pagination =
        await page.evaluate(() => {
          return [
            ...new Set(
              Array.from(
                document.querySelectorAll(
                  'a[href*="@@faceted_query"]'
                )
              )
                .map(a => a.href)
                .filter(Boolean)
            )
          ];
        });

      console.log(
        `  ${pagination.length} lien(s) de pagination`
      );

      for (const nextUrl of pagination) {
        if (!visited.has(nextUrl)) {
          queue.push(nextUrl);
        }
      }

    } catch (error) {
      console.log(
        `  ⚠ ERREUR : ${error.message}`
      );
    }
  }

  await page.close();

  return dedupe(allDecisions);
}

async function main() {
  console.log('');
  console.log(
    '========================================'
  );
  console.log(
    'SCRAPER FISCAL - LIÈGE UNIQUEMENT'
  );
  console.log(
    `ANNÉE : ${TARGET_YEAR}`
  );
  console.log(
    '========================================'
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

  try {
    const decisions =
      await scrapeLiege(browser);

    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      `TOTAL UNIQUE : ${decisions.length} décisions ${TARGET_YEAR}`
    );
    console.log(
      '========================================'
    );

    /*
     * PROTECTION :
     * si nous n'avons pas retrouvé un volume
     * raisonnable de décisions, on ne touche pas
     * au fichier existant.
     */
    if (decisions.length < 100) {
      console.log('');
      console.log(
        '⚠️ PROTECTION ACTIVÉE'
      );
      console.log(
        'Moins de 100 décisions 2026 récupérées.'
      );
      console.log(
        'Aucune modification du fichier JSON.'
      );

      return;
    }

    const fiscalDecisions = [];

    for (const decision of decisions) {
      if (!classifyFiscal(decision.text)) {
        continue;
      }

      const date =
        parseDateFromSlug(decision.url);

      fiscalDecisions.push({
        date: date
          ? date.toISOString().slice(0, 10)
          : null,

        titre: decision.text,

        matiere: '',

        url: decision.url
      });
    }

    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      `DÉCISIONS FISCALES : ${fiscalDecisions.length}`
    );
    console.log(
      '========================================'
    );

    for (const item of fiscalDecisions) {
      console.log('');
      console.log(`DATE  : ${item.date}`);
      console.log(`TITRE : ${item.titre}`);
      console.log(`URL   : ${item.url}`);
    }

    /*
     * Lecture du fichier existant.
     */
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

    /*
     * On remplace uniquement Liège.
     * Les autres communes restent intactes.
     */
    existingData['Liège'] = {
      updatedAt:
        new Date().toISOString(),

      reglementsEnVigueur:
        fiscalDecisions,

      prochainesTaxes: []
    };

    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        existingData,
        null,
        2
      ),
      'utf8'
    );

    console.log('');
    console.log(
      `✓ Fichier mis à jour : ${outputPath}`
    );

  } finally {
    await browser.close();
  }

  console.log('');
  console.log(
    '✓ TEST TERMINÉ'
  );
}

main().catch(error => {
  console.error('');
  console.error(
    '❌ ERREUR FATALE'
  );
  console.error(error);
  process.exit(1);
});
