import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';

const BASE_URL = 'https://www.deliberations.be';
const TARGET_YEAR = 2026;

// ============================================================
// PARAMÈTRE DE TEST
// ============================================================
// On ne teste QUE Liège pour le moment.
const COMMUNE_A_TESTER = 'liege';

// ============================================================
// MOTS-CLÉS FISCAUX
// ============================================================

const TAX_PATTERNS = [
  /\btaxe\b/i,
  /\btaxes\b/i,
  /\breglement[- ]taxe\b/i,
  /\breglement[- ]taxes\b/i,
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

// ============================================================
// MOTS-CLÉS QUI NE DOIVENT PAS SUFFIRE À CLASSER FISCAL
// ============================================================

const EXCLUDED_PATTERNS = [
  /\bzone de stationnement\b/i,
  /\bstationnement reserve\b/i,
  /\binterdiction d acces\b/i,
  /\bbail commercial\b/i,
  /\bbail-type\b/i,
  /\bconvention de bail\b/i,
  /\bemplacement de stationnement\b/i,
  /\bsubvention\b/i,
  /\bsubventions\b/i,
  /\bcomptes annuels\b/i,
  /\bapprobation des comptes\b/i,
  /\bmarche public\b/i,
  /\bmarches publics\b/i,
  /\bpersonnel\b/i,
  /\brecrutement\b/i,
  /\bjournees europeennes du patrimoine\b/i,
];

// ============================================================
// OUTILS
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
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDateFromSlug(url) {
  const match = url.match(
    /\/decisions\/(\d{1,2})-([a-z]+)-(\d{4})/i
  );

  if (!match) {
    return null;
  }

  const [, day, monthName, year] = match;

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
    décembre: 11,
  };

  const month = months[monthName.toLowerCase()];

  if (month === undefined) {
    return null;
  }

  const date = new Date(
    Number(year),
    month,
    Number(day)
  );

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function formatDate(date) {
  if (!date) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

// ============================================================
// CLASSIFICATION FISCALE
// ============================================================

function isTaxRelated(title, matiere, url) {
  const titleText = normalizeForSearch(title);
  const matiereText = normalizeForSearch(matiere);
  const urlText = normalizeForSearch(url);

  // Le titre est la source principale.
  const titleHasTax = TAX_PATTERNS.some(pattern =>
    pattern.test(titleText)
  );

  // La matière peut confirmer uniquement si elle contient
  // elle-même un terme fiscal explicite.
  const matiereHasTax = TAX_PATTERNS.some(pattern =>
    pattern.test(matiereText)
  );

  // L'URL peut confirmer une décision explicitement fiscale.
  const urlHasTax = TAX_PATTERNS.some(pattern =>
    pattern.test(urlText)
  );

  // IMPORTANT :
  // "Matière Finances" ne suffit PAS.
  if (
    normalizeForSearch(matiereText) === 'finances' &&
    !titleHasTax &&
    !urlHasTax
  ) {
    return false;
  }

  // Les exclusions ne doivent pas écraser un vrai
  // "règlement-taxe".
  const excluded =
    EXCLUDED_PATTERNS.some(pattern => pattern.test(titleText)) &&
    !/\breglement[- ]taxe\b/i.test(titleText) &&
    !/\breglement[- ]taxes\b/i.test(titleText);

  if (excluded) {
    return false;
  }

  return titleHasTax || matiereHasTax || urlHasTax;
}

// ============================================================
// EXTRACTION DES LIENS DE LA PAGE DE LISTE
// ============================================================

function extractDecisionLinks($) {
  const decisions = [];
  const seen = new Set();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');

    if (!href) {
      return;
    }

    let absoluteUrl;

    try {
      absoluteUrl = new URL(href, BASE_URL).href;
    } catch {
      return;
    }

    // On ne garde que les pages individuelles de décisions.
    if (!/\/decisions\/\d{1,2}-[a-z]+-\d{4}-/i.test(absoluteUrl)) {
      return;
    }

    if (seen.has(absoluteUrl)) {
      return;
    }

    const date = parseDateFromSlug(absoluteUrl);

    if (!date || date.getFullYear() !== TARGET_YEAR) {
      return;
    }

    seen.add(absoluteUrl);

    decisions.push({
      url: absoluteUrl,
      date: formatDate(date),
    });
  });

  return decisions;
}

// ============================================================
// PAGINATION
// ============================================================

