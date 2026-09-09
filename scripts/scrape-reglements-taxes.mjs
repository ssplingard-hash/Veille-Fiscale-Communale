import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

const TARGET_YEAR = 2026;
const BASE_URL = 'https://www.deliberations.be';
const PAGE_SIZE = 20;

const COMMUNES = [
  {
    slug: 'liege',
    name: 'Liège'
  }
];

/* ============================================================
   NORMALISATION
============================================================ */

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
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

/* ============================================================
   DATE
============================================================ */

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

function parseDateFromSlug(url) {
  const match = url.match(
    /\/(\d{1,2})-([a-zA-Zéèêëàâäîïôöùûüç]+)-(\d{4})-\d{2}-\d{2}/
  );

  if (!match) return null;

  const day = Number(match[1]);
  const monthName = normalizeText(match[2]);
  const year = Number(match[3]);

  const month = MONTHS[monthName];

  if (month === undefined) return null;

  return new Date(year, month, day);
}

/* ============================================================
   EXTRACTION DES DÉCISIONS DE LA LISTE
============================================================ */

async function extractDecisionsFromList(page) {
  return await page.evaluate(() => {
    const results = [];

    const links = Array.from(document.querySelectorAll('a[href]'));

    for (const link of links) {
      const href = link.href || '';
      const text = (link.innerText || link.textContent || '').trim();

      if (!href.includes('/decisions/')) continue;

      if (
        href.includes('@@faceted_query') ||
        href.endsWith('/decisions/')
      ) {
        continue;
      }

      if (!text || text.length < 10) continue;

      results.push({
        url: href,
        title: text
      });
    }

    return results;
  });
}

/* ============================================================
   DÉDUPLICATION
============================================================ */

function dedupeDecisions(decisions) {
  const map = new Map();

  for (const decision of decisions) {
    if (!decision.url) continue;

    if (!map.has(decision.url)) {
      map.set(decision.url, decision);
    }
  }

  return Array.from(map.values());
}

/* ============================================================
   EXTRACTION DU TITRE SUR LA PAGE DE DÉCISION
============================================================ */

async function extractDecisionDetails(page, url, fallbackTitle = '') {
  try {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    const details = await page.evaluate(() => {
      function clean(value) {
        return (value || '')
          .replace(/\s+/g, ' ')
          .replace(/\u00a0/g, ' ')
          .trim();
      }

      const h1 = document.querySelector('h1');

      const ogTitle = document.querySelector(
        'meta[property="og:title"]'
      );

      const titleTag = document.querySelector('title');

      let title = '';

      if (h1) {
        title = clean(h1.innerText || h1.textContent);
      }

      if (!title && ogTitle) {
        title = clean(ogTitle.getAttribute('content'));
      }

      if (!title && titleTag) {
        title = clean(titleTag.innerText || titleTag.textContent);
      }

      /*
       * On récupère également tout le texte visible.
       * Cela permet de détecter les termes fiscaux même si
       * la structure HTML change.
       */
      const bodyText = clean(document.body?.innerText || '');

      return {
        title,
        bodyText
      };
    });

    return {
      title: cleanText(details.title || fallbackTitle),
      bodyText: details.bodyText || ''
    };
  } catch (error) {
    console.log(
      `  ⚠ Impossible de lire la décision : ${error.message}`
    );

    return {
      title: cleanText(fallbackTitle),
      bodyText: ''
    };
  }
}

/* ============================================================
   CLASSIFICATION FISCALE
============================================================ */

/*
 * TERMES TRÈS FORTEMENT INDICATEURS D'UNE TAXE / REDEVANCE
 */

const STRONG_TAX_PATTERNS = [
  /\breglement[- ]taxe\b/i,
  /\breglement[- ]taxes\b/i,

  /\breglement[- ]redevance\b/i,
  /\breglement[- ]redevances\b/i,

  /\breglement fiscal\b/i,
  /\breglement de taxation\b/i,

  /\bprecompte immobilier\b/i,

  /\bcentimes additionnels\b/i,
  /\badditionnels a l'ipp\b/i,
  /\badditionnels a l ipp\b/i,

  /\bimpot des personnes physiques\b/i,
  /\bimpot des personnes morales\b/i,

  /\bipp\b/i,

  /\bforce motrice\b/i,

  /\btaxe\b/i,
  /\btaxes\b/i,

  /\bredevance\b/i,
  /\bredevances\b/i,

  /\bfiscal\b/i,
  /\bfiscale\b/i,
  /\bfiscalite\b/i,

  /\bimposition\b/i,
  /\bimpositions\b/i
];

/*
 * TERMES QUI PEUVENT CORRESPONDRE À DES TAXES COMMUNALES.
 * On ne les utilise PAS seuls : ils doivent être accompagnés
 * d'un autre indice fiscal.
 */

