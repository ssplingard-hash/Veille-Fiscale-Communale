import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

const BASE_URL = 'https://www.deliberations.be';
const LIEGE_URL = `${BASE_URL}/liege/decisions`;

const TARGET_YEAR = 2026;

const PAGE_TIMEOUT_MS = 30000;
const RENDER_WAIT_MS = 1200;
const DETAIL_WAIT_MS = 500;

const MIN_EXPECTED_DECISIONS = 500;

// ------------------------------------------------------------
// OUTILS
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// DATE DEPUIS L'URL
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// TITRE DE SECOURS DEPUIS LE SLUG
// ------------------------------------------------------------

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
      .replace(/\b\w/g, c => c.toUpperCase());

  } catch {
    return '';
  }
}

function getRealTitle(title, url) {
  const cleanTitle = normalizeText(title);

  const normalized = normalizeForSearch(
    cleanTitle
  );

  const genericTitles = [
    '',
    'decision',
    'décision',
    'voir',
    'details',
    'détails',
    'projet de decision',
    'projet de décision'
  ];

  if (
    !genericTitles.includes(normalized)
  ) {
    return cleanTitle;
  }

  return (
    titleFromUrl(url) ||
    'Décision'
  );
}

// ------------------------------------------------------------
// EXTRACTION DES DÉCISIONS D'UNE PAGE
// ------------------------------------------------------------