function findNextPageUrl($, currentUrl) {
  const candidates = [];

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    const text = normalizeText($(element).text());

    if (!href) {
      return;
    }

    if (
      /page suivante|suivante|next|>|»/i.test(text)
    ) {
      try {
        candidates.push(
          new URL(href, currentUrl).href
        );
      } catch {}
    }
  });

  // Si le site n'a pas de lien "suivant" explicite,
  // on cherche la pagination avec b_start.
  $('a[href*="b_start"]').each((_, element) => {
    const href = $(element).attr('href');

    if (!href) {
      return;
    }

    try {
      candidates.push(
        new URL(href, currentUrl).href
      );
    } catch {}
  });

  const unique = [...new Set(candidates)];

  // On évite les liens qui ramènent à la même page.
  for (const url of unique) {
    if (url !== currentUrl) {
      return url;
    }
  }

  return null;
}

// ============================================================
// SCRAPING DES PAGES DE LISTE
// ============================================================

async function collectAll2026DecisionLinks(page, slug) {
  const allDecisions = [];
  const seenUrls = new Set();

  let currentUrl =
    `${BASE_URL}/${slug}/decisions`;

  let pageNumber = 1;

  while (currentUrl) {
    console.log(`\nPage décisions ${pageNumber}`);
    console.log(`  → ${currentUrl}`);

    try {
      await page.goto(currentUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });
    } catch (error) {
      console.log(
        `  ⚠️ Erreur chargement : ${error.message}`
      );
      break;
    }

    await sleep(1000);

    const html = await page.content();
    const $ = cheerio.load(html);

    const decisions = extractDecisionLinks($);

    let newCount = 0;

    for (const decision of decisions) {
      if (!seenUrls.has(decision.url)) {
        seenUrls.add(decision.url);
        allDecisions.push(decision);
        newCount++;
      }
    }

    console.log(
      `  ${decisions.length} décision(s) de 2026 trouvée(s)`
    );
    console.log(
      `  ${newCount} nouvelle(s) décision(s)`
    );

    const nextUrl = findNextPageUrl($, currentUrl);

    if (!nextUrl || nextUrl === currentUrl) {
      console.log('  Plus de page disponible.');
      break;
    }

    currentUrl = nextUrl;
    pageNumber++;

    // Sécurité
    if (pageNumber > 100) {
      console.log(
        '  ⚠️ Limite de sécurité de 100 pages atteinte.'
      );
      break;
    }
  }

  return allDecisions;
}

// ============================================================
// EXTRACTION D'UNE DÉCISION INDIVIDUELLE
// ============================================================