const TAX_CONTEXT_PATTERNS = [
  /\bdechets\b/i,
  /\bimmondices\b/i,
  /\bseconde residence\b/i,
  /\bseconde residence(s)?\b/i,
  /\bterrasse\b/i,
  /\bterrasses\b/i,
  /\benseigne\b/i,
  /\benseignes\b/i,
  /\bpublicite\b/i,
  /\bpublicitaire\b/i,
  /\boccupation du domaine public\b/i,
  /\bdomaine public\b/i,
  /\bsurface commerciale\b/i,
  /\bsurfaces commerciales\b/i,
  /\bimmeuble abandonne\b/i,
  /\bimmeubles abandonnes\b/i,
  /\bstationnement payant\b/i,
  /\bzone payante\b/i,
  /\bcommerce\b/i,
  /\bcommerces\b/i
];

/*
 * TERMES À EXCLURE LORSQU'ILS APPARAISSENT SEULS.
 */

const EXCLUDED_PATTERNS = [
  /\bmarche public\b/i,
  /\bmarches publics\b/i,
  /\bpersonnel\b/i,
  /\brecrutement\b/i,
  /\bsubvention\b/i,
  /\bsubventions\b/i,
  /\bcompte annuel\b/i,
  /\bcomptes annuels\b/i,
  /\bbudget\b/i,
  /\bfabrique d'eglise\b/i,
  /\bcirculation\b/i,
  /\bstationnement reserve\b/i,
  /\bpersonnes handicapees\b/i,
  /\blimitation de la vitesse\b/i,
  /\bzone de stationnement\b/i,
  /\binterdiction d'acces\b/i
];

/* ============================================================
   CLASSIFICATION
============================================================ */

function classifyFiscal(title, url, bodyText) {
  const titleNorm = normalizeText(title);
  const urlNorm = normalizeText(url);
  const bodyNorm = normalizeText(bodyText);

  /*
   * PRIORITÉ ABSOLUE AU TITRE.
   */

  for (const pattern of STRONG_TAX_PATTERNS) {
    if (pattern.test(titleNorm)) {
      /*
       * "budget", "comptes", etc. ne doivent pas être considérés
       * comme fiscaux uniquement parce qu'un autre mot apparaît
       * dans le titre.
       */

      if (
        /\bbudget\b/i.test(titleNorm) &&
        !/\btaxe\b|\bredevance\b|\bprecompte\b|\badditionnel\b|\bipp\b|\bfiscal/i.test(
          titleNorm
        )
      ) {
        continue;
      }

      return {
        fiscal: true,
        reason: `terme fiscal dans le titre`
      };
    }
  }

  /*
   * URL explicite.
   */

  for (const pattern of [
    /\breglement[- ]taxe\b/i,
    /\breglement[- ]redevance\b/i,
    /\bprecompte\b/i,
    /\bipp\b/i,
    /\bfiscal\b/i,
    /\btaxe\b/i,
    /\bredevance\b/i
  ]) {
    if (pattern.test(urlNorm)) {
      return {
        fiscal: true,
        reason: `terme fiscal dans l'URL`
      };
    }
  }

  /*
   * Contexte fiscal :
   * un terme contextuel doit apparaître AVEC un indice fiscal.
   */

  const hasTaxContext = TAX_CONTEXT_PATTERNS.some(pattern =>
    pattern.test(titleNorm)
  );

  const hasFiscalIndicator =
    /\btaxe\b|\btaxes\b|\bredevance\b|\bredevances\b|\bfiscal\b|\bfiscale\b|\bimposition\b|\bprecompte\b|\badditionnel\b|\bipp\b/i.test(
      titleNorm
    );

  if (hasTaxContext && hasFiscalIndicator) {
    return {
      fiscal: true,
      reason: `contexte fiscal dans le titre`
    };
  }

  /*
   * Le corps de la page ne peut PLUS déclencher seul une décision
   * fiscale. Il sert uniquement de confirmation.
   *
   * Cela évite les faux positifs dus à des noms de personnes,
   * des menus, des décisions voisines, etc.
   */

  const titleLooksRelevant =
    /\btaxe\b|\btaxes\b|\bredevance\b|\bredevances\b|\bprecompte\b|\badditionnel\b|\bipp\b|\bfiscal\b|\bfiscale\b|\bimposition\b/i.test(
      titleNorm
    );

  if (titleLooksRelevant) {
    return {
      fiscal: true,
      reason: `indice fiscal confirmé par la page`
    };
  }

  /*
   * Exclusions finales.
   */

  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.test(titleNorm)) {
      return {
        fiscal: false,
        reason: `terme excluant`
      };
    }
  }

  return {
    fiscal: false,
    reason: 'aucun indice fiscal suffisamment fiable'
  };
}

/* ============================================================
   SCRAPING DES PAGES
============================================================ */

