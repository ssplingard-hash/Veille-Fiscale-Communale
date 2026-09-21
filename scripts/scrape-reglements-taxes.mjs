import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

const BASE_URL = 'https://www.deliberations.be';
const LIEGE_URL = `${BASE_URL}/liege/decisions`;

const TARGET_YEAR = 2026;

const PAGE_TIMEOUT_MS = 30000;
const LIST_WAIT_MS = 1000;
const DETAIL_WAIT_MS = 300;

const MIN_EXPECTED_DECISIONS = 500;
const MIN_EXPECTED_FISCAL = 1;

/*
 * Nombre de pages Puppeteer utilisées simultanément.
 * 5 est volontairement raisonnable pour GitHub Actions.
 */
const CONCURRENCY = 5;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForSearch(text) {
  return normalizeText(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function parseDateFromSlug(url) {
  const match = url.match(
    /\/(\d{1,2})-([a-zéûàâîôùç]+)-(\d{4})/i
  );

  if (!match) return null;

  const day = Number(match[1]);
  const monthName = match[2].toLowerCase();
  const year = Number(match[3]);

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

  if (months[monthName] === undefined) {
    return null;
  }

  return new Date(
    Date.UTC(
      year,
      months[monthName],
      day
    )
  );
}

function titleFromUrl(url) {
  try {
    const pathname =
      new URL(url).pathname;

    const parts =
      pathname
        .split('/')
        .filter(Boolean);

    const slug =
      parts[parts.length - 1];

    if (!slug) return '';

    return decodeURIComponent(slug)
      .replace(/\.pdf$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, c => c.toUpperCase());

  } catch {
    return '';
  }
}

function getRealTitle(linkTitle, url) {
  const slugTitle =
    titleFromUrl(url);

  if (
    slugTitle &&
    slugTitle.length >= 5
  ) {
    return slugTitle;
  }

  return (
    normalizeText(linkTitle) ||
    'Décision'
  );
}

async function extractDecisionLinks(page) {
  return await page.evaluate(() => {
    const results = [];

    for (
      const a of document.querySelectorAll('a[href]')
    ) {
      const href =
        a.href || '';

      if (
        !href.includes(
          '/liege/decisions/'
        )
      ) {
        continue;
      }

      if (
        href.includes(
          '@@faceted_query'
        )
      ) {
        continue;
      }

      const pathname =
        new URL(href).pathname;

      const parts =
        pathname
          .split('/')
          .filter(Boolean);

      if (
        parts.length < 4
      ) {
        continue;
      }

      results.push({
        url: href,

        linkTitle:
          (
            a.innerText ||
            a.textContent ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim()
      });
    }

    return results;
  });
}

/*
 * Récupération du contenu complet de la décision.
 */
async function extractPageContent(page) {
  return await page.evaluate(() => {
    const body =
      document.body;

    if (!body) {
      return '';
    }

    return (
      body.innerText ||
      body.textContent ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
  });
}

/*
 * Récupération de la matière.
 */
async function extractMatiere(page) {
  return await page.evaluate(() => {
    const elements = [
      ...document.querySelectorAll(
        'dt, dd, th, td, div, span, p, strong, b'
      )
    ];

    for (
      const element
      of elements
    ) {
      const text =
        (
          element.innerText ||
          element.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();

      if (
        !/^mati[eè]re\s*:?\s*$/i.test(
          text
        )
      ) {
        continue;
      }

      const next =
        element.nextElementSibling;

      if (next) {
        const nextText =
          (
            next.innerText ||
            next.textContent ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim();

        if (
          nextText &&
          !/^mati[eè]re/i.test(
            nextText
          )
        ) {
          return nextText;
        }
      }

      const parent =
        element.parentElement;

      if (parent) {
        const parentText =
          (
            parent.innerText ||
            parent.textContent ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim();

        const match =
          parentText.match(
            /^mati[eè]re\s*:?\s*(.+)$/i
          );

        if (
          match &&
          match[1]
        ) {
          return match[1].trim();
        }
      }
    }

    return '';
  });
}

/*
 * =====================================================
 * CLASSIFICATION
 * =====================================================
 *
 * IMPORTANT :
 * On distingue les véritables matières fiscales
 * des simples occurrences de mots fiscaux dans
 * une décision.
 */

function classifyFiscalDecision(
  titre,
  matiere,
  contenu
) {
  const t =
    normalizeForSearch(titre);

  const m =
    normalizeForSearch(matiere);

  const c =
    normalizeForSearch(contenu);

  const raisons = [];
  const exclusions = [];

  /*
   * EXCLUSIONS FORTES SUR LE TITRE
   */

  if (
    /\bbail\b/.test(t)
  ) {
    exclusions.push(
      'BAIL'
    );
  }

  if (
    /\bmarches publics\b/.test(t) ||
    /\bmarches public\b/.test(t)
  ) {
    exclusions.push(
      'MARCHES_PUBLICS'
    );
  }

  if (
    /\bquestions ecrites\b/.test(t) ||
    /\border[eé] du jour\b/.test(t) ||
    /\baddendum\b/.test(t)
  ) {
    exclusions.push(
      'DOCUMENT_CONSEIL'
    );
  }

  /*
   * STATIONNEMENT :
   *
   * Les décisions de simple extension de zone payante
   * ne sont pas retenues.
   */
  if (
    (
      /\bstationnement\b/.test(t) ||
      /\bzone payante\b/.test(t) ||
      /\bzone bleue\b/.test(t) ||
      /\bzone rouge\b/.test(t)
    ) &&
    !(
      /\btaxe\b/.test(t) ||
      /\bredevance\b/.test(t) ||
      /\bprecompte\b/.test(t) ||
      /\bcentimes additionnels\b/.test(t) ||
      /\bimpot\b/.test(t)
    )
  ) {
    exclusions.push(
      'STATIONNEMENT'
    );
  }

  /*
   * TVA :
   * une décision communale relative à la TVA
   * n'est pas une taxe communale.
   */
  if (
    /\btva\b/.test(t)
  ) {
    exclusions.push(
      'TVA'
    );
  }

  /*
   * =====================================================
   * SIGNAUX TRÈS FORTS
   * =====================================================
   */

  const strongSignals = [
    [
      /\breglement[- ]taxe\b/,
      'REGLEMENT_TAXE'
    ],
    [
      /\breglement[- ]redevance\b/,
      'REGLEMENT_REDEVANCE'
    ],
    [
      /\btaxe communale\b/,
      'TAXE_COMMUNALE'
    ],
    [
      /\bredevance communale\b/,
      'REDEVANCE_COMMUNALE'
    ],
    [
      /\bprecompte immobilier\b/,
      'PRECOMPTE_IMMOBILIER'
    ],
    [
      /\bcentimes additionnels\b/,
      'CENTIMES_ADDITIONNELS'
    ],
    [
      /\bforce motrice\b/,
      'FORCE_MOTRICE'
    ],
    [
      /\bimpot des personnes physiques\b/,
      'IPP'
    ],
    [
      /\bimpots communaux\b/,
      'IMPOTS_COMMUNAUX'
    ]
  ];

  for (
    const [regex, reason]
    of strongSignals
  ) {
    if (
      regex.test(t)
    ) {
      raisons.push(
        reason
      );
    }
  }

  /*
   * =====================================================
   * SIGNAUX DANS LA MATIÈRE
   * =====================================================
   */

  if (
    /\bfiscal/.test(m)
  ) {
    raisons.push(
      'MATIERE_FISCALE'
    );
  }

  if (
    /\btaxe\b/.test(m)
  ) {
    raisons.push(
      'MATIERE_TAXE'
    );
  }

  if (
    /\bredevance\b/.test(m)
  ) {
    raisons.push(
      'MATIERE_REDEVANCE'
    );
  }

  /*
   * =====================================================
   * SIGNAUX DANS LE CONTENU
   * =====================================================
   *
   * Nous cherchons ici des combinaisons, pas simplement
   * la présence du mot "taxe".
   */

  if (
    /\breglement[- ]taxe\b/.test(c)
  ) {
    raisons.push(
      'CONTENU_REGLEMENT_TAXE'
    );
  }

  if (
    /\breglement[- ]redevance\b/.test(c)
  ) {
    raisons.push(
      'CONTENU_REGLEMENT_REDEVANCE'
    );
  }

  if (
    /\bprecompte immobilier\b/.test(c)
  ) {
    raisons.push(
      'CONTENU_PRECOMPTE'
    );
  }

  if (
    /\bcentimes additionnels\b/.test(c)
  ) {
    raisons.push(
      'CONTENU_CENTIMES'
    );
  }

  if (
    /\bforce motrice\b/.test(c)
  ) {
    raisons.push(
      'CONTENU_FORCE_MOTRICE'
    );
  }

  /*
   * =====================================================
   * COMBINAISONS FISCALES
   * =====================================================
   */

  const hasTax =
    /\btaxe\b/.test(c);

  const hasRate =
    /\btaux\b|\btarif\b|\bmontant\b|\bcentimes\b/.test(c);

  const hasMunicipal =
    /\bcommune\b|\bcommunal\b|\bville de liege\b/.test(c);

  if (
    hasTax &&
    hasRate &&
    hasMunicipal
  ) {
    raisons.push(
      'TAXE_TAUX_COMMUNAL_CONTENU'
    );
  }

  const hasRedevance =
    /\bredevance\b/.test(c);

  if (
    hasRedevance &&
    hasRate &&
    hasMunicipal
  ) {
    raisons.push(
      'REDEVANCE_TARIF_COMMUNAL_CONTENU'
    );
  }

  /*
   * =====================================================
   * EXCLUSIONS
   * =====================================================
   */

  if (
    exclusions.length > 0
  ) {
    return {
      niveau:
        'NON_FISCAL',

      raisons,

      exclusions
    };
  }

  /*
   * =====================================================
   * DÉCISION
   * =====================================================
   */

  const certain =
    raisons.some(
      reason =>
        [
          'REGLEMENT_TAXE',
          'REGLEMENT_REDEVANCE',
          'TAXE_COMMUNALE',
          'REDEVANCE_COMMUNALE',
          'PRECOMPTE_IMMOBILIER',
          'CENTIMES_ADDITIONNELS',
          'FORCE_MOTRICE',
          'IPP',
          'IMPOTS_COMMUNAUX',
          'CONTENU_REGLEMENT_TAXE',
          'CONTENU_REGLEMENT_REDEVANCE',
          'CONTENU_PRECOMPTE',
          'CONTENU_CENTIMES',
          'CONTENU_FORCE_MOTRICE'
        ].includes(reason)
    );

  if (
    certain
  ) {
    return {
      niveau:
        'FISCAL_CERTAIN',

      raisons,

      exclusions
    };
  }

  /*
   * Les combinaisons contenu + matière
   * sont considérées comme probables.
   */
  if (
    raisons.length >= 2
  ) {
    return {
      niveau:
        'FISCAL_PROBABLE',

      raisons,

      exclusions
    };
  }

  return {
    niveau:
      'NON_FISCAL',

    raisons,

    exclusions
  };
}

/*
 * =====================================================
 * RÉCUPÉRATION DES 761 DÉCISIONS
 * =====================================================
 */

async function scrapeAllDecisions(page) {
  const allDecisions =
    new Map();

  let offset = 0;

  while (true) {
    const url =
      offset === 0
        ? LIEGE_URL
        : `${LIEGE_URL}/@@faceted_query?b_start:int=${offset}`;

    console.log('');
    console.log(
      `Page offset ${offset}`
    );

    console.log(
      `→ ${url}`
    );

    await page.goto(
      url,
      {
        waitUntil: 'networkidle2',
        timeout: PAGE_TIMEOUT_MS
      }
    );

    await sleep(
      LIST_WAIT_MS
    );

    const links =
      await extractDecisionLinks(
        page
      );

    const yearLinks =
      links.filter(
        link => {
          const date =
            parseDateFromSlug(
              link.url
            );

          return (
            date &&
            date.getUTCFullYear() ===
            TARGET_YEAR
          );
        }
      );

    let newCount = 0;

    for (
      const link
      of yearLinks
    ) {
      if (
        allDecisions.has(
          link.url
        )
      ) {
        continue;
      }

      const date =
        parseDateFromSlug(
          link.url
        );

      allDecisions.set(
        link.url,
        {
          date:
            date
              .toISOString()
              .slice(0, 10),

          titre:
            getRealTitle(
              link.linkTitle,
              link.url
            ),

          matiere: '',

          contenu: '',

          url:
            link.url
        }
      );

      newCount++;
    }

    console.log(
      `  ${yearLinks.length} décision(s) 2026`
    );

    console.log(
      `  ${newCount} nouvelle(s)`
    );

    if (
      yearLinks.length < 20
    ) {
      console.log(
        '  Dernière page atteinte.'
      );

      break;
    }

    offset += 20;
  }

  return [
    ...allDecisions.values()
  ];
}

/*
 * =====================================================
 * ANALYSE DES DÉCISIONS
 * =====================================================
 */

async function analyseDecision(
  browser,
  decision,
  index,
  total
) {
  const page =
    await browser.newPage();

  try {
    await page.goto(
      decision.url,
      {
        waitUntil: 'networkidle2',
        timeout: PAGE_TIMEOUT_MS
      }
    );

    await sleep(
      DETAIL_WAIT_MS
    );

    decision.matiere =
      normalizeText(
        await extractMatiere(
          page
        )
      );

    decision.contenu =
      normalizeText(
        await extractPageContent(
          page
        )
      );

    decision.analyse =
      classifyFiscalDecision(
        decision.titre,
        decision.matiere,
        decision.contenu
      );

    /*
     * On ne loggue pas le contenu complet.
     * Seulement les décisions qui présentent
     * un signal fiscal.
     */
    if (
      decision.analyse.niveau !==
      'NON_FISCAL'
    ) {
      console.log('');
      console.log(
        `✓ CANDIDAT ${index}/${total}`
      );

      console.log(
        `${decision.date} | ${decision.titre}`
      );

      console.log(
        `NIVEAU : ${decision.analyse.niveau}`
      );

      console.log(
        `MATIÈRE : ${
          decision.matiere ||
          '(inconnue)'
        }`
      );

      console.log(
        `RAISONS : ${
          decision.analyse.raisons.join(
            ', '
          )
        }`
      );

      console.log(
        `URL : ${decision.url}`
      );
    }

    return decision;

  } catch (error) {
    console.log(
      `⚠️ ${index}/${total} — erreur : ${decision.titre}`
    );

    decision.matiere = '';
    decision.contenu = '';

    decision.analyse = {
      niveau:
        'NON_FISCAL',

      raisons: [
        'ERREUR_LECTURE'
      ],

      exclusions: []
    };

    return decision;

  } finally {
    await page.close();
  }
}

async function analyseToutesLesDecisions(
  browser,
  decisions
) {
  const results = [];

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex =
        nextIndex++;

      if (
        currentIndex >=
        decisions.length
      ) {
        return;
      }

      const decision =
        decisions[currentIndex];

      const result =
        await analyseDecision(
          browser,
          decision,
          currentIndex + 1,
          decisions.length
        );

      results[currentIndex] =
        result;
    }
  }

  const workers =
    Array.from(
      {
        length:
          Math.min(
            CONCURRENCY,
            decisions.length
          )
      },
      () => worker()
    );

  await Promise.all(
    workers
  );

  return results;
}

/*
 * =====================================================
 * MAIN
 * =====================================================
 */

async function main() {
  console.log('');
  console.log(
    '========================================'
  );

  console.log(
    'SCRAPER FISCAL V8 — LIÈGE'
  );

  console.log(
    `ANNÉE : ${TARGET_YEAR}`
  );

  console.log(
    `CONCURRENCE : ${CONCURRENCY}`
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
    /*
     * 1. Récupération des décisions.
     */
    const listPage =
      await browser.newPage();

    const decisions =
      await scrapeAllDecisions(
        listPage
      );

    await listPage.close();

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      `TOTAL : ${decisions.length} décisions ${TARGET_YEAR}`
    );

    console.log(
      '========================================'
    );

    if (
      decisions.length <
      MIN_EXPECTED_DECISIONS
    ) {
      console.log('');
      console.log(
        '⚠️ PROTECTION ACTIVÉE'
      );

      console.log(
        `Seulement ${decisions.length} décisions récupérées.`
      );

      console.log(
        `Minimum requis : ${MIN_EXPECTED_DECISIONS}.`
      );

      console.log(
        "AUCUNE DONNÉE N'EST MODIFIÉE."
      );

      return;
    }

    /*
     * 2. Analyse de TOUTES les décisions.
     */
    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'ANALYSE DES 761 DÉCISIONS'
    );

    console.log(
      '========================================'
    );

    const analysed =
      await analyseToutesLesDecisions(
        browser,
        decisions
      );

    /*
     * 3. Résultat.
     */
    const finalCandidates =
      analysed.filter(
        decision =>
          decision &&
          decision.analyse &&
          decision.analyse.niveau !==
          'NON_FISCAL'
      );

    const certains =
      finalCandidates.filter(
        decision =>
          decision.analyse.niveau ===
          'FISCAL_CERTAIN'
      );

    const probables =
      finalCandidates.filter(
        decision =>
          decision.analyse.niveau ===
          'FISCAL_PROBABLE'
      );

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      `DÉCISIONS FISCALES RETENUES : ${finalCandidates.length}`
    );

    console.log(
      '========================================'
    );

    console.log(
      `Fiscal certain : ${certains.length}`
    );

    console.log(
      `Fiscal probable : ${probables.length}`
    );

    /*
     * 4. Affichage complet des résultats.
     */
    for (
      const decision
      of finalCandidates
    ) {
      console.log('');
      console.log(
        '----------------------------------------'
      );

      console.log(
        `${decision.date} | ${decision.titre}`
      );

      console.log(
        `NIVEAU : ${decision.analyse.niveau}`
      );

      console.log(
        `MATIÈRE : ${
          decision.matiere ||
          '(inconnue)'
        }`
      );

      console.log(
        `RAISONS : ${
          decision.analyse.raisons.join(
            ', '
          )
        }`
      );

      console.log(
        `URL : ${decision.url}`
      );
    }

    /*
     * 5. Protection.
     */
    if (
      finalCandidates.length <
      MIN_EXPECTED_FISCAL
    ) {
      console.log('');
      console.log(
        '========================================'
      );

      console.log(
        '⚠️ PROTECTION FISCALE ACTIVÉE'
      );

      console.log(
        'Aucune décision fiscale exploitable.'
      );

      console.log(
        "LE JSON EXISTANT N'EST PAS MODIFIÉ."
      );

      console.log(
        '========================================'
      );

      return;
    }

    /*
     * 6. Mise à jour du JSON.
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
        finalCandidates.map(
          decision => ({
            date:
              decision.date,

            titre:
              decision.titre,

            matiere:
              decision.matiere || '',

            url:
              decision.url
          })
        )
    };

    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        existingData,
        null,
        2
      ) + '\n',
      'utf8'
    );

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      '✓ JSON MIS À JOUR'
    );

    console.log(
      '========================================'
    );

    console.log(
      `Liège : ${finalCandidates.length} décisions fiscales`
    );

    console.log(
      outputPath
    );

  } finally {
    await browser.close();
  }
}

main().catch(
  error => {
    console.error('');
    console.error(
      'ERREUR FATALE :'
    );

    console.error(
      error
    );

    process.exit(1);
  }
);