async function extractDecisionLinks(page) {
  return await page.evaluate(() => {

    const results = [];

    for (
      const a of document.querySelectorAll(
        'a[href]'
      )
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

      const title =
        (
          a.innerText ||
          a.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();

      results.push({
        url: href,
        title
      });
    }

    return results;
  });
}

// ------------------------------------------------------------
// EXTRACTION DE LA MATIÈRE D'UNE DÉCISION
// ------------------------------------------------------------

async function extractMatiere(page) {

  return await page.evaluate(() => {

    const elements = [
      ...document.querySelectorAll(
        'dt, dd, th, td, div, span, p, strong, b'
      )
    ];

    for (
      const element of elements
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

// ------------------------------------------------------------
// CLASSIFICATION FISCALE
//
// IMPORTANT :
// On classe une décision comme fiscale principalement sur
// son TITRE.
//
// Le contenu de la page n'est utilisé qu'en complément.
// ------------------------------------------------------------

function classifyFiscalDecision(
  title,
  matiere = ''
) {

  const t =
    normalizeForSearch(title);

  const m =
    normalizeForSearch(matiere);

  const raisons = [];
  const exclusions = [];

  // ----------------------------------------------------------
  // EXCLUSIONS FORTES
  // ----------------------------------------------------------

  const estBail =
    /\bbail\b/.test(t) ||
    /\bconvention de bail\b/.test(t);

  const estMarchePublic =
    /\bmarches publics\b/.test(t) ||
    /\bmarches public\b/.test(t);

  const estStationnementSimple =
    (
      /\bstationnement\b/.test(t) ||
      /\bzone payante\b/.test(t)
    ) &&
    !/\btaxe\b/.test(t) &&
    !/\bredevance\b/.test(t) &&
    !/\bimpot\b/.test(t) &&
    !/\bprecompte\b/.test(t) &&
    !/\bcentimes additionnels\b/.test(t);

  if (estBail) {
    exclusions.push('BAIL');
  }

  if (estMarchePublic) {
    exclusions.push('MARCHES_PUBLICS');
  }

  if (estStationnementSimple) {
    exclusions.push(
      'STATIONNEMENT_SANS_FISCALITE_EXPLICITE'
    );
  }

  // ----------------------------------------------------------
  // INDICES FISCAUX TRÈS FORTS
  // ----------------------------------------------------------

  if (
    /\breglement[- ]taxe\b/.test(t)
  ) {
    raisons.push(
      'REGLEMENT_TAXE'
    );
  }

  if (
    /\breglement[- ]redevance\b/.test(t)
  ) {
    raisons.push(
      'REGLEMENT_REDEVANCE'
    );
  }

  if (
    /\btaxe communale\b/.test(t)
  ) {
    raisons.push(
      'TAXE_COMMUNALE'
    );
  }

  if (
    /\bredevance communale\b/.test(t)
  ) {
    raisons.push(
      'REDEVANCE_COMMUNALE'
    );
  }

  if (
    /\bcentimes additionnels\b/.test(t)
  ) {
    raisons.push(
      'CENTIMES_ADDITIONNELS'
    );
  }

  if (
    /\bprecompte immobilier\b/.test(t)
  ) {
    raisons.push(
      'PRECOMPTE_IMMOBILIER'
    );
  }

  if (
    /\bforce motrice\b/.test(t)
  ) {
    raisons.push(
      'FORCE_MOTRICE'
    );
  }

  // ----------------------------------------------------------
  // IMPÔTS / IPP
  // ----------------------------------------------------------

  if (
    /\bimpot des personnes physiques\b/.test(t)
  ) {
    raisons.push(
      'IPP'
    );
  }

  if (
    /\bimpots communaux\b/.test(t)
  ) {
    raisons.push(
      'IMPOTS_COMMUNAUX'
    );
  }

  if (
    /\bipp\b/.test(t) &&
    (
      /\badditionnel\b/.test(t) ||
      /\badditionnels\b/.test(t) ||
      /\bcentimes\b/.test(t)
    )
  ) {
    raisons.push(
      'IPP_ADDITIONNELS'
    );
  }

  // ----------------------------------------------------------
  // TAXES GÉNÉRIQUES
  //
  // Une décision contenant explicitement "taxe" dans le titre
  // est généralement candidate.
  //
  // On élimine toutefois certains faux positifs évidents.
  // ----------------------------------------------------------

  if (
    /\btaxe\b|\btaxes\b/.test(t)
  ) {

    if (
      /\btaxe sur la valeur ajoutee\b/.test(t) &&
      !/\breglement[- ]taxe\b/.test(t)
    ) {

      exclusions.push(
        'TVA'
      );

    } else {

      raisons.push(
        'TAXE_DANS_TITRE'
      );
    }
  }

  // ----------------------------------------------------------
  // REDEVANCE GÉNÉRIQUE
  // ----------------------------------------------------------

  if (
    /\bredevance\b|\bredevances\b/.test(t)
  ) {

    raisons.push(
      'REDEVANCE_DANS_TITRE'
    );
  }

  // ----------------------------------------------------------
  // "ADDITIONNELS" SEUL
  //
  // On ne retient PAS le simple mot additionnels.
  // Il faut un contexte clairement fiscal.
  // ----------------------------------------------------------

  if (
    /\badditionnels\b/.test(t) &&
    (
      /\bprecompte\b/.test(t) ||
      /\bipp\b/.test(t) ||
      /\bcentimes\b/.test(t) ||
      /\bimpot\b/.test(t)
    )
  ) {

    raisons.push(
      'ADDITIONNELS_FISCAUX'
    );
  }

  // ----------------------------------------------------------
  // MATIÈRE
  //
  // Complément uniquement.
  // ----------------------------------------------------------

  if (
    raisons.length === 0 &&
    (
      /\bfiscal/.test(m) ||
      /\btaxe/.test(m) ||
      /\bredevance/.test(m)
    )
  ) {

    raisons.push(
      'MATIERE_FISCALE'
    );
  }

  // ----------------------------------------------------------
  // DÉCISION FINALE
  // ----------------------------------------------------------

  const fiscale =
    raisons.length > 0 &&
    exclusions.length === 0;

  return {
    fiscale,
    raisons: [
      ...new Set(raisons)
    ],
    exclusions: [
      ...new Set(exclusions)
    ]
  };
}

// ------------------------------------------------------------
// PAGINATION
//
// On reprend volontairement la méthode qui a déjà permis
// de récupérer les 761 décisions 2026.
// ------------------------------------------------------------

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

    try {

      await page.goto(
        url,
        {
          waitUntil: 'networkidle2',
          timeout: PAGE_TIMEOUT_MS
        }
      );

      await sleep(
        RENDER_WAIT_MS
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
        const link of yearLinks
      ) {

        if (
          !allDecisions.has(
            link.url
          )
        ) {

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
                  link.title,
                  link.url
                ),

              matiere: '',

              url:
                link.url
            }
          );

          newCount++;
        }
      }

      console.log(
        `  ${yearLinks.length} décision(s) ${TARGET_YEAR} trouvée(s)`
      );

      console.log(
        `  ${newCount} nouvelle(s) décision(s)`
      );

      // ------------------------------------------------------
      // FIN DE PAGINATION
      // ------------------------------------------------------

      if (
        yearLinks.length === 0
      ) {

        console.log(
          '  Dernière page atteinte.'
        );

        break;
      }

      if (
        yearLinks.length < 20
      ) {

        console.log(
          '  Dernière page atteinte.'
        );

        break;
      }

      offset += 20;

    } catch (error) {

      console.log(
        `⚠️ Erreur sur offset ${offset} : ${error.message}`
      );

      break;
    }
  }

  return [
    ...allDecisions.values()
  ];
}