async function scrapeYear(browser, commune) {
  const listPage = await browser.newPage();

  listPage.setDefaultNavigationTimeout(60000);

  const allDecisions = [];

  console.log('');
  console.log('========================================');
  console.log(`→ ${commune.name} (${commune.slug})`);
  console.log('========================================');

  for (let offset = 0; ; offset += PAGE_SIZE) {
    let url;

    if (offset === 0) {
      url = `${BASE_URL}/${commune.slug}/decisions`;
    } else {
      url =
        `${BASE_URL}/${commune.slug}/decisions/@@faceted_query` +
        `?b_start:int=${offset}`;
    }

    console.log('');
    console.log(`Page offset ${offset}`);
    console.log(`  → ${url}`);

    try {
      await listPage.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      const pageDecisions = await extractDecisionsFromList(listPage);

      const yearDecisions = pageDecisions.filter(decision => {
        const date = parseDateFromSlug(decision.url);

        return date && date.getFullYear() === TARGET_YEAR;
      });

      const uniquePageDecisions = dedupeDecisions(yearDecisions);

      const knownUrls = new Set(
        allDecisions.map(decision => decision.url)
      );

      const newDecisions = uniquePageDecisions.filter(
        decision => !knownUrls.has(decision.url)
      );

      console.log(
        `  ${uniquePageDecisions.length} décision(s) ${TARGET_YEAR} trouvée(s)`
      );

      console.log(
        `  ${newDecisions.length} nouvelle(s) décision(s)`
      );

      allDecisions.push(...newDecisions);

      if (uniquePageDecisions.length < PAGE_SIZE) {
        console.log('  Dernière page atteinte.');
        break;
      }

      /*
       * Sécurité absolue contre une éventuelle répétition.
       */

      if (newDecisions.length === 0) {
        console.log(
          '  Aucune nouvelle décision : arrêt de sécurité.'
        );
        break;
      }
    } catch (error) {
      console.log(
        `  ⚠ Erreur page ${offset}: ${error.message}`
      );
      break;
    }
  }

  await listPage.close();

  return dedupeDecisions(allDecisions);
}

/* ============================================================
   MAIN
============================================================ */

async function main() {
  console.log(
    `Lancement du scraper fiscal - année ${TARGET_YEAR}`
  );

  console.log('');
  console.log('TEST UNIQUEMENT : Liège');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors'
    ]
  });

  const outputPath = path.join(
    process.cwd(),
    'src',
    'data',
    'reglements-taxes.json'
  );

  let existingData = {};

  try {
    existingData = JSON.parse(
      fs.readFileSync(outputPath, 'utf8')
    );
  } catch {
    existingData = {};
  }

  for (const commune of COMMUNES) {
    const decisions = await scrapeYear(browser, commune);

    console.log('');
    console.log(
      `TOTAL : ${decisions.length} décision(s) ${TARGET_YEAR} récupérée(s).`
    );

    const detailPage = await browser.newPage();

    detailPage.setDefaultNavigationTimeout(60000);

    const fiscalDecisions = [];

    for (let i = 0; i < decisions.length; i++) {
      const decision = decisions[i];

      console.log(
        `Analyse ${i + 1}/${decisions.length}`
      );

      const details = await extractDecisionDetails(
        detailPage,
        decision.url,
        decision.title
      );

      const title =
        details.title || decision.title || '';

      const classification = classifyFiscal(
        title,
        decision.url,
        details.bodyText
      );

      if (classification.fiscal) {
        console.log(`  TITRE : ${title}`);
        console.log(
          `  FISCAL : OUI (${classification.reason})`
        );

        fiscalDecisions.push({
          date:
            parseDateFromSlug(decision.url)
              ?.toISOString()
              .slice(0, 10) || null,

          titre: title,

          matiere: '',

          url: decision.url
        });
      }
    }

    await detailPage.close();

    console.log('');
    console.log('========================================');
    console.log(
      `${fiscalDecisions.length} décision(s) fiscale(s) détectée(s)`
    );
    console.log('========================================');

    for (const item of fiscalDecisions) {
      console.log('');
      console.log(`DATE    : ${item.date}`);
      console.log(`TITRE   : ${item.titre}`);
      console.log(`URL     : ${item.url}`);
    }

    /*
     * Mise à jour uniquement de Liège.
     */

    existingData[commune.name] = {
      updatedAt: new Date().toISOString(),
      reglementsEnVigueur: fiscalDecisions,
      prochainesTaxes: []
    };
  }

  fs.writeFileSync(
    outputPath,
    JSON.stringify(existingData, null, 2),
    'utf8'
  );

  await browser.close();

  console.log('');
  console.log(
    `✓ Fichier mis à jour : ${outputPath}`
  );

  console.log('');
  console.log('✓ Scraping terminé.');
}

main().catch(error => {
  console.error('');
  console.error('❌ ERREUR FATALE');
  console.error(error);
  process.exit(1);
});
