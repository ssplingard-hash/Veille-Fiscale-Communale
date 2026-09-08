import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_YEAR = 2026;
const COMMUNE = {
  slug: 'liege',
  name: 'Liège'
};

const BASE_URL = 'https://www.deliberations.be';

// ============================================================
// MOTS-CLES FISCAUX
// ============================================================

const TAX_PATTERNS = [
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
  /\bforce motrice\b/i
];

const EXCLUDED_PATTERNS = [
  /\bsubvention\b/i,
  /\bsubventions\b/i,
  /\bcomptes annuels\b/i,
  /\bapprobation des comptes\b/i,
  /\bmarch[eé] public\b/i,
  /\bmarch[eé]s publics\b/i,
  /\bpersonnel\b/i,
  /\brecrutement\b/i,
  /\bzone de stationnement\b/i,
  /\bstationnement reserve\b/i,
  /\binterdiction d.acces\b/i,
  /\bbail commercial\b/i,
  /\bconvention de bail\b/i,
  /\bemplacement de stationnement\b/i,
  /\bjournees europeennes du patrimoine\b/i
];

// ============================================================
// UTILITAIRES
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(value = '') {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForSearch(value = '') {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function parseDateFromUrl(url) {
  const match = url.match(
    /\/(\d{1,2})-([a-zéûîôàèù]+)-(\d{4})-/i
  );

  if (!match) return null;

  const months = {
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

  const month = months[match[2].toLowerCase()];

  if (month === undefined) return null;

  return new Date(
    Date.UTC(
      Number(match[3]),
      month,
      Number(match[1])
    )
  );
}

function is2026(url) {
  const date = parseDateFromUrl(url);

  return (
    date &&
    date.getUTCFullYear() === TARGET_YEAR
  );
}

function formatDate(date) {
  return date
    ? date.toISOString().slice(0, 10)
    : null;
}

// ============================================================
// EXTRAIRE LES DECISIONS D'UNE PAGE
// ============================================================

async function extractDecisionLinks(page) {
  const html = await page.content();
  const $ = cheerio.load(html);

  const results = [];
  const seen = new Set();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');

    if (!href) return;

    let url;

    try {
      url = new URL(href, page.url()).href;
    } catch {
      return;
    }

    if (!url.includes('/liege/decisions/')) {
      return;
    }

    if (!is2026(url)) {
      return;
    }

    if (seen.has(url)) {
      return;
    }

    seen.add(url);

    const date = parseDateFromUrl(url);

    results.push({
      url,
      date: formatDate(date)
    });
  });

  return results;
}

// ============================================================
// PAGINATION : OFFSETS DIRECTS
// ============================================================

async function collectAllDecisions(page) {
  const all = [];
  const seen = new Set();

  const PAGE_SIZE = 20;
  const MAX_OFFSET = 1000;

  for (
    let offset = 0;
    offset <= MAX_OFFSET;
    offset += PAGE_SIZE
  ) {
    let url;

    if (offset === 0) {
      url = `${BASE_URL}/${COMMUNE.slug}/decisions`;
    } else {
      url =
        `${BASE_URL}/${COMMUNE.slug}/decisions/@@faceted_query` +
        `?b_start:int=${offset}`;
    }

    console.log('');
    console.log(`Page offset ${offset}`);
    console.log(`  → ${url}`);

    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      await sleep(800);
    } catch (error) {
      console.log(
        `  ⚠️ Erreur : ${error.message}`
      );

      // On tente la page suivante au lieu d'abandonner
      continue;
    }

    const decisions =
      await extractDecisionLinks(page);

    console.log(
      `  ${decisions.length} décision(s) 2026 trouvée(s)`
    );

    let added = 0;

    for (const decision of decisions) {
      if (!seen.has(decision.url)) {
        seen.add(decision.url);
        all.push(decision);
        added++;
      }
    }

    console.log(
      `  ${added} nouvelle(s) décision(s)`
    );

    /*
     * Si aucune décision 2026 n'est trouvée,
     * nous sommes arrivés après la fin des données.
     */
    if (decisions.length === 0) {
      console.log(
        '  Plus aucune décision 2026.'
      );
      break;
    }

    /*
     * Si la page ne contient plus 20 nouvelles décisions,
     * nous sommes probablement sur la dernière page.
     */
    if (added < PAGE_SIZE) {
      console.log(
        '  Dernière page atteinte.'
      );
      break;
    }
  }

  return all;
}

// ============================================================
// EXTRACTION TITRE / MATIERE
// ============================================================

function extractTitle($) {
  const h1 = normalizeText(
    $('h1').first().text()
  );

  if (
    h1 &&
    h1.length > 10 &&
    !/^decision$/i.test(h1)
  ) {
    return h1;
  }

  const ogTitle = normalizeText(
    $('meta[property="og:title"]').attr('content') || ''
  );

  if (
    ogTitle &&
    ogTitle.length > 10 &&
    !/^decision$/i.test(ogTitle)
  ) {
    return ogTitle;
  }

  const title = normalizeText(
    $('title').text()
  );

  if (
    title &&
    title.length > 10 &&
    !/^decision$/i.test(title)
  ) {
    return title;
  }

  return '';
}

function extractMatiere($) {
  const lines = $('body')
    .text()
    .split('\n')
    .map(normalizeText)
    .filter(Boolean);

  for (const line of lines) {
    if (/^mati[eè]re\b/i.test(line)) {
      let value = line.replace(
        /^mati[eè]re\s*/i,
        ''
      );

      value = value.split(
        /\bmandataire\b/i
      )[0];

      return normalizeText(value);
    }
  }

  const body = normalizeText(
    $('body').text()
  );

  const match = body.match(
    /Mati[eè]re\s+(.+?)(?=\s+Mandataire\b)/i
  );

  if (match) {
    return normalizeText(match[1]);
  }

  return '';
}

