import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_YEAR = 2026;

// ============================================================
// TEST : UNIQUEMENT LIEGE
// ============================================================
const COMMUNE_TEST = {
  slug: 'liege',
  name: 'Liège'
};

// ============================================================
// MOTS-CLES FISCAUX
// ============================================================
const TAX_PATTERNS = [
  /\btaxe\b/i,
  /\btaxes\b/i,
  /\br[eè]glement[- ]taxe\b/i,
  /\br[eè]glement[- ]taxes\b/i,
  /\br[eè]glement[- ]redevance\b/i,
  /\br[eè]glement[- ]redevances\b/i,
  /\bredevance\b/i,
  /\bredevances\b/i,
  /\bprecompte\b/i,
  /\bimp[oô]t\b/i,
  /\bimp[oô]ts\b/i,
  /\badditionnel\b/i,
  /\badditionnels\b/i,
  /\bcentimes additionnels\b/i,
  /\bfiscal\b/i,
  /\bfiscale\b/i,
  /\bfiscaux\b/i,
  /\bfiscalit[eé]\b/i,
  /\bimposition\b/i,
  /\bimpositions\b/i,
  /\bipp\b/i,
  /\bforce motrice\b/i
];

// ============================================================
// EXCLUSIONS CLAIRES
// ============================================================
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
  /\bstationnement r[eé]serv[eé]\b/i,
  /\binterdiction d.acc[eè]s\b/i,
  /\bbail commercial\b/i,
  /\bconvention de bail\b/i,
  /\bemplacement de stationnement\b/i,
  /\bjourn[eé]es europ[eé]ennes du patrimoine\b/i
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

function parseDateFromSlug(url) {
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

  const day = Number(match[1]);
  const month = months[match[2].toLowerCase()];
  const year = Number(match[3]);

  if (month === undefined) return null;

  return new Date(Date.UTC(year, month, day));
}

function isTargetYear(url) {
  const date = parseDateFromSlug(url);
  return date && date.getUTCFullYear() === TARGET_YEAR;
}

function formatDate(date) {
  if (!date) return null;

  return date.toISOString().slice(0, 10);
}

// ============================================================
// EXTRACTION DES LIENS DEPUIS UNE PAGE DE LISTE
// ============================================================
async function extractDecisionLinks(page) {
  const html = await page.content();
  const $ = cheerio.load(html);

  const decisions = [];
  const seen = new Set();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');

    if (!href) return;

    let absoluteUrl;

    try {
      absoluteUrl = new URL(href, page.url()).href;
    } catch {
      return;
    }

    // Une décision Liège ressemble à :
    // /liege/decisions/07-septembre-2026-18-00/...
    if (!absoluteUrl.includes('/liege/decisions/')) {
      return;
    }

    if (!isTargetYear(absoluteUrl)) {
      return;
    }

    if (seen.has(absoluteUrl)) {
      return;
    }

    seen.add(absoluteUrl);

    const date = parseDateFromSlug(absoluteUrl);

    decisions.push({
      url: absoluteUrl,
      date: formatDate(date)
    });
  });

  return decisions;
}

// ============================================================
// TROUVER LA PAGE SUIVANTE
// ============================================================
async function findNextPage(page) {
  const html = await page.content();
  const $ = cheerio.load(html);

  let nextUrl = null;

  $('a[href]').each((_, element) => {
    if (nextUrl) return;

    const href = $(element).attr('href');
    const text = normalizeText($(element).text()).toLowerCase();

    if (!href) return;

    if (
      text.includes('suivant') ||
      text.includes('next') ||
      href.includes('b_start:int=')
    ) {
      try {
        const absoluteUrl = new URL(href, page.url()).href;

        if (
          absoluteUrl.includes('/liege/decisions/') &&
          absoluteUrl.includes('b_start:int=')
        ) {
          nextUrl = absoluteUrl;
        }
      } catch {
        // rien
      }
    }
  });

  return nextUrl;
}

