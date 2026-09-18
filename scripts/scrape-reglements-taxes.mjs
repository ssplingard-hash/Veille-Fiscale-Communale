import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OUTPUT_FILE = path.join(
  __dirname,
  '../src/data/reglements-taxes.json'
);

const BASE_URL = 'https://www.deliberations.be';
const LIEGE_URL = `${BASE_URL}/liege/decisions`;

const TARGET_YEAR = 2026;

const PAGE_TIMEOUT_MS = 30000;
const RENDER_WAIT_MS = 1800;
const MAX_PAGES = 30;


/* ============================================================
   OUTILS
   ============================================================ */

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


/*
 * Transforme le slug de l'URL en titre lisible.
 *
 * Exemple :
 *
 * bail-commercial-type-creashop
 *
 * devient :
 *
 * Bail commercial type Creashop
 */
function titleFromUrl(url) {

  try {

    const pathname = new URL(url).pathname;

    const slug = pathname
      .split('/')
      .filter(Boolean)
      .pop();

    if (!slug) {
      return '';
    }

    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase());

  } catch {
    return '';
  }
}


/*
 * Si le texte du lien est simplement "Décision",
 * on utilise le titre construit depuis l'URL.
 */
function getRealTitle(linkTitle, url) {

  const link = normalizeText(linkTitle);

  const genericTitles = [
    '',
    'decision',
    'décision',
    'voir',
    'details',
    'détails'
  ];

  const normalizedLink =
    normalizeForSearch(link);

  if (
    !genericTitles.includes(normalizedLink)
  ) {
    return link;
  }

  return titleFromUrl(url) || 'Décision';
}