// ============================================================
// CLASSIFICATION
// ============================================================

function containsTaxPattern(text) {
  const normalized = normalizeForSearch(text);

  return TAX_PATTERNS.some(pattern =>
    pattern.test(normalized)
  );
}

function containsExcludedPattern(text) {
  const normalized = normalizeForSearch(text);

  return EXCLUDED_PATTERNS.some(pattern =>
    pattern.test(normalized)
  );
}

function isTaxRelated(title, matiere, url) {
  const titleSearch = normalizeForSearch(title);
  const matiereSearch = normalizeForSearch(matiere);
  const urlSearch = normalizeForSearch(url);

  // Le titre est le critère principal.
  if (containsTaxPattern(titleSearch)) {
    // Les exclusions restent prioritaires,
    // sauf règlement-taxe explicite.
    const explicitTax =
      /\breglement[- ]taxe\b/i.test(titleSearch) ||
      /\breglement[- ]taxes\b/i.test(titleSearch);

    if (
      !explicitTax &&
      containsExcludedPattern(titleSearch)
    ) {
      return false;
    }

    return true;
  }

  // La matière peut confirmer une décision fiscale.
  // "Finances" seul n'est PAS suffisant.
  if (
    matiereSearch &&
    matiereSearch !== 'finances' &&
    containsTaxPattern(matiereSearch)
  ) {
    return true;
  }

  // L'URL peut confirmer uniquement des termes fiscaux explicites.
  if (
    /\btaxe\b/i.test(urlSearch) ||
    /\btaxes\b/i.test(urlSearch) ||
    /\bredevance\b/i.test(urlSearch) ||
    /\bprecompte\b/i.test(urlSearch) ||
    /\bfiscal/i.test(urlSearch) ||
    /\bimpot/i.test(urlSearch)
  ) {
    return true;
  }

  return false;
}

// ============================================================
// ANALYSE D'UNE DECISION
// ============================================================

async function analyseDecision(
  page,
  decision,
  index,
  total
) {
  console.log(
    `Analyse ${index}/${total}`
  );

  try {
    await page.goto(decision.url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await sleep(700);

    const html = await page.content();
    const $ = cheerio.load(html);

    const title = extractTitle($);
    const matiere = extractMatiere($);

    const fiscal = isTaxRelated(
      title,
      matiere,
      decision.url
    );

    /*
     * IMPORTANT :
     * on affiche maintenant les informations
     * réellement extraites de la page.
     */

    console.log(
      `  TITRE   : ${title || '[VIDE]'}`
    );

    console.log(
      `  MATIERE : ${matiere || '[VIDE]'}`
    );

    console.log(
      `  FISCAL  : ${fiscal ? 'OUI' : 'NON'}`
    );

    if (fiscal) {
      console.log(
        `  ★ DECISION FISCALE : ${decision.url}`
      );
    }

    return {
      date: decision.date,
      titre: title,
      matiere,
      url: decision.url,
      fiscal
    };

  } catch (error) {
    console.log(
      `  ⚠️ Erreur : ${error.message}`
    );

    return {
      date: decision.date,
      titre: '',
      matiere: '',
      url: decision.url,
      fiscal: false
    };
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(
    `Lancement du scraper fiscal - année ${TARGET_YEAR}`
  );

  console.log(
    'TEST UNIQUEMENT : Liège'
  );

  const browser = await puppeteer.launch({
    headless: true,

    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors'
    ]
  });

  const page = await browser.newPage();

  await page.setViewport({
    width: 1440,
    height: 1000
  });

  console.log('');
  console.log(
    '========================================'
  );
  console.log(
    '→ Liège (liege)'
  );
  console.log(
    '========================================'
  );

  // 1. Récupérer toutes les décisions 2026
  const decisions =
    await collectAllDecisions(page);

  console.log('');
  console.log(
    `TOTAL : ${decisions.length} décision(s) 2026 récupérée(s).`
  );

  // 2. Analyser les décisions
  const analysed = [];

  for (let i = 0; i < decisions.length; i++) {
    const result =
      await analyseDecision(
        page,
        decisions[i],
        i + 1,
        decisions.length
      );

    analysed.push(result);
  }

  // 3. Garder les fiscales
  const fiscalItems =
    analysed.filter(item => item.fiscal);

  console.log('');
  console.log(
    '========================================'
  );
  console.log(
    `${fiscalItems.length} décision(s) fiscale(s) détectée(s)`
  );
  console.log(
    '========================================'
  );

  for (const item of fiscalItems) {
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

  // 4. Ecriture du JSON
  const output = {
    [COMMUNE.name]: {
      updatedAt: new Date().toISOString(),

      reglementsEnVigueur:
        fiscalItems.map(item => ({
          titre: item.titre,
          url: item.url,
          matiere: item.matiere,
          date: item.date
        })),

      prochainesTaxes: []
    }
  };

  const outputPath = path.resolve(
    __dirname,
    '../src/data/reglements-taxes.json'
  );

  fs.writeFileSync(
    outputPath,
    JSON.stringify(output, null, 2),
    'utf8'
  );

  console.log('');
  console.log(
    `✓ Fichier mis à jour : ${outputPath}`
  );

  await browser.close();

  console.log('');
  console.log(
    '✓ Scraping terminé.'
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