// ------------------------------------------------------------
// PROGRAMME PRINCIPAL
// ------------------------------------------------------------

async function main() {

  console.log('');
  console.log(
    '========================================'
  );
  console.log(
    'SCRAPER FISCAL — LIÈGE'
  );
  console.log(
    `ANNÉE : ${TARGET_YEAR}`
  );
  console.log(
    '========================================'
  );
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

  const page =
    await browser.newPage();

  try {

    // --------------------------------------------------------
    // 1. RÉCUPÉRATION DES DÉCISIONS
    // --------------------------------------------------------

    const decisions =
      await scrapeAllDecisions(
        page
      );

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

    // --------------------------------------------------------
    // SÉCURITÉ
    // --------------------------------------------------------

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
        `Minimum attendu : ${MIN_EXPECTED_DECISIONS}.`
      );

      console.log(
        "AUCUNE DONNÉE N'EST MODIFIÉE."
      );

      return;
    }

    // --------------------------------------------------------
    // 2. CLASSIFICATION SUR BASE DU TITRE
    // --------------------------------------------------------

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'CLASSIFICATION FISCALE'
    );

    console.log(
      '========================================'
    );

    const candidates =
      [];

    for (
      const decision
      of decisions
    ) {

      const analyse =
        classifyFiscalDecision(
          decision.titre,
          decision.matiere
        );

      decision.analyse =
        analyse;

      if (
        analyse.fiscale
      ) {

        candidates.push(
          decision
        );
      }
    }

    // --------------------------------------------------------
    // 3. EXTRACTION DE LA MATIÈRE UNIQUEMENT POUR LES
    //    CANDIDATS
    // --------------------------------------------------------

    console.log('');
    console.log(
      `Décisions fiscales candidates : ${candidates.length}`
    );

    console.log('');
    console.log(
      'Lecture des détails des candidats...'
    );

    let counter = 0;

    for (
      const decision
      of candidates
    ) {

      counter++;

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

      } catch {
        decision.matiere = '';
      }

      console.log(
        `  ${counter}/${candidates.length} — ${decision.titre}`
      );
    }

    // --------------------------------------------------------
    // 4. RECLASSIFICATION AVEC LA MATIÈRE
    // --------------------------------------------------------

    const finalCandidates =
      candidates.filter(
        decision => {

          const analyse =
            classifyFiscalDecision(
              decision.titre,
              decision.matiere
            );

          decision.analyse =
            analyse;

          return analyse.fiscale;
        }
      );

    // --------------------------------------------------------
    // 5. AFFICHAGE
    // --------------------------------------------------------

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

    for (
      const decision
      of finalCandidates
    ) {

      console.log('');
      console.log(
        `${decision.date} | ${decision.titre}`
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

    // --------------------------------------------------------
    // 6. CONSTRUCTION DU JSON
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // IMPORTANT :
    // On ne remplace que Liège.
    // Les autres communes restent intactes.
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // 7. FIN
    // --------------------------------------------------------

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'SCRAPING TERMINÉ'
    );

    console.log(
      '========================================'
    );

    console.log('');
    console.log(
      `Décisions analysées : ${decisions.length}`
    );

    console.log(
      `Décisions fiscales retenues : ${finalCandidates.length}`
    );

    console.log('');
    console.log(
      `✓ Fichier mis à jour : ${outputPath}`
    );

    console.log('');

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
