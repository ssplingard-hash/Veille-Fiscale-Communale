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

  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTHS[normalizeText(match[2])];
  const year = Number(match[3]);

  if (month === undefined) return null;

  return new Date(year, month, day);
}

/*
 * Récupère TOUS les liens de décisions présents dans le HTML.
 *
 * On ne filtre plus sur le texte du lien.
 * Certaines décisions de Liège sont représentées par des liens
 * dont le texte n'est pas le titre complet.
 */
async function extractDecisionLinks(page) {
  return await page.evaluate(() => {
    const results = [];

    for (const link of document.querySelectorAll('a[href]')) {
      const href = link.href || '';

      if (!href.includes('/decisions/')) continue;

      if (href.includes('@@faceted_query')) continue;

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

function dedupe(items) {
  const map = new Map();

  for (const item of items) {
    if (!item.url) continue;

    if (!map.has(item.url)) {
      map.set(item.url, item);
    }
  }

  return Array.from(map.values());
}

/*
 * Récupération du titre directement depuis chaque décision.
 */
async function extractDecisionDetails(page, decision) {
  try {
    await page.goto(decision.url, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await new Promise(resolve => setTimeout(resolve, 400));

    return await page.evaluate(fallback => {
      const clean = value =>
        (value || '')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      let title = '';

      const h1 = document.querySelector('h1');

      if (h1) {
        title = clean(
          h1.innerText ||
          h1.textContent
        );
      }

      if (!title) {
        const og = document.querySelector(
          'meta[property="og:title"]'
        );

        if (og) {
          title = clean(
            og.getAttribute('content')
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
       * Extraction de la matière.
       */
      const body =
        clean(document.body?.innerText || '');

      let matiere = '';

      const matiereMatch =
        body.match(
          /Mati[eè]re\s*[:\-]?\s*([^\n]+)/i
        );

      if (matiereMatch) {
        matiere = clean(matiereMatch[1]);
      }

      return {
        title: title || fallback,
        matiere,
        bodyText: body
      };
    }, decision.text);
  } catch (error) {
    console.log(
      `  ⚠ Erreur détail : ${error.message}`
    );

    return {
      title: decision.text,
      matiere: '',
      bodyText: ''
    };
  }
}

/*
 * TERMES FISCAUX EXPLICITES.
 */
const TAX_PATTERNS = [
  /\breglement taxe\b/,
  /\breglement taxes\b/,
  /\breglement-taxe\b/,
  /\breglement-taxes\b/,
  /\breglement redevance\b/,
  /\breglement redevances\b/,
  /\breglement-redevance\b/,
  /\breglement-redevances\b/,
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

/*
 * Certaines matières peuvent aider,
 * mais "Finances" seul ne suffit PAS.
 */
const TAX_MATIERES = [
  /\bfiscal/,
  /\btax/,
  /\bimpot/,
  /\bredevance/,
  /\bprecompte/
];

/*
 * Faux positifs connus.
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
  url
) {
  const t = normalizeText(title);
  const m = normalizeText(matiere);
  const u = normalizeText(url);

  /*
   * Exclusions.
   */
  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.test(t)) {
      return {
        fiscal: false,
        reason: 'exclusion'
      };
    }
  }

  /*
   * Titre : critère principal.
   */
  for (const pattern of TAX_PATTERNS) {
    if (pattern.test(t)) {
      return {
        fiscal: true,
        reason: 'terme fiscal dans le titre'
      };
    }
  }

  /*
   * Matière explicitement fiscale.
   */
  for (const pattern of TAX_MATIERES) {
    if (pattern.test(m)) {
      return {
        fiscal: true,
        reason: 'matière fiscale'
      };
    }
  }

  /*
   * URL.
   */
  for (const pattern of TAX_PATTERNS) {
    if (pattern.test(u)) {
      return {
        fiscal: true,
        reason: 'terme fiscal dans URL'
      };
    }
  }

  return {
    fiscal: false,
    reason: 'aucun indice fiscal'
  };
}

async function scrapeCommune(
  browser,
  commune
) {
  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(60000);

  const queue = [
    `${BASE_URL}/${commune.slug}/decisions`
  ];

  const visited = new Set();
  const allLinks = [];

  while (queue.length > 0) {
    const url = queue.shift();

    if (visited.has(url)) continue;

    visited.add(url);

    console.log('');
    console.log(`Page ${visited.size}`);
    console.log(`  → ${url}`);

    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      await new Promise(resolve =>
        setTimeout(resolve, 500)
      );

      const links =
        await extractDecisionLinks(page);

      /*
       * Toutes les décisions trouvées sur cette page.
       */
      const yearLinks = links.filter(link => {
        const date =
          parseDateFromSlug(link.url);

        return (
          date &&
          date.getFullYear() === TARGET_YEAR
        );
      });

      console.log(
        `  ${links.length} lien(s) de décision`
      );

      console.log(
        `  ${yearLinks.length} décision(s) ${TARGET_YEAR}`
      );

      allLinks.push(...yearLinks);

      /*
       * Pagination.
       *
       * On récupère TOUS les liens @@faceted_query.
       */
      const pagination =
        await page.evaluate(() => {
          return Array.from(
            document.querySelectorAll(
              'a[href*="@@faceted_query"]'
            )
          ).map(a => a.href);
        });

      const uniquePagination =
        [...new Set(pagination)];

      console.log(
        `  ${uniquePagination.length} pagination(s)`
      );

      for (const nextUrl of uniquePagination) {
        if (!visited.has(nextUrl)) {
          queue.push(nextUrl);
        }
      }

    } catch (error) {
      console.log(
        `  ⚠ Erreur : ${error.message}`
      );
    }
  }

  await page.close();

  return dedupe(allLinks);
}

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

  for (const commune of COMMUNES) {
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
     * Protection :
     * si le scraper récupère moins de 20 décisions,
     * on NE remplace PAS les données existantes.
     *
     * Cela évite de vider accidentellement Liège.
     */
    if (decisions.length < 20) {
      console.log('');
      console.log(
        '⚠️ PROTECTION ACTIVÉE'
      );

      console.log(
        'Moins de 20 décisions récupérées.'
      );

      console.log(
        'Les données existantes ne seront PAS écrasées.'
      );

      continue;
    }

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
          decision.url
        );

      console.log(
        `  TITRE   : ${details.title}`
      );

      console.log(
        `  MATIERE : ${
          details.matiere || '[VIDE]'
        }`
      );

      console.log(
        `  FISCAL  : ${
          classification.fiscal
            ? 'OUI'
            : 'NON'
        }`
      );

      if (classification.fiscal) {
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
          date: date
            ? date
                .toISOString()
                .slice(0, 10)
            : null,

          titre: details.title,

          matiere:
            details.matiere || '',

          url: decision.url
        });
      }
    }

    await detailPage.close();

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
      const item of fiscalDecisions
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

    existingData[commune.name] = {
      updatedAt:
        new Date().toISOString(),

      reglementsEnVigueur:
        fiscalDecisions,

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