function parseDateFromSlug(url) {

  const match = url.match(
    /\/(\d{1,2})-([a-zéûàâîôùç]+)-(\d{4})/i
  );

  if (!match) {
    return null;
  }

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


/* ============================================================
   EXTRACTION LISTE
   ============================================================ */

async function extractPage(page) {

  return await page.evaluate(() => {

    const links = [];

    for (const a of document.querySelectorAll('a[href]')) {

      const href = a.href || '';

      if (
        !href.includes('/liege/decisions/')
        || href.includes('@@faceted_query')
      ) {
        continue;
      }

      const pathname = new URL(href).pathname;

      const parts = pathname
        .split('/')
        .filter(Boolean);

      if (parts.length < 4) {
        continue;
      }

      links.push({
        href,
        title: (
          a.innerText ||
          a.textContent ||
          ''
        ).replace(/\s+/g, ' ').trim()
      });
    }


    const paginationLinks = [];

    for (const a of document.querySelectorAll('a[href]')) {

      const href = a.href || '';

      if (!href.includes('@@faceted_query')) {
        continue;
      }

      paginationLinks.push({
        href,
        text: (
          a.innerText ||
          a.textContent ||
          ''
        ).replace(/\s+/g, ' ').trim()
      });
    }


    return {
      links,
      paginationLinks
    };
  });
}


/* ============================================================
   EXTRACTION D'UNE DÉCISION
   ============================================================ */

async function extractDecisionDetails(page, url) {

  try {

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: PAGE_TIMEOUT_MS
    });

    await sleep(500);

    const result = await page.evaluate(() => {

      let matiere = '';

      const elements = [
        ...document.querySelectorAll(
          'dt, dd, th, td, div, span, p, strong, b'
        )
      ];

      for (const element of elements) {

        const text = (
          element.innerText ||
          element.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();

        if (!/^mati[eè]re\s*:?\s*$/i.test(text)) {
          continue;
        }

        const next = element.nextElementSibling;

        if (next) {

          const nextText = (
            next.innerText ||
            next.textContent ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim();

          if (
            nextText &&
            !/^mati[eè]re/i.test(nextText)
          ) {
            matiere = nextText;
            break;
          }
        }

        const parent = element.parentElement;

        if (parent) {

          const parentText = (
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
            match[1] &&
            match[1].trim()
          ) {
            matiere = match[1].trim();
            break;
          }
        }
      }

      return {
        matiere
      };
    });

    return result;

  } catch (error) {

    console.log(
      `⚠️ Impossible de lire : ${url}`
    );

    return {
      matiere: ''
    };
  }
}


/* ============================================================
   CLASSIFICATION FISCALE
   ============================================================ */

/*
 * IMPORTANT :
 *
 * On ne classe PLUS une décision comme fiscale sur base
 * du texte intégral de la page.
 *
 * On utilise principalement le véritable intitulé extrait
 * de l'URL.
 *
 * Cela évite notamment :
 *
 * "Philippet" -> faux positif sur "ipp"
 *
 * et les décisions de bail contenant accessoirement
 * des références fiscales.
 */

function isFiscalDecision(title, matiere) {

  const t = normalizeForSearch(title);
  const m = normalizeForSearch(matiere);


  /* ==========================================================
     EXCLUSIONS EXPLICITES
     ========================================================== */

  const excludedTitlePatterns = [

    /\bbail commercial\b/,
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

    /\blimitation de la vitesse\b/,
    /\bzone 30\b/,
    /\bcirculation\b/
  ];

  if (
    excludedTitlePatterns.some(
      pattern => pattern.test(t)
    )
  ) {
    return false;
  }


  /* ==========================================================
     INDICES FISCAUX FORTS DANS LE TITRE
     ========================================================== */

  const fiscalTitlePatterns = [

    /\btaxe\b/,
    /\btaxes\b/,

    /\bredevance\b/,
    /\bredevances\b/,

    /\breglement fiscal\b/,
    /\breglement fiscal\b/,

    /\btaxation\b/,

    /\bprecompte immobilier\b/,
    /\bprecompte\b/,

    /\bcentimes additionnels\b/,

    /\badditionnels a l'ipp\b/,
    /\bipp\b/,

    /\bimpot\b/,
    /\bimpots\b/,

    /\bforce motrice\b/,

    /\btaxe communale\b/,
    /\btaxe additionnelle\b/,
    /\btaxe locale\b/,

    /\bredevance communale\b/
  ];


  if (
    fiscalTitlePatterns.some(
      pattern => pattern.test(t)
    )
  ) {
    return true;
  }


  /* ==========================================================
     MATIÈRE
     ========================================================== */

  const fiscalMatterPatterns = [

    /^taxe$/,
    /^taxes$/,

    /^redevance$/,
    /^redevances$/,

    /^fiscal$/,
    /^fiscale$/,
    /^fiscales$/,
    /^fiscalite$/,

    /^precompte$/,
    /^precompte immobilier$/,

    /^impot$/,
    /^impots$/,

    /^centimes additionnels$/,

    /^force motrice$/,

    /^ipp$/
  ];


  if (
    fiscalMatterPatterns.some(
      pattern => pattern.test(m)
    )
  ) {
    return true;
  }


  return false;
}


/* ============================================================
   MAIN
   ============================================================ */

async function main() {

  console.log('');
  console.log('========================================');
  console.log('SCRAPER FISCAL — LIÈGE');
  console.log(`ANNÉE : ${TARGET_YEAR}`);
  console.log('========================================');
  console.log('');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const page = await browser.newPage();

  const allDecisions = new Map();

  let currentUrl = LIEGE_URL;
  let pageNumber = 0;


  try {

    /* ========================================================
       ÉTAPE 1 — RÉCUPÉRATION DES DÉCISIONS
       ======================================================== */

    while (pageNumber < MAX_PAGES) {

      pageNumber++;

      console.log('');
      console.log('========================================');
      console.log(`PAGE ${pageNumber}`);
      console.log(`URL : ${currentUrl}`);
      console.log('========================================');


      await page.goto(currentUrl, {
        waitUntil: 'networkidle2',
        timeout: PAGE_TIMEOUT_MS
      });

      await sleep(RENDER_WAIT_MS);

      const result =
        await extractPage(page);


      console.log(
        `Liens de décisions détectés : ${result.links.length}`
      );

      console.log(
        `Liens de pagination détectés : ${result.paginationLinks.length}`
      );


      let decisions2026ThisPage = 0;
      let decisionsBefore2026ThisPage = 0;


      for (const link of result.links) {

        const date =
          parseDateFromSlug(link.href);

        if (!date) {
          continue;
        }

        const year =
          date.getUTCFullYear();


        if (year === TARGET_YEAR) {

          if (!allDecisions.has(link.href)) {

            const realTitle =
              getRealTitle(
                link.title,
                link.href
              );

            allDecisions.set(
              link.href,
              {
                date:
                  date.toISOString()
                    .slice(0, 10),

                titre: realTitle,

                url: link.href,

                matiere: '',

                fiscal: false
              }
            );

            decisions2026ThisPage++;
          }

        } else if (year < TARGET_YEAR) {

          decisionsBefore2026ThisPage++;
        }
      }


      console.log(
        `Nouvelles décisions 2026 : ${decisions2026ThisPage}`
      );

      console.log(
        `Total unique 2026 : ${allDecisions.size}`
      );


      if (
        decisionsBefore2026ThisPage > 0 &&
        decisions2026ThisPage === 0
      ) {

        console.log(
          'Fin de 2026 détectée.'
        );

        break;
      }


      const candidates = [];

      for (
        const pagination
        of result.paginationLinks
      ) {

        const match =
          pagination.href.match(
            /b_start:int=(\d+)/
          );

        if (!match) {
          continue;
        }

        candidates.push({
          offset: Number(match[1]),
          href: pagination.href
        });
      }


      const currentOffsetMatch =
        currentUrl.match(
          /b_start:int=(\d+)/
        );

      const currentOffset =
        currentOffsetMatch
          ? Number(currentOffsetMatch[1])
          : 0;


      const nextCandidates =
        candidates
          .filter(
            item =>
              item.offset > currentOffset
          )
          .sort(
            (a, b) =>
              a.offset - b.offset
          );


      if (nextCandidates.length === 0) {

        console.log(
          'Aucun lien de pagination suivant trouvé.'
        );

        break;
      }


      const next =
        nextCandidates[0];

      currentUrl =
        next.href;
    }


    /* ========================================================
       ÉTAPE 2 — VÉRIFICATION
       ======================================================== */

    console.log('');
    console.log('========================================');

    console.log(
      `TOTAL UNIQUE : ${allDecisions.size} décisions 2026`
    );

    console.log('========================================');


    if (allDecisions.size < 100) {

      console.log('');
      console.log('⚠️ PROTECTION ACTIVÉE');

      console.log(
        'Moins de 100 décisions récupérées.'
      );

      console.log(
        'Le JSON existant reste inchangé.'
      );

      return;
    }


    /* ========================================================
       ÉTAPE 3 — LECTURE DES MATIÈRES
       ======================================================== */

    console.log('');
    console.log('========================================');
    console.log('LECTURE DES DÉCISIONS');
    console.log('========================================');


    let counter = 0;


    for (
      const decision
      of allDecisions.values()
    ) {

      counter++;

      console.log('');
      console.log(
        `[${counter}/${allDecisions.size}]`
      );

      console.log(
        `TITRE : ${decision.titre}`
      );

      console.log(
        `URL : ${decision.url}`
      );


      const details =
        await extractDecisionDetails(
          page,
          decision.url
        );


      decision.matiere =
        normalizeText(
          details.matiere
        );


      decision.fiscal =
        isFiscalDecision(
          decision.titre,
          decision.matiere
        );


      console.log(
        `Matière : ${
          decision.matiere ||
          '(non trouvée)'
        }`
      );

      console.log(
        `Fiscal : ${
          decision.fiscal
            ? 'OUI'
            : 'NON'
        }`
      );


      await sleep(150);
    }


    /* ========================================================
       ÉTAPE 4 — FILTRAGE FISCAL
       ======================================================== */

    const fiscalDecisions = [
      ...allDecisions.values()
    ]
      .filter(
        decision =>
          decision.fiscal
      )
      .sort(
        (a, b) =>
          b.date.localeCompare(a.date)
      );


    console.log('');
    console.log('========================================');

    console.log(
      `DÉCISIONS FISCALES : ${fiscalDecisions.length}`
    );

    console.log('========================================');


    for (
      const decision
      of fiscalDecisions
    ) {

      console.log('');

      console.log(
        `DATE : ${decision.date}`
      );

      console.log(
        `TITRE : ${decision.titre}`
      );

      console.log(
        `MATIÈRE : ${
          decision.matiere ||
          '(non trouvée)'
        }`
      );

      console.log(
        `URL : ${decision.url}`
      );
    }


    /* ========================================================
       ÉTAPE 5 — ÉCRITURE JSON
       ======================================================== */

    let existingData = {};


    try {

      existingData =
        JSON.parse(
          await fs.readFile(
            OUTPUT_FILE,
            'utf-8'
          )
        );

    } catch {

      existingData = {};
    }


    existingData['Liège'] = {

      updatedAt:
        new Date().toISOString(),

      reglementsEnVigueur:
        fiscalDecisions.map(
          decision => ({
            date:
              decision.date,

            titre:
              decision.titre,

            matiere:
              decision.matiere,

            url:
              decision.url
          })
        ),

      prochainesTaxes: []
    };


    await fs.mkdir(
      path.dirname(OUTPUT_FILE),
      {
        recursive: true
      }
    );


    await fs.writeFile(
      OUTPUT_FILE,

      JSON.stringify(
        existingData,
        null,
        2
      ),

      'utf-8'
    );


    console.log('');
    console.log('========================================');
    console.log('JSON MIS À JOUR');

    console.log(
      `Décisions fiscales : ${fiscalDecisions.length}`
    );

    console.log('========================================');


  } finally {

    await browser.close();
  }
}


main().catch(error => {

  console.error('');
  console.error('ERREUR FATALE :');
  console.error(error);

  process.exit(1);
});
