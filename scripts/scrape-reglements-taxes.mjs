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

async function extractPageData(page) {
  return await page.evaluate(() => {
    const clean = value =>
      (value || '')
        .replace(/\s+/g, ' ')
        .replace(/\u00a0/g, ' ')
        .trim();

    const decisions = [];
    const links = Array.from(document.querySelectorAll('a[href]'));

    for (const link of links) {
      const href = link.href || '';
      const text = clean(link.innerText || link.textContent);

      if (!href.includes('/decisions/')) continue;

      if (
        href.includes('@@faceted_query') ||
        href.endsWith('/decisions') ||
        href.endsWith('/decisions/')
      ) {
        continue;
      }

      if (!text || text.length < 10) continue;

      decisions.push({
        url: href,
        title: text
      });
    }

    const pagination = [];

    for (const link of links) {
      const href = link.href || '';
      const text = clean(link.innerText || link.textContent);

      if (!href.includes('@@faceted_query')) continue;

      pagination.push({
        url: href,
        text
      });
    }

    return {
      decisions,
      pagination,
      bodyText: clean(document.body?.innerText || '')
    };
  });
}

function dedupeByUrl(items) {
  const map = new Map();

  for (const item of items) {
    if (!item.url) continue;

    if (!map.has(item.url)) {
      map.set(item.url, item);
    }
  }

  return Array.from(map.values());
}

function extractYearDecisions(decisions) {
  return decisions.filter(decision => {
    const date = parseDateFromSlug(decision.url);

    return date && date.getFullYear() === TARGET_YEAR;
  });
}

async function scrapeDecisionDetails(page, decision) {
  try {
    await page.goto(decision.url, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await new Promise(resolve => setTimeout(resolve, 400));

    return await page.evaluate(fallbackTitle => {
      const clean = value =>
        (value || '')
          .replace(/\s+/g, ' ')
          .replace(/\u00a0/g, ' ')
          .trim();

      let title = '';

      const h1 = document.querySelector('h1');

      if (h1) {
        title = clean(h1.innerText || h1.textContent);
      }

      if (!title) {
        const ogTitle = document.querySelector(
          'meta[property="og:title"]'
        );

        if (ogTitle) {
          title = clean(ogTitle.getAttribute('content'));
        }
      }

      if (!title) {
        const titleTag = document.querySelector('title');

        if (titleTag) {
          title = clean(
            titleTag.innerText || titleTag.textContent
          );
        }
      }

      const bodyText = clean(document.body?.innerText || '');

      return {
        title: title || fallbackTitle,
        bodyText
      };
    }, decision.title);
  } catch (error) {
    console.log(
      `  ⚠ Erreur détail : ${error.message}`
    );

    return {
      title: decision.title,
      bodyText: ''
    };
  }
}

/*
 * IMPORTANT :
 * Les termes sont testés sur du texte normalisé SANS accents.
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
  /\bfiscal\b/,
  /\bfiscale\b/,
  /\bfiscalite\b/,
  /\bimposition\b/,
  /\bimpositions\b/
];

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

function classifyFiscal(title, url) {
  const titleNorm = normalizeText(title);
  const urlNorm = normalizeText(url);

  /*
   * Les exclusions passent en premier.
   * Cela évite par exemple de considérer une décision
   * sur le stationnement comme une taxe.
   */
  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.test(titleNorm)) {
      return {
        fiscal: false,
        reason: 'terme excluant'
      };
    }
  }

  /*
   * Priorité absolue aux termes fiscaux explicites
   * dans le TITRE.
   */
  for (const pattern of STRONG_TAX_PATTERNS) {
    if (pattern.test(titleNorm)) {
      return {
        fiscal: true,
        reason: 'terme fiscal explicite dans le titre'
      };
    }
  }

  /*
   * Vérification de l'URL.
   */
  for (const pattern of [
    /\breglement[- ]taxe\b/,
    /\breglement[- ]redevance\b/,
    /\bprecompte\b/,
    /\bipp\b/,
    /\bfiscal\b/,
    /\btaxe\b/,
    /\bredevance\b/
  ]) {
    if (pattern.test(urlNorm)) {
      return {
        fiscal: true,
        reason: 'terme fiscal dans URL'
      };
    }
  }

  /*
   * Contexte fiscal secondaire.
   * Un simple "commerce", "terrasse", etc. NE suffit PAS.
   */
  const hasContext = TAX_CONTEXT_PATTERNS.some(
    pattern => pattern.test(titleNorm)
  );

  const hasFiscalIndicator =
    /\btaxe\b|\btaxes\b|\bredevance\b|\bredevances\b|\bprecompte\b|\badditionnel\b|\bipp\b|\bfiscal\b|\bfiscale\b|\bimposition\b/.test(
      titleNorm
    );

  if (hasContext && hasFiscalIndicator) {
    return {
      fiscal: true,
      reason: 'contexte fiscal'
    };
  }

  return {
    fiscal: false,
    reason: 'aucun indice fiscal fiable'
  };
}