async function scrapeIndividualDecision(page, decision) {
  try {
    await page.goto(decision.url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Laisser le JavaScript du site terminer son rendu.
    await sleep(1000);

    const html = await page.content();
    const $ = cheerio.load(html);

    // --------------------------------------------------------
    // TEXTE DE LA PAGE INDIVIDUELLE
    // --------------------------------------------------------

    const bodyText = normalizeText(
      $('body').text()
    );

    // --------------------------------------------------------
    // TITRE
    // --------------------------------------------------------

    let title = '';

    const h1 = normalizeText(
      $('h1').first().text()
    );

    if (h1) {
      title = h1;
    }

    if (!title) {
      const ogTitle = normalizeText(
        $('meta[property="og:title"]').attr('content') || ''
      );

      title = ogTitle;
    }

    if (!title) {
      title = normalizeText(
        $('title').text()
      );
    }

    // Recherche d'une ligne contenant "Projet de décision"
    // si le H1 n'est pas suffisamment précis.
    const lines = $('body')
      .text()
      .split(/\n+/)
      .map(normalizeText)
      .filter(Boolean);

    const projectLine = lines.find(line =>
      /projet de décision|decision/i.test(line)
    );

    if (
      projectLine &&
      projectLine.length > title.length
    ) {
      title = projectLine;
    }

    // --------------------------------------------------------
    // MATIÈRE
    // --------------------------------------------------------

    let matiere = '';

    const matterMatch = bodyText.match(
      /Mati[eè]re\s+(.+?)(?=\s+Mandataire\b|$)/i
    );

    if (matterMatch) {
      matiere = normalizeText(
        matterMatch[1]
      );
    }

    // --------------------------------------------------------
    // NETTOYAGE DU TITRE
    // --------------------------------------------------------

    title = normalizeText(title);

    // Certains titres peuvent contenir la matière
    // et le mandataire à la suite.
    title = title
      .replace(
        /\s+Mati[eè]re\s+.+$/i,
        ''
      )
      .trim();

    return {
      ...decision,
      title,
      matiere,
    };

  } catch (error) {
    console.log(
      `  ⚠️ Impossible d'analyser ${decision.url}`
    );
    console.log(
      `     ${error.message}`
    );

    return {
      ...decision,
      title: '',
      matiere: '',
    };
  }
}

// ============================================================
// DÉDOUBLONNAGE
// ============================================================

function dedupeItems(items) {
  const map = new Map();

  for (const item of items) {
    const key =
      item.url ||
      `${item.date}|${item.title}`;

    if (!map.has(key)) {
      map.set(key, item);
    }
  }

  return [...map.values()];
}

// ============================================================
// CHARGEMENT DES COMMUNES
// ============================================================

function loadCommunes() {
  const filePath = path.join(
    process.cwd(),
    'scripts',
    'communes-deliberations.json'
  );

  return JSON.parse(
    fs.readFileSync(filePath, 'utf8')
  );
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(
    `Lancement du scraper fiscal - année ${TARGET_YEAR}`
  );

  console.log(
    `TEST UNIQUEMENT : ${COMMUNE_A_TESTER}`
  );

  const communes = loadCommunes();

  const communesATester = communes.filter(
    commune =>
      commune.slug === COMMUNE_A_TESTER
  );

  if (communesATester.length === 0) {
    throw new Error(
      `Commune introuvable : ${COMMUNE_A_TESTER}`
    );
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const page = await browser.newPage();

  await page.setViewport({
    width: 1440,
    height: 900,
  });

  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  );

  const output = {};

  for (const commune of communesATester) {
    const {
      slug,
      name,
    } = commune;

    console.log(`\n========================================`);
    console.log(`→ ${name} (${slug})`);
    console.log(`========================================`);

    // --------------------------------------------------------
    // ÉTAPE 1 : récupérer toutes les décisions 2026
    // --------------------------------------------------------

    const decisions =
      await collectAll2026DecisionLinks(
        page,
        slug
      );

    console.log(
      `\n${decisions.length} décision(s) 2026 à analyser individuellement.`
    );

    // --------------------------------------------------------
    // ÉTAPE 2 : ouvrir CHAQUE décision individuellement
    // --------------------------------------------------------

    const fiscalDecisions = [];

    for (
      let i = 0;
      i < decisions.length;
      i++
    ) {
      const decision = decisions[i];

      console.log(
        `\nAnalyse ${i + 1}/${decisions.length}`
      );

      const detail =
        await scrapeIndividualDecision(
          page,
          decision
        );

      const fiscal = isTaxRelated(
        detail.title,
        detail.matiere,
        detail.url
      );

      if (fiscal) {
        console.log('  >>> FISCAL : OUI');
        console.log(
          `  TITRE : ${detail.title}`
        );
        console.log(
          `  MATIÈRE : ${detail.matiere}`
        );
        console.log(
          `  DATE : ${detail.date}`
        );
        console.log(
          `  URL : ${detail.url}`
        );

        fiscalDecisions.push({
          date: detail.date,
          title: detail.title,
          matiere: detail.matiere,
          url: detail.url,
        });
      }

      // Petite pause pour éviter de bombarder le site.
      await sleep(250);
    }

    const finalItems =
      dedupeItems(fiscalDecisions);

    output[name] = {
      updatedAt: new Date().toISOString(),
      reglementsEnVigueur: finalItems.map(
        item => ({
          titre: item.title,
          url: item.url,
          matiere: item.matiere,
          date: item.date,
        })
      ),
      prochainesTaxes: [],
    };

    console.log(`\n----------------------------------------`);
    console.log(
      `${finalItems.length} élément(s) fiscal(aux) conservé(s) pour ${name}`
    );
    console.log(`----------------------------------------`);
  }

  await browser.close();

  // ----------------------------------------------------------
  // SAUVEGARDE
  // ----------------------------------------------------------

  const outputPath = path.join(
    process.cwd(),
    'src',
    'data',
    'reglements-taxes.json'
  );

  fs.writeFileSync(
    outputPath,
    JSON.stringify(output, null, 2),
    'utf8'
  );

  console.log(
    `\n✓ Fichier mis à jour : ${outputPath}`
  );

  console.log('\n✓ Scraping terminé.');
}

main().catch(error => {
  console.error('\n❌ ERREUR FATALE');
  console.error(error);
  process.exit(1);
});
