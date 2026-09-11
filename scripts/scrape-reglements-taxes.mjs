import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

const BASE_URL = 'https://www.deliberations.be';
const TARGET_YEAR = 2026;

/*
 * IDENTIFIANT DE LA SÉANCE DE LIÈGE
 *
 * C'est cet identifiant qui permet au site de retourner
 * les véritables pages de décisions.
 */
const SEANCE_ID = '2de1042e723745489c3a379e48becbe1';

const PAGE_SIZE = 20;

function cleanText(value = '') {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
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
 * URL DE PAGINATION CORRECTE POUR LIÈGE
 */
function buildPageUrl(offset) {
  return (
    `${BASE_URL}/liege/decisions/@@faceted_query` +
    `?b_start:int=${offset}` +
    `&seance%5B%5D=${SEANCE_ID}`
  );
}

/*
 * Extraction des décisions.
 *
 * IMPORTANT :
 * On récupère uniquement les liens dont l'URL
 * correspond à une véritable décision individuelle.
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

      const normalized = text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

      /*
       * Ces liens sont des documents de séance,
       * pas des décisions individuelles.
       */
      if (
        normalized.includes('ordre du jour') ||
        normalized.includes('bulletin des questions') ||
        normalized.includes('addendum')
      ) {
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
 * MOTIFS FISCAUX
 *
 * Pour l'instant on reste volontairement strict.
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

/*
 * FAUX POSITIFS CONNUS
 */
const EXCLUDED_PATTERNS = [
  /\bbail commercial\b/,
  /\bbail[- ]type\b/,
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
  /\bzone 30\b/
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

  page.setDefaultNavigationTimeout(90000);

  const allDecisions = [];
  const seenUrls = new Set();

  /*
   * On teste successivement :
   *
   * offset 0
   * offset 20
   * offset 40
   * offset 60
   * ...
   *
   * avec LA BONNE URL faceted_query.
   */
  for (
    let offset = 0;
    offset <= 10000;
    offset += PAGE_SIZE
  ) {
    const url = buildPageUrl(offset);

    console.log('');
    console.log('========================================');
    console.log(`OFFSET : ${offset}`);
    console.log(`URL : ${url}`);
    console.log('========================================');

    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 90000
      });

      await new Promise(resolve =>
        setTimeout(resolve, 1500)
      );

      const links =
        await extractDecisionLinks(page);

      console.log(
        `Liens de décisions : ${links.length}`
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
        `Décisions ${TARGET_YEAR} : ${yearLinks.length}`
      );

      let newOnPage = 0;

      for (const item of yearLinks) {
        if (seenUrls.has(item.url)) {
          continue;
        }

        seenUrls.add(item.url);
        allDecisions.push(item);
        newOnPage++;

        console.log(
          `  + ${item.text.substring(0, 180)}`
        );
      }

      console.log(
        `Nouvelles décisions : ${newOnPage}`
      );

      /*
       * Si une page ne contient plus aucune nouvelle
       * décision, nous sommes arrivés à la fin.
       */
      if (offset > 0 && newOnPage === 0) {
        console.log('');
        console.log(
          'Fin de la liste : aucune nouvelle décision.'
        );
        break;
      }

    } catch (error) {
      console.log(
        `⚠ Erreur offset ${offset} : ${error.message}`
      );
    }
  }

  await page.close();

  return dedupe(allDecisions);
}

async function main() {
  console.log('');
  console.log('========================================');
  console.log('SCRAPER FISCAL - LIÈGE');
  console.log(`ANNÉE : ${TARGET_YEAR}`);
  console.log('========================================');
  console.log('');

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
    console.log('========================================');
    console.log(
      `TOTAL UNIQUE : ${decisions.length} décisions ${TARGET_YEAR}`
    );
    console.log('========================================');

    /*
     * PROTECTION
     */
    if (decisions.length < 100) {
      console.log('');
      console.log('⚠️ PROTECTION ACTIVÉE');
      console.log(
        'Moins de 100 décisions 2026 récupérées.'
      );
      console.log(
        'Le JSON existant reste inchangé.'
      );

      return;
    }

    /*
     * CLASSIFICATION
     */
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
    console.log('========================================');
    console.log(
      `DÉCISIONS FISCALES : ${fiscalDecisions.length}`
    );
    console.log('========================================');

    for (const item of fiscalDecisions) {
      console.log('');
      console.log(`DATE  : ${item.date}`);
      console.log(`TITRE : ${item.titre}`);
      console.log(`URL   : ${item.url}`);
    }

    /*
     * Écriture JSON
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
      '✓ Liège enregistré dans reglements-taxes.json'
    );

  } finally {
    await browser.close();
  }

  console.log('');
  console.log('✓ TEST TERMINÉ');
}

main().catch(error => {
  console.error('');
  console.error('❌ ERREUR FATALE');
  console.error(error);
  process.exit(1);
});