async function scrapeYear(browser, commune) {
  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(60000);

  const allDecisions = [];
  const visitedPages = new Set();

  /*
   * On commence par la page principale.
   */
  const firstUrl =
    `${BASE_URL}/${commune.slug}/decisions`;

  const queue = [firstUrl];

  console.log('');
  console.log('========================================');
  console.log(`→ ${commune.name} (${commune.slug})`);
  console.log('========================================');

  while (queue.length > 0) {
    const url = queue.shift();

    if (visitedPages.has(url)) {
      continue;
    }

    visitedPages.add(url);

    console.log('');
    console.log(`Page ${visitedPages.size}`);
    console.log(`  → ${url}`);

    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      const data = await extractPageData(page);

      const pageYearDecisions =
        extractYearDecisions(data.decisions);

      const uniquePageDecisions =
        dedupeByUrl(pageYearDecisions);

      const knownUrls = new Set(
        allDecisions.map(decision => decision.url)
      );

      const newDecisions =
        uniquePageDecisions.filter(
          decision => !knownUrls.has(decision.url)
        );

      allDecisions.push(...newDecisions);

      console.log(
        `  ${data.decisions.length} lien(s) décision trouvé(s)`
      );

      console.log(
        `  ${uniquePageDecisions.length} décision(s) ${TARGET_YEAR}`
      );

      console.log(
        `  ${newDecisions.length} nouvelle(s)`
      );

      /*
       * IMPORTANT :
       * On récupère les vrais liens de pagination fournis
       * par deliberations.be.
       *
       * On ne fabrique PLUS les URLs avec b_start:int.
       */
      for (const pagination of data.pagination) {
        if (!visitedPages.has(pagination.url)) {
          queue.push(pagination.url);
        }
      }

      console.log(
        `  ${data.pagination.length} lien(s) de pagination détecté(s)`
      );

      /*
       * Si une page contient des décisions 2025 ou plus anciennes,
       * on pourra arrêter lorsque la pagination ne donne plus
       * aucune décision 2026.
       *
       * On ne le fait toutefois qu'après avoir récupéré les liens
       * de pagination de la page.
       */
    } catch (error) {
      console.log(
        `  ⚠ Erreur : ${error.message}`
      );
    }
  }

  await page.close();

  return dedupeByUrl(allDecisions);
}

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
    const decisions =
      await scrapeYear(browser, commune);

    console.log('');
    console.log(
      `TOTAL : ${decisions.length} décision(s) ${TARGET_YEAR} récupérée(s).`
    );

    if (decisions.length === 0) {
      console.log(
        '⚠ Aucune décision 2026 récupérée.'
      );

      continue;
    }

    /*
     * Affichage d'un échantillon pour contrôler que
     * nous récupérons bien les bonnes décisions.
     */
    console.log('');
    console.log('--- PREMIÈRES DÉCISIONS RÉCUPÉRÉES ---');

    for (
      const decision of decisions.slice(0, 10)
    ) {
      const date = parseDateFromSlug(decision.url);

      console.log(
        `${date?.toISOString().slice(0, 10)} | ${decision.title}`
      );
    }

    const detailPage =
      await browser.newPage();

    detailPage.setDefaultNavigationTimeout(60000);

    const fiscalDecisions = [];

    for (
      let i = 0;
      i < decisions.length;
      i++
    ) {
      const decision = decisions[i];

      console.log(
        `Analyse ${i + 1}/${decisions.length}`
      );

      const details =
        await scrapeDecisionDetails(
          detailPage,
          decision
        );

      const title =
        details.title ||
        decision.title ||
        '';

      const classification =
        classifyFiscal(
          title,
          decision.url
        );

      console.log(
        `  TITRE : ${title}`
      );

      console.log(
        `  FISCAL : ${classification.fiscal ? 'OUI' : 'NON'}`
      );

      if (classification.fiscal) {
        console.log(
          `  RAISON : ${classification.reason}`
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
      console.log(`DATE  : ${item.date}`);
      console.log(`TITRE : ${item.titre}`);
      console.log(`URL   : ${item.url}`);
    }

    existingData[commune.name] = {
      updatedAt: new Date().toISOString(),
      reglementsEnVigueur: fiscalDecisions,
      prochainesTaxes: []
    };
  }

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
  console.log('✓ Scraping terminé.');
}

main().catch(error => {
  console.error('');
  console.error('❌ ERREUR FATALE');
  console.error(error);

  process.exit(1);
});
