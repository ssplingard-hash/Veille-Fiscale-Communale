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
 * EXTRACTION DES DÉCISIONS DEPUIS LA LISTE
 * ============================================================
 *
 * IMPORTANT :
 * On travaille sur les blocs individuels de décision.
 *
 * On ne récupère plus le bodyText complet de la page pour
 * déterminer si une décision est fiscale.
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

      const text = clean(
        link.innerText ||
        link.textContent ||
        ''
      );

      if (!text) {
        continue;
      }

      /*
       * Cherche le conteneur de la décision.
       *
       * On remonte quelques niveaux afin de récupérer le texte
       * réellement associé à ce lien.
       */

      let container = link;

      for (let i = 0; i < 6; i++) {
        if (!container.parentElement) {
          break;
        }

        const candidate = container.parentElement;

        const candidateText = clean(
          candidate.innerText ||
          candidate.textContent ||
          ''
        );

        if (
          candidateText.length > text.length &&
          candidateText.length < 2500
        ) {
          container = candidate;
        }
      }

      const containerText = clean(
        container.innerText ||
        container.textContent ||
        ''
      );

      /*
       * Recherche de la matière dans le bloc.
       */

      let matiere = '';

      const matterMatch = containerText.match(
        /Mati[eè]re\s+(.+?)(?=\s+Mandataire\b|\s+\d+\s*$)/i
      );

      if (matterMatch) {
        matiere = clean(matterMatch[1]);
      }

      results.push({
        url: href,
        text,
        context: containerText,
        matiere
      });
    }

    return results;
  });
}

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
 * CLASSIFICATION FISCALE
 * ============================================================
 *
 * RÈGLE :
 *
 * 1. Un règlement-taxe / règlement de redevance explicite
 *    dans le TITRE = fiscal.
 *
 * 2. Certains termes fiscaux très explicites dans le TITRE
 *    = fiscal.
 *
 * 3. Une matière explicitement fiscale = fiscal.
 *
 * 4. Les termes génériques "taxe", "redevance", "Finances",
 *    etc. dans le contexte général NE suffisent PAS.
 *
 * 5. Le contenu général de la page n'est plus utilisé pour
 *    classifier la décision.
 */

const TITLE_FISCAL_PATTERNS = [
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

  /\bforce motrice\b/
];

const MATIERE_FISCALE_PATTERNS = [
  /\bfiscal/,
  /\btax/,
  /\bimpot/,
  /\bredevance/,
  /\bprecompte/
];

const EXCLUDED_TITLE_PATTERNS = [
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
  /\binterdiction d acces\b/,
  /\bbail commercial\b/,
  /\bbail type\b/,
  /\bconvention de bail\b/
];

function classifyFiscal(title, matiere) {
  const titleNorm = normalizeText(title);
  const matiereNorm = normalizeText(matiere);

  /*
   * ----------------------------------------------------------
   * 1. EXCLUSIONS
   * ----------------------------------------------------------
   */

  for (const pattern of EXCLUDED_TITLE_PATTERNS) {
    if (pattern.test(titleNorm)) {
      return {
        fiscal: false,
        reason: 'titre explicitement exclu'
      };
    }
  }

  /*
   * ----------------------------------------------------------
   * 2. TITRE FISCAL EXPLICITE
   * ----------------------------------------------------------
   */

  for (const pattern of TITLE_FISCAL_PATTERNS) {
    if (pattern.test(titleNorm)) {
      return {
        fiscal: true,
        reason: 'terme fiscal explicite dans le titre'
      };
    }
  }

  /*
   * ----------------------------------------------------------
   * 3. MATIÈRE FISCALE
   * ----------------------------------------------------------
   */

  for (const pattern of MATIERE_FISCALE_PATTERNS) {
    if (pattern.test(matiereNorm)) {
      return {
        fiscal: true,
        reason: 'matière fiscale'
      };
    }
  }

  /*
   * ----------------------------------------------------------
   * 4. PAR DÉFAUT
   * ----------------------------------------------------------
   */

  return {
    fiscal: false,
    reason: 'aucun indice fiscal fiable'
  };
}

/*
 * ============================================================
 * SCRAPING LIÈGE
 * ============================================================
 */

async function scrapeCommune(browser, commune) {
  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(60000);

  const queue = [
    `${BASE_URL}/${commune.slug}/decisions`
  ];

  const visited = new Set();
  const allLinks = [];

  while (queue.length > 0) {
    const url = queue.shift();

    if (visited.has(url)) {
      continue;
    }

    visited.add(url);

    console.log('');
    console.log(`Page ${visited.size}`);
    console.log(`  → ${url}`);

    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      await new Promise(resolve => {
        setTimeout(resolve, 500);
      });

      const links = await extractDecisionLinks(page);

      const yearLinks = links.filter(link => {
        const date = parseDateFromSlug(link.url);

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

      /*
       * Affichage diagnostic des matières réellement récupérées.
       */

      for (const item of yearLinks) {
        console.log(
          `    - ${item.text.substring(0, 120)}`
        );

        console.log(
          `      MATIERE : ${item.matiere || '[VIDE]'}`
        );
      }

      allLinks.push(...yearLinks);

      /*
       * Pagination.
       */

      const pagination = await page.evaluate(() => {
        return Array.from(
          document.querySelectorAll(
            'a[href*="@@faceted_query"]'
          )
        ).map(link => link.href);
      });

      const uniquePagination = [
        ...new Set(pagination)
      ];

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

    const decisions = await scrapeCommune(
      browser,
      commune
    );

    console.log('');
    console.log(
      `TOTAL : ${decisions.length} décision(s) ${TARGET_YEAR}`
    );

    /*
     * Protection contre une récupération anormalement faible.
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
        'Les données existantes ne sont PAS écrasées.'
      );

      continue;
    }

    /*
     * Classification directement depuis les données
     * extraites de la liste des décisions.
     */

    const fiscalDecisions = [];

    for (let i = 0; i < decisions.length; i++) {
      const decision = decisions[i];

      const date = parseDateFromSlug(
        decision.url
      );

      const classification = classifyFiscal(
        decision.text,
        decision.matiere
      );

      console.log('');
      console.log(
        `Analyse ${i + 1}/${decisions.length}`
      );

      console.log(
        `  TITRE   : ${decision.text}`
      );

      console.log(
        `  MATIERE : ${decision.matiere || '[VIDE]'}`
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
          `  RAISON  : ${classification.reason}`
        );

        fiscalDecisions.push({
          date: date
            ? date.toISOString().slice(0, 10)
            : null,

          titre: decision.text,

          matiere:
            decision.matiere || '',

          url:
            decision.url
        });
      }
    }

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

    for (const item of fiscalDecisions) {
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

  console.error(error);

  process.exit(1);
});