// ============================================================
// RECUPERATION DE TOUTES LES DECISIONS 2026
// ============================================================
async function collectAllDecisions(page, commune) {
  const allDecisions = [];
  const seenUrls = new Set();

  let currentUrl =
    `https://www.deliberations.be/${commune.slug}/decisions`;

  let pageNumber = 1;

  while (currentUrl) {
    console.log('');
    console.log(`Page ${pageNumber}`);
    console.log(`  → ${currentUrl}`);

    try {
      await page.goto(currentUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      await sleep(1000);
    } catch (error) {
      console.log(`  ⚠️ Erreur chargement : ${error.message}`);
      break;
    }

    const decisions = await extractDecisionLinks(page);

    console.log(
      `  ${decisions.length} décision(s) 2026 trouvée(s)`
    );

    let newCount = 0;

    for (const decision of decisions) {
      if (!seenUrls.has(decision.url)) {
        seenUrls.add(decision.url);
        allDecisions.push(decision);
        newCount++;
      }
    }

    console.log(`  ${newCount} nouvelle(s) décision(s)`);

    const nextUrl = await findNextPage(page);

    if (!nextUrl || nextUrl === currentUrl) {
      console.log('  Fin de la pagination.');
      break;
    }

    currentUrl = nextUrl;
    pageNumber++;

    // Sécurité
    if (pageNumber > 100) {
      console.log('  ⚠️ Arrêt de sécurité : trop de pages.');
      break;
    }
  }

  return allDecisions;
}

// ============================================================
// EXTRACTION DU TITRE SUR LA PAGE INDIVIDUELLE
// ============================================================
function extractTitle($) {
  // 1. H1
  const h1 = normalizeText($('h1').first().text());

  if (
    h1 &&
    h1.length > 10 &&
    !/^d[eé]cision$/i.test(h1) &&
    !/^projet de d[eé]cision$/i.test(h1)
  ) {
    return h1;
  }

  // 2. OpenGraph
  const ogTitle = normalizeText(
    $('meta[property="og:title"]').attr('content') || ''
  );

  if (
    ogTitle &&
    ogTitle.length > 10 &&
    !/^d[eé]cision$/i.test(ogTitle)
  ) {
    return ogTitle;
  }

  // 3. Balise title
  const pageTitle = normalizeText($('title').text());

  if (
    pageTitle &&
    pageTitle.length > 10 &&
    !/^d[eé]cision$/i.test(pageTitle)
  ) {
    return pageTitle;
  }

  // 4. Recherche d'une ligne "Projet de décision"
  const lines = $('body')
    .text()
    .split('\n')
    .map(normalizeText)
    .filter(Boolean);

  const candidate = lines.find(line =>
    /projet de d[eé]cision/i.test(line)
  );

  return candidate || '';
}

// ============================================================
// EXTRACTION DE LA MATIERE
// ============================================================
function extractMatiere($) {
  const bodyText = normalizeText($('body').text());

  // Cas normal :
  // Matière Finances Mandataire ...
  const match = bodyText.match(
    /Mati[eè]re\s+(.+?)(?=\s+Mandataire\b)/i
  );

  if (match) {
    return normalizeText(match[1]);
  }

  // Deuxième méthode : chercher une ligne
  const lines = $('body')
    .text()
    .split('\n')
    .map(normalizeText)
    .filter(Boolean);

  const line = lines.find(l =>
    /^Mati[eè]re\b/i.test(l)
  );

  if (line) {
    return normalizeText(
      line
        .replace(/^Mati[eè]re\s*/i, '')
        .split(/Mandataire\b/i)[0]
    );
  }

  return '';
}

// ============================================================
// CLASSIFICATION FISCALE
// ============================================================
function isTaxRelated(title, matiere, url) {
  const titleText = normalizeText(title);
  const matiereText = normalizeText(matiere);
  const urlText = normalizeText(url);

  // PRIORITE ABSOLUE AU TITRE
  const titleIsFiscal = TAX_PATTERNS.some(pattern =>
    pattern.test(titleText)
  );

  if (titleIsFiscal) {
    // Une exclusion ne doit pas supprimer un véritable
    // règlement-taxe explicite.
    const explicitTax =
      /\br[eè]glement[- ]taxe/i.test(titleText) ||
      /\br[eè]glement[- ]taxes/i.test(titleText);

    if (
      !explicitTax &&
      EXCLUDED_PATTERNS.some(pattern => pattern.test(titleText))
    ) {
      return false;
    }

    return true;
  }

  // MATIERE :
  // On ne considère PAS "Finances" comme fiscal à lui seul.
  const matterIsFiscal = TAX_PATTERNS.some(pattern =>
    pattern.test(matiereText)
  );

  if (matterIsFiscal) {
    return true;
  }

  // URL : uniquement les termes fiscaux explicites.
  const urlIsFiscal =
    /\btaxe\b/i.test(urlText) ||
    /\btaxes\b/i.test(urlText) ||
    /\bredevance\b/i.test(urlText) ||
    /\bprecompte\b/i.test(urlText) ||
    /\bfiscal/i.test(urlText) ||
    /\bimpot/i.test(urlText);

  if (urlIsFiscal) {
    return true;
  }

  return false;
}

// ============================================================
// ANALYSE D'UNE DECISION INDIVIDUELLE
// ============================================================
async function analyseDecision(page, decision, index, total) {
  console.log(`Analyse ${index}/${total}`);

  try {
    await page.goto(decision.url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Laisser le Javascript de deliberations.be finir de charger.
    await sleep(1000);

    const html = await page.content();
    const $ = cheerio.load(html);

    const title = extractTitle($);
    const matiere = extractMatiere($);

    const fiscal = isTaxRelated(
      title,
      matiere,
      decision.url
    );

    // Affichage UNIQUEMENT des décisions fiscales détectées.
    if (fiscal) {
      console.log('');
      console.log('  ★ DECISION FISCALE DETECTEE');
      console.log(`    Date    : ${decision.date}`);
      console.log(`    Titre   : ${title}`);
      console.log(`    Matière : ${matiere}`);
      console.log(`    URL     : ${decision.url}`);
      console.log('');
    }

    return {
      date: decision.date,
      title,
      matiere,
      url: decision.url,
      fiscal
    };

  } catch (error) {
    console.log(
      `  ⚠️ Erreur analyse décision : ${error.message}`
    );

    return {
      date: decision.date,
      title: '',
      matiere: '',
      url: decision.url,
      fiscal: false
    };
  }
}

// ============================================================
// SUPPRESSION DES DOUBLONS
// ============================================================
function dedupe(items) {
  const map = new Map();

  for (const item of items) {
    if (!item.url) continue;

    map.set(item.url, item);
  }

  return Array.from(map.values());
}

// ============================================================
// PROGRAMME PRINCIPAL
// ============================================================
async function main() {
  console.log(
    `Lancement du scraper fiscal - année ${TARGET_YEAR}`
  );

  console.log('TEST UNIQUEMENT : liege');

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

  const output = {};

  console.log('');
  console.log('========================================');
  console.log(`→ ${COMMUNE_TEST.name} (${COMMUNE_TEST.slug})`);
  console.log('========================================');

  // ----------------------------------------------------------
  // 1. RECUPERATION DES URLS
  // ----------------------------------------------------------
  const decisions = await collectAllDecisions(
    page,
    COMMUNE_TEST
  );

  console.log('');
  console.log(
    `TOTAL : ${decisions.length} décision(s) ${TARGET_YEAR} récupérée(s).`
  );

  // ----------------------------------------------------------
  // 2. ANALYSE INDIVIDUELLE
  // ----------------------------------------------------------
  const analysed = [];

  for (let i = 0; i < decisions.length; i++) {
    const result = await analyseDecision(
      page,
      decisions[i],
      i + 1,
      decisions.length
    );

    analysed.push(result);
  }

  // ----------------------------------------------------------
  // 3. CONSERVATION DES DECISIONS FISCALES
  // ----------------------------------------------------------
  const fiscalItems = dedupe(
    analysed.filter(item => item.fiscal)
  );

  console.log('');
  console.log('----------------------------------------');
  console.log(
    `${fiscalItems.length} élément(s) fiscal(aux) conservé(s) pour Liège`
  );
  console.log('----------------------------------------');

  output[COMMUNE_TEST.name] = {
    updatedAt: new Date().toISOString(),

    reglementsEnVigueur: fiscalItems.map(item => ({
      titre: item.title,
      url: item.url,
      matiere: item.matiere,
      date: item.date
    })),

    prochainesTaxes: []
  };

  // ----------------------------------------------------------
  // 4. ECRITURE DU JSON
  // ----------------------------------------------------------
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
  console.log('✓ Scraping terminé.');
}

main().catch(error => {
  console.error('');
  console.error('❌ ERREUR FATALE');
  console.error(error);
  process.exit(1);
});
