import puppeteer from 'puppeteer';

const BASE_URL = 'https://www.deliberations.be';
const LIEGE_URL = `${BASE_URL}/liege/decisions`;

const TARGET_YEAR = 2026;

const PAGE_TIMEOUT_MS = 30000;
const RENDER_WAIT_MS = 1800;
const MAX_PAGES = 30;

/*
 * =========================================================
 * OUTILS
 * =========================================================
 */

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
 * =========================================================
 * TITRE DEPUIS L'URL
 * =========================================================
 */

function titleFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;

    const slug =
      pathname
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

/*
 * =========================================================
 * VRAI TITRE
 * =========================================================
 */

function getRealTitle(linkTitle, url) {
  const title = normalizeText(linkTitle);

  const normalized =
    normalizeForSearch(title);

  const genericTitles = [
    '',
    'decision',
    'décision',
    'voir',
    'details',
    'détails'
  ];

  if (!genericTitles.includes(normalized)) {
    return title;
  }

  return (
    titleFromUrl(url) ||
    'Décision'
  );
}

/*
 * =========================================================
 * DATE DEPUIS L'URL
 * =========================================================
 */

function parseDateFromSlug(url) {
  const match =
    url.match(
      /\/(\d{1,2})-([a-zéûàâîôùç]+)-(\d{4})/i
    );

  if (!match) {
    return null;
  }

  const day =
    Number(match[1]);

  const monthName =
    match[2].toLowerCase();

  const year =
    Number(match[3]);

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

  if (
    months[monthName] === undefined
  ) {
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

/*
 * =========================================================
 * EXTRACTION PAGE LISTE
 * =========================================================
 */

async function extractPage(page) {

  return await page.evaluate(() => {

    const links = [];

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

      if (parts.length < 4) {
        continue;
      }

      links.push({
        href,

        title: (
          a.innerText ||
          a.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
      });
    }

    const paginationLinks = [];

    for (
      const a of document.querySelectorAll(
        'a[href]'
      )
    ) {

      const href =
        a.href || '';

      if (
        !href.includes(
          '@@faceted_query'
        )
      ) {
        continue;
      }

      paginationLinks.push({
        href,

        text: (
          a.innerText ||
          a.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
      });
    }

    return {
      links,
      paginationLinks
    };
  });
}

/*
 * =========================================================
 * EXTRACTION D'UNE DÉCISION
 * =========================================================
 */

async function extractDecisionDetails(
  page,
  url
) {

  try {

    await page.goto(
      url,
      {
        waitUntil: 'networkidle2',
        timeout: PAGE_TIMEOUT_MS
      }
    );

    await sleep(700);

    return await page.evaluate(() => {

      const bodyText =
        (
          document.body?.innerText ||
          document.body?.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();

      let matiere = '';

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

            matiere =
              nextText;

            break;
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
            match[1] &&
            match[1].trim()
          ) {

            matiere =
              match[1].trim();

            break;
          }
        }
      }

      return {
        bodyText,
        matiere
      };
    });

  } catch (error) {

    console.log(
      `⚠️ Impossible de lire : ${url}`
    );

    return {
      bodyText: '',
      matiere: ''
    };
  }
}

/*
 * =========================================================
 * DÉTECTION DU CONTEXTE FISCAL
 * =========================================================
 *
 * On ne cherche PAS simplement "taxe".
 *
 * On recherche des combinaisons beaucoup plus précises.
 * =========================================================
 */

function analyseFiscalite(
  titre,
  matiere,
  bodyText
) {

  const t =
    normalizeForSearch(titre);

  const m =
    normalizeForSearch(matiere);

  const b =
    normalizeForSearch(bodyText);

  const raisons = [];

  /*
   * -------------------------------------------------------
   * 1. TITRE — TRÈS IMPORTANT
   * -------------------------------------------------------
   */

  if (
    /\breglement\b/.test(t) &&
    (
      /\btaxe\b/.test(t) ||
      /\bredevance\b/.test(t)
    )
  ) {

    raisons.push(
      'TITRE_REGLEMENT_TAXE_REDEVANCE'
    );
  }

  if (
    /\breglement[- ]taxe\b/.test(t)
  ) {

    raisons.push(
      'TITRE_REGLEMENT_TAXE'
    );
  }

  if (
    /\breglement[- ]redevance\b/.test(t)
  ) {

    raisons.push(
      'TITRE_REGLEMENT_REDEVANCE'
    );
  }

  if (
    /\btaxe communale\b/.test(t)
  ) {

    raisons.push(
      'TITRE_TAXE_COMMUNALE'
    );
  }

  if (
    /\btaxe sur\b/.test(t)
  ) {

    raisons.push(
      'TITRE_TAXE_SUR'
    );
  }

  if (
    /\btaxe de\b/.test(t)
  ) {

    raisons.push(
      'TITRE_TAXE_DE'
    );
  }

  if (
    /\bredevance communale\b/.test(t)
  ) {

    raisons.push(
      'TITRE_REDEVANCE_COMMUNALE'
    );
  }

  if (
    /\bprecompte immobilier\b/.test(t)
  ) {

    raisons.push(
      'TITRE_PRECOMPTE_IMMOBILIER'
    );
  }

  if (
    /\bforce motrice\b/.test(t)
  ) {

    raisons.push(
      'TITRE_FORCE_MOTRICE'
    );
  }

  if (
    /\bcentimes additionnels\b/.test(t)
  ) {

    raisons.push(
      'TITRE_CENTIMES_ADDITIONNELS'
    );
  }

  if (
    /\badditionnels\b/.test(t) &&
    (
      /\bipp\b/.test(t) ||
      /\bprecompte\b/.test(t) ||
      /\bimmobilier\b/.test(t)
    )
  ) {

    raisons.push(
      'TITRE_ADDITIONNELS_FISCAL'
    );
  }

  /*
   * -------------------------------------------------------
   * 2. MATIÈRE
   * -------------------------------------------------------
   */

  if (
    /\bfiscal/.test(m) &&
    (
      /\btaxe\b/.test(t) ||
      /\bredevance\b/.test(t) ||
      /\bimpot\b/.test(t) ||
      /\bprecompte\b/.test(t)
    )
  ) {

    raisons.push(
      'MATIERE_FISCALITE'
    );
  }

  /*
   * -------------------------------------------------------
   * 3. CONTENU :
   * combinaisons fortes uniquement
   * -------------------------------------------------------
   */

  const hasReglement =
    /\breglement\b/.test(b);

  const hasTaxe =
    /\btaxe\b|\btaxes\b/.test(b);

  const hasRedevance =
    /\bredevance\b|\bredevances\b/.test(b);

  const hasAdditionnels =
    /\bcentimes additionnels\b/.test(b);

  const hasPrecompteImmobilier =
    /\bprecompte immobilier\b/.test(b);

  const hasForceMotrice =
    /\bforce motrice\b/.test(b);

  const hasImpots =
    /\bimpot communal\b/.test(b) ||
    /\bimpots communaux\b/.test(b);

  /*
   * Règlement + taxe
   */

  if (
    hasReglement &&
    hasTaxe &&
    (
      /\badoption\b/.test(b) ||
      /\bmodification\b/.test(b) ||
      /\bfixation\b/.test(b) ||
      /\btaux\b/.test(b) ||
      /\bmontant\b/.test(b)
    )
  ) {

    raisons.push(
      'CONTENU_REGLEMENT_TAXE'
    );
  }

  /*
   * Règlement + redevance
   */

  if (
    hasReglement &&
    hasRedevance &&
    (
      /\badoption\b/.test(b) ||
      /\bmodification\b/.test(b) ||
      /\bfixation\b/.test(b) ||
      /\btaux\b/.test(b) ||
      /\bmontant\b/.test(b)
    )
  ) {

    raisons.push(
      'CONTENU_REGLEMENT_REDEVANCE'
    );
  }

  /*
   * Centimes additionnels
   */

  if (
    hasAdditionnels &&
    (
      /\bprecompte immobilier\b/.test(b) ||
      /\bimpot des personnes physiques\b/.test(b) ||
      /\bipp\b/.test(b)
    )
  ) {

    raisons.push(
      'CONTENU_CENTIMES_ADDITIONNELS'
    );
  }

  /*
   * Précompte immobilier
   *
   * Mais uniquement si le texte parle réellement
   * de fixation/adoption/modification.
   */

  if (
    hasPrecompteImmobilier &&
    (
      /\btaux\b/.test(b) ||
      /\bcentimes\b/.test(b) ||
      /\breglement\b/.test(b) ||
      /\badoption\b/.test(b) ||
      /\bmodification\b/.test(b)
    )
  ) {

    raisons.push(
      'CONTENU_PRECOMPTE_IMMOBILIER'
    );
  }

  /*
   * Force motrice
   */

  if (
    hasForceMotrice &&
    (
      /\btaux\b/.test(b) ||
      /\breglement\b/.test(b) ||
      /\btaxe\b/.test(b) ||
      /\bmontant\b/.test(b)
    )
  ) {

    raisons.push(
      'CONTENU_FORCE_MOTRICE'
    );
  }

  /*
   * Impôts communaux
   */

  if (
    hasImpots &&
    (
      /\btaux\b/.test(b) ||
      /\breglement\b/.test(b) ||
      /\bcentimes\b/.test(b)
    )
  ) {

    raisons.push(
      'CONTENU_IMPOTS_COMMUNAUX'
    );
  }

  /*
   * -------------------------------------------------------
   * 4. EXCLUSIONS EXPLICITES
   * -------------------------------------------------------
   */

  const exclusions = [];

  /*
   * Marchés publics
   */

  if (
    /\bmarches publics\b/.test(t) ||
    /\bmarches publics\b/.test(b)
  ) {

    if (
      !raisons.some(
        r =>
          r.includes('REGLEMENT_TAXE') ||
          r.includes('REGLEMENT_REDEVANCE')
      )
    ) {

      exclusions.push(
        'MARCHES_PUBLICS'
      );
    }
  }

  /*
   * Bail
   */

  if (
    /\bbail\b/.test(t) ||
    /\bbail commercial\b/.test(t)
  ) {

    exclusions.push(
      'BAIL'
    );
  }

  /*
   * Stationnement / voirie
   */

  if (
    /\bzone payante\b/.test(t) ||
    /\bstationnement\b/.test(t) ||
    /\bemplacement handicape\b/.test(t) ||
    /\bzone 30\b/.test(t) ||
    /\bvoirie\b/.test(t)
  ) {

    exclusions.push(
      'VOIRIE_STATIONNEMENT'
    );
  }

  /*
   * TVA seule
   */

  if (
    /\btaxe sur la valeur ajoutee\b/.test(b) &&
    !hasTaxe &&
    !hasRedevance
  ) {

    exclusions.push(
      'TVA'
    );
  }

  /*
   * "Additionnels" tout seul :
   * ce n'est PAS suffisant.
   */

  if (
    raisons.length === 0 &&
    /\badditionnels\b/.test(b)
  ) {

    exclusions.push(
      'ADDITIONNELS_INSUFFISANTS'
    );
  }

  /*
   * -------------------------------------------------------
   * 5. SCORE
   * -------------------------------------------------------
   */

  let score = 0;

  for (
    const raison of raisons
  ) {

    if (
      raison.startsWith('TITRE_')
    ) {

      score += 5;

    } else if (
      raison.startsWith('MATIERE_')
    ) {

      score += 4;

    } else {

      score += 2;
    }
  }

  /*
   * Les exclusions ne suppriment pas automatiquement
   * une vraie décision fiscale identifiée par le titre.
   */

  const titreFiscal =
    raisons.some(
      r => r.startsWith('TITRE_')
    );

  if (
    exclusions.length > 0 &&
    !titreFiscal
  ) {

    score = 0;
  }

  /*
   * Une décision n'est candidate que si elle possède
   * un indice suffisamment fort.
   */

  const candidate =
    score >= 4;

  return {
    candidate,
    score,
    raisons,
    exclusions
  };
}

/*
 * =========================================================
 * EXTRACTION DU CONTEXTE
 * =========================================================
 */

function extractContexts(
  text
) {

  const normalized =
    normalizeText(text);

  const lower =
    normalizeForSearch(normalized);

  const keywords = [
    'reglement taxe',
    'reglement-taxe',
    'redevance',
    'precompte immobilier',
    'centimes additionnels',
    'force motrice',
    'taxe communale',
    'impot communal'
  ];

  const contexts = [];

  for (
    const keyword of keywords
  ) {

    let start = 0;

    while (true) {

      const index =
        lower.indexOf(
          keyword,
          start
        );

      if (
        index === -1
      ) {
        break;
      }

      const contextStart =
        Math.max(
          0,
          index - 250
        );

      const contextEnd =
        Math.min(
          normalized.length,
          index +
            keyword.length +
            450
        );

      contexts.push(
        normalized.slice(
          contextStart,
          contextEnd
        )
      );

      start =
        index +
        keyword.length;

      if (
        contexts.length >= 6
      ) {
        return contexts;
      }
    }
  }

  return contexts;
}

/*
 * =========================================================
 * PROGRAMME PRINCIPAL
 * =========================================================
 */

async function main() {

  console.log('');
  console.log(
    '========================================'
  );
  console.log(
    'DIAGNOSTIC FISCAL V3 — LIÈGE'
  );
  console.log(
    `ANNÉE : ${TARGET_YEAR}`
  );
  console.log(
    'MODE : DIAGNOSTIC — AUCUNE ÉCRITURE JSON'
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
        '--disable-dev-shm-usage'
      ]
    });

  const page =
    await browser.newPage();

  const allDecisions =
    new Map();

  let currentUrl =
    LIEGE_URL;

  let pageNumber = 0;

  try {

    /*
     * =====================================================
     * 1. RÉCUPÉRATION DES DÉCISIONS
     * =====================================================
     */

    while (
      pageNumber < MAX_PAGES
    ) {

      pageNumber++;

      console.log('');
      console.log(
        '========================================'
      );

      console.log(
        `PAGE ${pageNumber}`
      );

      console.log(
        `URL : ${currentUrl}`
      );

      console.log(
        '========================================'
      );

      await page.goto(
        currentUrl,
        {
          waitUntil: 'networkidle2',
          timeout: PAGE_TIMEOUT_MS
        }
      );

      await sleep(
        RENDER_WAIT_MS
      );

      const result =
        await extractPage(
          page
        );

      console.log(
        `Liens de décisions détectés : ${result.links.length}`
      );

      console.log(
        `Liens de pagination détectés : ${result.paginationLinks.length}`
      );

      let newDecisions = 0;

      for (
        const link of result.links
      ) {

        const date =
          parseDateFromSlug(
            link.href
          );

        if (!date) {
          continue;
        }

        const year =
          date.getUTCFullYear();

        if (
          year !== TARGET_YEAR
        ) {
          continue;
        }

        if (
          !allDecisions.has(
            link.href
          )
        ) {

          allDecisions.set(
            link.href,
            {
              date:
                date
                  .toISOString()
                  .slice(0, 10),

              titre:
                getRealTitle(
                  link.title,
                  link.href
                ),

              url:
                link.href,

              matiere: '',
              bodyText: '',
              analyse: null,
              contexts: []
            }
          );

          newDecisions++;
        }
      }

      console.log(
        `Nouvelles décisions 2026 : ${newDecisions}`
      );

      console.log(
        `Total unique 2026 : ${allDecisions.size}`
      );

      /*
       * Pagination
       */

      const paginationCandidates =
        [];

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

        paginationCandidates.push({
          offset:
            Number(match[1]),

          href:
            pagination.href
        });
      }

      const currentOffsetMatch =
        currentUrl.match(
          /b_start:int=(\d+)/
        );

      const currentOffset =
        currentOffsetMatch
          ? Number(
              currentOffsetMatch[1]
            )
          : 0;

      const nextCandidates =
        paginationCandidates
          .filter(
            item =>
              item.offset >
              currentOffset
          )
          .sort(
            (a, b) =>
              a.offset -
              b.offset
          );

      if (
        nextCandidates.length === 0
      ) {

        console.log(
          'Aucun lien de pagination suivant trouvé.'
        );

        break;
      }

      currentUrl =
        nextCandidates[0].href;
    }

    /*
     * =====================================================
     * 2. CONTRÔLE
     * =====================================================
     */

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      `TOTAL UNIQUE : ${allDecisions.size} décisions 2026`
    );

    console.log(
      '========================================'
    );

    if (
      allDecisions.size < 100
    ) {

      console.log('');
      console.log(
        '⚠️ PROTECTION : moins de 100 décisions.'
      );

      console.log(
        "AUCUNE DONNÉE N'EST MODIFIÉE."
      );

      return;
    }

    /*
     * =====================================================
     * 3. ANALYSE
     * =====================================================
     */

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'ANALYSE FISCALE V3'
    );

    console.log(
      '========================================'
    );

    let counter = 0;

    for (
      const decision
      of allDecisions.values()
    ) {

      counter++;

      const details =
        await extractDecisionDetails(
          page,
          decision.url
        );

      decision.matiere =
        normalizeText(
          details.matiere
        );

      decision.bodyText =
        normalizeText(
          details.bodyText
        );

      decision.analyse =
        analyseFiscalite(
          decision.titre,
          decision.matiere,
          decision.bodyText
        );

      if (
        decision.analyse.candidate
      ) {

        decision.contexts =
          extractContexts(
            decision.bodyText
          );

        console.log('');
        console.log(
          '----------------------------------------'
        );

        console.log(
          `CANDIDAT [${counter}/${allDecisions.size}]`
        );

        console.log(
          `DATE     : ${decision.date}`
        );

        console.log(
          `TITRE    : ${decision.titre}`
        );

        console.log(
          `MATIÈRE  : ${
            decision.matiere ||
            '(inconnue)'
          }`
        );

        console.log(
          `SCORE    : ${decision.analyse.score}`
        );

        console.log(
          `RAISONS  : ${
            decision.analyse.raisons.join(
              ', '
            )
          }`
        );

        if (
          decision.analyse.exclusions.length > 0
        ) {

          console.log(
            `EXCLUSIONS : ${
              decision.analyse.exclusions.join(
                ', '
              )
            }`
          );
        }

        if (
          decision.contexts.length > 0
        ) {

          console.log('');
          console.log(
            'CONTEXTE :'
          );

          for (
            const context
            of decision.contexts
          ) {

            console.log(
              `  → ${context}`
            );
          }
        }

        console.log('');

        console.log(
          `URL      : ${decision.url}`
        );
      }

      if (
        counter % 25 === 0
      ) {

        console.log('');
        console.log(
          `Progression : ${counter}/${allDecisions.size}`
        );
      }

      await sleep(100);
    }

    /*
     * =====================================================
     * 4. RÉSUMÉ
     * =====================================================
     */

    const candidates =
      [
        ...allDecisions.values()
      ]
        .filter(
          decision =>
            decision.analyse &&
            decision.analyse.candidate
        )
        .sort(
          (a, b) =>
            b.date.localeCompare(
              a.date
            )
        );

    console.log('');
    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'RÉSUMÉ DU DIAGNOSTIC V3'
    );

    console.log(
      '========================================'
    );

    console.log(
      `Décisions analysées : ${allDecisions.size}`
    );

    console.log(
      `Candidats fiscaux : ${candidates.length}`
    );

    /*
     * =====================================================
     * 5. LISTE FINALE
     * =====================================================
     */

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'LISTE DES CANDIDATS FISCAUX'
    );

    console.log(
      '========================================'
    );

    for (
      const decision
      of candidates
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
        `SCORE : ${decision.analyse.score}`
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
     * =====================================================
     * FIN
     * =====================================================
     */

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'FIN DU DIAGNOSTIC V3'
    );

    console.log(
      '========================================'
    );

    console.log('');

    console.log(
      "IMPORTANT : aucun fichier JSON n'a été modifié."
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
