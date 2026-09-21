import puppeteer from 'puppeteer';

const BASE_URL = 'https://www.deliberations.be';
const LIEGE_URL = `${BASE_URL}/liege/decisions`;

const TARGET_YEAR = 2026;

const PAGE_TIMEOUT_MS = 30000;
const RENDER_WAIT_MS = 1800;
const MAX_PAGES = 30;

// ------------------------------------------------------------
// OUTILS GÉNÉRAUX
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
// EXTRACTION DU TITRE
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

function getRealTitle(linkTitle, url) {
  const title = normalizeText(linkTitle);
  const normalized = normalizeForSearch(title);

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

  return titleFromUrl(url) || 'Décision';
}

// ------------------------------------------------------------
// DATE
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
// EXTRACTION DES LISTES / PAGINATION
// ------------------------------------------------------------

async function extractPage(page) {
  return await page.evaluate(() => {
    const links = [];

    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href || '';

      if (!href.includes('/liege/decisions/')) {
        continue;
      }

      if (href.includes('@@faceted_query')) {
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
        )
          .replace(/\s+/g, ' ')
          .trim()
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

// ------------------------------------------------------------
// EXTRACTION DÉTAILLÉE D'UNE DÉCISION
// ------------------------------------------------------------

async function extractDecisionDetails(page, url) {
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
      const bodyText = (
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

          const match = parentText.match(
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

// ------------------------------------------------------------
// V4 — DÉTECTION LARGE DES INDICES FISCAUX
//
// IMPORTANT :
// Cette fonction ne dit PAS encore "c'est une décision fiscale".
//
// Elle identifie les décisions qui méritent d'être examinées.
// Le but de V4 est de comprendre les formulations réellement
// utilisées par Liège avant de construire le filtre définitif.
// ------------------------------------------------------------

function analyseIndicesFiscaux(
  titre,
  matiere,
  bodyText
) {
  const t = normalizeForSearch(titre);
  const m = normalizeForSearch(matiere);
  const b = normalizeForSearch(bodyText);

  const indices = [];
  const exclusions = [];

  // ----------------------------------------------------------
  // 1. INDICES FISCAUX DIRECTS DANS LE TITRE
  // ----------------------------------------------------------

  const titrePatterns = [
    {
      pattern: /\btaxe\b|\btaxes\b/,
      label: 'TITRE_TAXE'
    },
    {
      pattern: /\bredevance\b|\bredevances\b/,
      label: 'TITRE_REDEVANCE'
    },
    {
      pattern: /\bimpot\b|\bimpots\b/,
      label: 'TITRE_IMPOT'
    },
    {
      pattern: /\bprecompte immobilier\b/,
      label: 'TITRE_PRECOMPTE_IMMOBILIER'
    },
    {
      pattern: /\bcentimes additionnels\b/,
      label: 'TITRE_CENTIMES_ADDITIONNELS'
    },
    {
      pattern: /\badditionnels\b/,
      label: 'TITRE_ADDITIONNELS'
    },
    {
      pattern: /\bforce motrice\b/,
      label: 'TITRE_FORCE_MOTRICE'
    },
    {
      pattern: /\bipp\b/,
      label: 'TITRE_IPP'
    },
    {
      pattern: /\bfiscal\b|\bfiscale\b|\bfiscalite\b/,
      label: 'TITRE_FISCALITE'
    }
  ];

  for (const item of titrePatterns) {
    if (item.pattern.test(t)) {
      indices.push(item.label);
    }
  }

  // ----------------------------------------------------------
  // 2. FORMULATIONS DE RÈGLEMENTS
  // ----------------------------------------------------------

  if (
    /\breglement\b/.test(t) &&
    (
      /\btaxe\b/.test(t) ||
      /\bredevance\b/.test(t) ||
      /\bimpot\b/.test(t) ||
      /\bfiscal/.test(t)
    )
  ) {
    indices.push(
      'TITRE_REGLEMENT_FISCAL'
    );
  }

  // ----------------------------------------------------------
  // 3. INDICES DANS LA MATIÈRE
  // ----------------------------------------------------------

  const matierePatterns = [
    {
      pattern: /\btaxe\b|\btaxes\b/,
      label: 'MATIERE_TAXE'
    },
    {
      pattern: /\bredevance\b|\bredevances\b/,
      label: 'MATIERE_REDEVANCE'
    },
    {
      pattern: /\bimpot\b|\bimpots\b/,
      label: 'MATIERE_IMPOT'
    },
    {
      pattern: /\bfiscal/,
      label: 'MATIERE_FISCALITE'
    },
    {
      pattern: /\bfinanc/,
      label: 'MATIERE_FINANCES'
    }
  ];

  for (const item of matierePatterns) {
    if (item.pattern.test(m)) {
      indices.push(item.label);
    }
  }

  // ----------------------------------------------------------
  // 4. INDICES DANS LE CONTENU
  //
  // On les garde volontairement larges.
  // ----------------------------------------------------------

  const bodyPatterns = [
    {
      pattern: /\bprecompte immobilier\b/,
      label: 'CONTENU_PRECOMPTE_IMMOBILIER'
    },
    {
      pattern: /\bcentimes additionnels\b/,
      label: 'CONTENU_CENTIMES_ADDITIONNELS'
    },
    {
      pattern: /\bforce motrice\b/,
      label: 'CONTENU_FORCE_MOTRICE'
    },
    {
      pattern: /\bimpot des personnes physiques\b/,
      label: 'CONTENU_IPP'
    },
    {
      pattern: /\bimpots communaux\b/,
      label: 'CONTENU_IMPOTS_COMMUNAUX'
    },
    {
      pattern: /\btaxe communale\b/,
      label: 'CONTENU_TAXE_COMMUNALE'
    },
    {
      pattern: /\bredevance communale\b/,
      label: 'CONTENU_REDEVANCE_COMMUNALE'
    }
  ];

  for (const item of bodyPatterns) {
    if (item.pattern.test(b)) {
      indices.push(item.label);
    }
  }

  // ----------------------------------------------------------
  // 5. TERMES QUI PEUVENT ÊTRE FISCAUX MAIS QUI DEMANDENT
  //    DU CONTEXTE
  // ----------------------------------------------------------

  const contextualTerms = [
    {
      pattern: /\bpublicite\b/,
      label: 'CONTEXTE_PUBLICITE'
    },
    {
      pattern: /\benseigne\b|\benseignes\b/,
      label: 'CONTEXTE_ENSEIGNE'
    },
    {
      pattern: /\bterrasse\b|\bterrasses\b/,
      label: 'CONTEXTE_TERRASSE'
    },
    {
      pattern: /\boccupation du domaine public\b/,
      label: 'CONTEXTE_DOMAINE_PUBLIC'
    },
    {
      pattern: /\bdechets\b|\bdechet\b/,
      label: 'CONTEXTE_DECHETS'
    },
    {
      pattern: /\bimmondices\b/,
      label: 'CONTEXTE_IMMONDICES'
    },
    {
      pattern: /\bmarche\b|\bmarches\b/,
      label: 'CONTEXTE_MARCHE'
    },
    {
      pattern: /\bstationnement\b/,
      label: 'CONTEXTE_STATIONNEMENT'
    },
    {
      pattern: /\bparking\b/,
      label: 'CONTEXTE_PARKING'
    }
  ];

  for (const item of contextualTerms) {
    if (item.pattern.test(t)) {
      indices.push(item.label);
    }
  }

  // ----------------------------------------------------------
  // 6. EXCLUSIONS ÉVIDENTES
  //
  // Elles ne suppriment pas nécessairement la décision si elle
  // possède un indice fiscal direct : elles servent surtout
  // à signaler les cas ambigus.
  // ----------------------------------------------------------

  if (
    /\bbail\b/.test(t) ||
    /\blocatif\b/.test(t) ||
    /\blocative\b/.test(t)
  ) {
    exclusions.push('BAIL_LOCATION');
  }

  if (
    /\bzone payante\b/.test(t) ||
    /\bzone bleue\b/.test(t) ||
    /\bzone rouge\b/.test(t)
  ) {
    exclusions.push('ZONE_STATIONNEMENT');
  }

  if (
    /\bstationnement\b/.test(t) &&
    !/\btaxe\b|\bredevance\b/.test(t)
  ) {
    exclusions.push('STATIONNEMENT_SANS_TAXE');
  }

  if (
    /\bvoirie\b/.test(t) &&
    !/\btaxe\b|\bredevance\b/.test(t)
  ) {
    exclusions.push('VOIRIE_SANS_TAXE');
  }

  if (
    /\bmarches publics\b/.test(t)
  ) {
    exclusions.push('MARCHES_PUBLICS');
  }

  // ----------------------------------------------------------
  // 7. NIVEAU DE PRIORITÉ
  //
  // Ce n'est PAS un score de "caractère fiscal".
  // Il sert uniquement à organiser l'examen manuel.
  // ----------------------------------------------------------

  let priorite = 'FAIBLE';

  const indiceFiscalDirect =
    indices.some(index =>
      [
        'TITRE_TAXE',
        'TITRE_REDEVANCE',
        'TITRE_IMPOT',
        'TITRE_PRECOMPTE_IMMOBILIER',
        'TITRE_CENTIMES_ADDITIONNELS',
        'TITRE_ADDITIONNELS',
        'TITRE_FORCE_MOTRICE',
        'TITRE_IPP',
        'TITRE_FISCALITE',
        'TITRE_REGLEMENT_FISCAL'
      ].includes(index)
    );

  const indiceFiscalContenu =
    indices.some(index =>
      index.startsWith('CONTENU_')
    );

  const indiceContextuel =
    indices.some(index =>
      index.startsWith('CONTEXTE_')
    );

  if (indiceFiscalDirect) {
    priorite = 'HAUTE';
  } else if (indiceFiscalContenu) {
    priorite = 'HAUTE';
  } else if (indiceContextuel) {
    priorite = 'MOYENNE';
  }

  // ----------------------------------------------------------
  // 8. DÉCISION À AFFICHER
  //
  // On ne cherche volontairement PAS à éliminer les faux
  // positifs à ce stade.
  // ----------------------------------------------------------

  const aExaminer =
    indiceFiscalDirect ||
    indiceFiscalContenu ||
    indiceContextuel;

  return {
    aExaminer,
    priorite,
    indices: [...new Set(indices)],
    exclusions: [...new Set(exclusions)]
  };
}

// ------------------------------------------------------------
// EXTRACTION DE CONTEXTES AUTOUR DES MOTS-CLÉS
// ------------------------------------------------------------

function extractContexts(text) {
  const normalized = normalizeText(text);
  const lower = normalizeForSearch(normalized);

  const keywords = [
    'taxe',
    'taxes',
    'redevance',
    'impot',
    'impots',
    'precompte immobilier',
    'centimes additionnels',
    'force motrice',
    'fiscal',
    'fiscalite',
    'ipp',
    'publicite',
    'enseigne',
    'dechets',
    'immondices',
    'stationnement',
    'terrasse'
  ];

  const contexts = [];

  for (const keyword of keywords) {
    let start = 0;

    while (true) {
      const index = lower.indexOf(
        keyword,
        start
      );

      if (index === -1) {
        break;
      }

      const contextStart = Math.max(
        0,
        index - 220
      );

      const contextEnd = Math.min(
        normalized.length,
        index +
          keyword.length +
          420
      );

      const context = normalized.slice(
        contextStart,
        contextEnd
      );

      if (!contexts.includes(context)) {
        contexts.push(context);
      }

      start =
        index +
        keyword.length;

      if (contexts.length >= 8) {
        return contexts;
      }
    }
  }

  return contexts;
}

// ------------------------------------------------------------
// AFFICHAGE D'UNE DÉCISION À EXAMINER
// ------------------------------------------------------------

function printCandidate(decision, index) {
  console.log('');
  console.log(
    '----------------------------------------'
  );

  console.log(
    `CANDIDAT V4 [${index}]`
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
    `PRIORITÉ : ${decision.analyse.priorite}`
  );

  console.log(
    `INDICES  : ${
      decision.analyse.indices.join(', ')
    }`
  );

  if (
    decision.analyse.exclusions.length > 0
  ) {
    console.log(
      `EXCLUSIONS : ${
        decision.analyse.exclusions.join(', ')
      }`
    );
  }

  if (
    decision.contexts.length > 0
  ) {
    console.log('');
    console.log('CONTEXTES :');

    for (const context of decision.contexts) {
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

// ------------------------------------------------------------
// PROGRAMME PRINCIPAL
// ------------------------------------------------------------

async function main() {

  console.log('');
  console.log(
    '========================================'
  );
  console.log(
    'DIAGNOSTIC FISCAL V4 — LIÈGE'
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

    // --------------------------------------------------------
    // ÉTAPE 1 — RÉCUPÉRATION DES 261 DÉCISIONS
    // --------------------------------------------------------

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
        await extractPage(page);

      console.log(
        `Liens de décisions détectés : ${result.links.length}`
      );

      console.log(
        `Liens de pagination détectés : ${result.paginationLinks.length}`
      );

      let newDecisions = 0;

      for (const link of result.links) {

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

      // ------------------------------------------------------
      // PAGINATION
      // ------------------------------------------------------

      const paginationCandidates = [];

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

    // --------------------------------------------------------
    // PROTECTION
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // ÉTAPE 2 — EXTRACTION DES DÉTAILS
    // --------------------------------------------------------

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'EXTRACTION DES DÉTAILS V4'
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
        analyseIndicesFiscaux(
          decision.titre,
          decision.matiere,
          decision.bodyText
        );

      if (
        decision.analyse.aExaminer
      ) {

        decision.contexts =
          extractContexts(
            decision.bodyText
          );
      }

      if (
        counter % 25 === 0
      ) {

        console.log(
          `Progression : ${counter}/${allDecisions.size}`
        );
      }

      await sleep(100);
    }

    // --------------------------------------------------------
    // ÉTAPE 3 — CONSTRUCTION DES LISTES
    // --------------------------------------------------------

    const decisions =
      [
        ...allDecisions.values()
      ];

    const candidates =
      decisions
        .filter(
          decision =>
            decision.analyse &&
            decision.analyse.aExaminer
        )
        .sort(
          (a, b) =>
            b.date.localeCompare(
              a.date
            )
        );

    const highPriority =
      candidates.filter(
        decision =>
          decision.analyse.priorite === 'HAUTE'
      );

    const mediumPriority =
      candidates.filter(
        decision =>
          decision.analyse.priorite === 'MOYENNE'
      );

    // --------------------------------------------------------
    // RÉSUMÉ
    // --------------------------------------------------------

    console.log('');
    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'RÉSUMÉ DU DIAGNOSTIC V4'
    );

    console.log(
      '========================================'
    );

    console.log(
      `Décisions analysées : ${decisions.length}`
    );

    console.log(
      `Candidats à examiner : ${candidates.length}`
    );

    console.log(
      `Priorité HAUTE : ${highPriority.length}`
    );

    console.log(
      `Priorité MOYENNE : ${mediumPriority.length}`
    );

    console.log(
      `Priorité FAIBLE : ${
        candidates.filter(
          decision =>
            decision.analyse.priorite === 'FAIBLE'
        ).length
      }`
    );

    // --------------------------------------------------------
    // LISTE HAUTE PRIORITÉ
    // --------------------------------------------------------

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'CANDIDATS — PRIORITÉ HAUTE'
    );

    console.log(
      '========================================'
    );

    if (
      highPriority.length === 0
    ) {

      console.log(
        'Aucun candidat.'
      );

    } else {

      highPriority.forEach(
        (decision, index) => {
          printCandidate(
            decision,
            index + 1
          );
        }
      );
    }

    // --------------------------------------------------------
    // LISTE MOYENNE PRIORITÉ
    // --------------------------------------------------------

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'CANDIDATS — PRIORITÉ MOYENNE'
    );

    console.log(
      '========================================'
    );

    if (
      mediumPriority.length === 0
    ) {

      console.log(
        'Aucun candidat.'
      );

    } else {

      mediumPriority.forEach(
        (decision, index) => {
          printCandidate(
            decision,
            index + 1
          );
        }
      );
    }

    // --------------------------------------------------------
    // LISTE COMPLÈTE DES TITRES
    //
    // Très importante pour construire le filtre définitif.
    // --------------------------------------------------------

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'LISTE COMPLÈTE DES 261 TITRES'
    );

    console.log(
      '========================================'
    );

    decisions
      .sort(
        (a, b) =>
          a.date.localeCompare(
            b.date
          )
      )
      .forEach(
        (decision, index) => {

          console.log(
            `${String(index + 1).padStart(3, '0')} | ${decision.date} | ${decision.titre}`
          );
        }
      );

    // --------------------------------------------------------
    // FIN
    // --------------------------------------------------------

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'FIN DU DIAGNOSTIC V4'
    );

    console.log(
      '========================================'
    );

    console.log('');

    console.log(
      "IMPORTANT : aucun fichier JSON n'a été modifié."
    );

    console.log(
      "IMPORTANT : ce diagnostic ne déclare aucune décision comme définitivement fiscale."
    );

    console.log(
      "La liste sert à construire le filtre fiscal définitif à partir des décisions réelles de Liège."
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
