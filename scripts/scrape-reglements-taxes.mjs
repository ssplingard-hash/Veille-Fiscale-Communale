import puppeteer from 'puppeteer';

const BASE_URL = 'https://www.deliberations.be';
const LIEGE_URL = `${BASE_URL}/liege/decisions`;

const TARGET_YEAR = 2026;
const PAGE_TIMEOUT_MS = 30000;
const RENDER_WAIT_MS = 1800;
const MAX_PAGES = 30;

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

function titleFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const slug = pathname.split('/').filter(Boolean).pop();

    if (!slug) return '';

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
    Date.UTC(year, months[monthName], day)
  );
}

/*
 * =========================================================
 * EXTRACTION D'UNE PAGE DE LISTE
 * =========================================================
 */

async function extractPage(page) {
  return await page.evaluate(() => {
    const links = [];

    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href || '';

      if (
        !href.includes('/liege/decisions/') ||
        href.includes('@@faceted_query')
      ) {
        continue;
      }

      const pathname = new URL(href).pathname;
      const parts = pathname.split('/').filter(Boolean);

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

/*
 * =========================================================
 * EXTRACTION DU CONTENU COMPLET D'UNE DÉCISION
 * =========================================================
 *
 * On ne regarde plus uniquement "Matière".
 *
 * On récupère :
 * - titre visible
 * - matière
 * - texte complet de la page
 * - liens vers documents éventuels
 */

async function extractDecisionDetails(page, url) {
  try {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: PAGE_TIMEOUT_MS
    });

    await sleep(700);

    return await page.evaluate(() => {
      const bodyText = (
        document.body?.innerText ||
        document.body?.textContent ||
        ''
      ).replace(/\s+/g, ' ').trim();

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
        ).replace(/\s+/g, ' ').trim();

        if (!/^mati[eè]re\s*:?\s*$/i.test(text)) {
          continue;
        }

        const next = element.nextElementSibling;

        if (next) {
          const nextText = (
            next.innerText ||
            next.textContent ||
            ''
          ).replace(/\s+/g, ' ').trim();

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
          ).replace(/\s+/g, ' ').trim();

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

      const documentLinks = [];

      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href || '';

        if (!href) continue;

        const text = (
          a.innerText ||
          a.textContent ||
          ''
        ).replace(/\s+/g, ' ').trim();

        const lowerHref = href.toLowerCase();

        if (
          lowerHref.includes('.pdf') ||
          lowerHref.includes('document') ||
          lowerHref.includes('annexe') ||
          lowerHref.includes('download') ||
          lowerHref.includes('file')
        ) {
          documentLinks.push({
            href,
            text
          });
        }
      }

      return {
        matiere,
        bodyText,
        documentLinks
      };
    });

  } catch (error) {
    console.log(`⚠️ Impossible de lire : ${url}`);

    return {
      matiere: '',
      bodyText: '',
      documentLinks: []
    };
  }
}

/*
 * =========================================================
 * RECHERCHE DES INDICES FISCAUX
 * =========================================================
 *
 * IMPORTANT :
 *
 * STATIONNEMENT et ZONE PAYANTE ne sont PAS considérés
 * comme des indices fiscaux.
 *
 * Nous voulons détecter :
 * - taxes
 * - redevances
 * - impôts
 * - précompte
 * - centimes additionnels
 * - force motrice
 * - IPP
 * - règlement-taxe
 * - etc.
 */

function getFiscalSignals(title, matiere, bodyText) {
  const t = normalizeForSearch(title);
  const m = normalizeForSearch(matiere);
  const b = normalizeForSearch(bodyText);

  const signals = [];

  function add(signal) {
    if (!signals.includes(signal)) {
      signals.push(signal);
    }
  }

  /*
   * ---------------------------------------------------------
   * TITRE
   * ---------------------------------------------------------
   */

  if (/\btaxe\b|\btaxes\b/.test(t)) {
    add('TITRE_TAXE');
  }

  if (
    /\bredevance\b|\bredevances\b/.test(t)
  ) {
    add('TITRE_REDEVANCE');
  }

  if (
    /\btarif\b|\btarifs\b|\btarification\b/.test(t)
  ) {
    add('TITRE_TARIF');
  }

  if (/\bprecompte\b/.test(t)) {
    add('TITRE_PRECOMPTE');
  }

  if (
    /\bimpot\b|\bimpots\b/.test(t)
  ) {
    add('TITRE_IMPOT');
  }

  if (/\bipp\b/.test(t)) {
    add('TITRE_IPP');
  }

  if (
    /\bcentimes additionnels\b/.test(t)
  ) {
    add('TITRE_CENTIMES_ADDITIONNELS');
  }

  if (/\bforce motrice\b/.test(t)) {
    add('TITRE_FORCE_MOTRICE');
  }

  if (
    /\breglement\b/.test(t) &&
    (
      /\btaxe\b/.test(t) ||
      /\bredevance\b/.test(t)
    )
  ) {
    add('TITRE_REGLEMENT_FISCAL');
  }

  /*
   * ---------------------------------------------------------
   * MATIÈRE
   * ---------------------------------------------------------
   */

  if (/\btaxe\b|\btaxes\b/.test(m)) {
    add('MATIERE_TAXE');
  }

  if (
    /\bredevance\b|\bredevances\b/.test(m)
  ) {
    add('MATIERE_REDEVANCE');
  }

  if (/\bfiscal/.test(m)) {
    add('MATIERE_FISCALITE');
  }

  if (/\bprecompte\b/.test(m)) {
    add('MATIERE_PRECOMPTE');
  }

  if (
    /\bimpot\b|\bimpots\b/.test(m)
  ) {
    add('MATIERE_IMPOT');
  }

  if (/\bipp\b/.test(m)) {
    add('MATIERE_IPP');
  }

  if (/\bforce motrice\b/.test(m)) {
    add('MATIERE_FORCE_MOTRICE');
  }

  /*
   * ---------------------------------------------------------
   * CONTENU COMPLET DE LA DÉCISION
   * ---------------------------------------------------------
   */

  if (/\btaxe\b|\btaxes\b/.test(b)) {
    add('CONTENU_TAXE');
  }

  if (
    /\bredevance\b|\bredevances\b/.test(b)
  ) {
    add('CONTENU_REDEVANCE');
  }

  if (
    /\bprecompte immobilier\b/.test(b)
  ) {
    add('CONTENU_PRECOMPTE_IMMOBILIER');
  }

  if (
    /\bprecompte\b/.test(b)
  ) {
    add('CONTENU_PRECOMPTE');
  }

  if (
    /\bimpot\b|\bimpots\b/.test(b)
  ) {
    add('CONTENU_IMPOT');
  }

  if (
    /\bipp\b/.test(b)
  ) {
    add('CONTENU_IPP');
  }

  if (
    /\bcentimes additionnels\b/.test(b)
  ) {
    add('CONTENU_CENTIMES_ADDITIONNELS');
  }

  if (
    /\badditionnels\b/.test(b)
  ) {
    add('CONTENU_ADDITIONNELS');
  }

  if (
    /\bforce motrice\b/.test(b)
  ) {
    add('CONTENU_FORCE_MOTRICE');
  }

  if (
    /\breglement[- ]taxe\b/.test(b)
  ) {
    add('CONTENU_REGLEMENT_TAXE');
  }

  if (
    /\breglement[- ]redevance\b/.test(b)
  ) {
    add('CONTENU_REGLEMENT_REDEVANCE');
  }

  /*
   * Termes particulièrement utiles pour la fiscalité
   * communale belge.
   */

  if (
    /\btaxe communale\b/.test(b)
  ) {
    add('CONTENU_TAXE_COMMUNALE');
  }

  if (
    /\btaxe additionnelle\b/.test(b)
  ) {
    add('CONTENU_TAXE_ADDITIONNELLE');
  }

  if (
    /\btaxe sur\b/.test(b)
  ) {
    add('CONTENU_TAXE_SUR');
  }

  if (
    /\btaxe de\b/.test(b)
  ) {
    add('CONTENU_TAXE_DE');
  }

  if (
    /\btaxe directe\b/.test(b)
  ) {
    add('CONTENU_TAXE_DIRECTE');
  }

  return signals;
}

/*
 * =========================================================
 * EXTRACTION DE CONTEXTE AUTOUR DES MOTS FISCAUX
 * =========================================================
 *
 * Cela nous permettra de comprendre pourquoi une décision
 * est détectée.
 */

function extractFiscalContexts(text) {
  const normalized = normalizeText(text);

  const lower = normalizeForSearch(normalized);

  const keywords = [
    'taxe',
    'taxes',
    'redevance',
    'redevances',
    'precompte',
    'impot',
    'impots',
    'ipp',
    'centimes additionnels',
    'force motrice',
    'reglement-taxe',
    'reglement taxe',
    'reglement-redevance',
    'reglement redevance'
  ];

  const contexts = [];

  for (const keyword of keywords) {
    let startIndex = 0;

    while (true) {
      const index = lower.indexOf(keyword, startIndex);

      if (index === -1) {
        break;
      }

      const start = Math.max(0, index - 180);
      const end = Math.min(
        normalized.length,
        index + keyword.length + 300
      );

      contexts.push(
        normalized.slice(start, end)
      );

      startIndex = index + keyword.length;

      if (contexts.length >= 8) {
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
  console.log('========================================');
  console.log('DIAGNOSTIC FISCAL APPROFONDI — LIÈGE');
  console.log(`ANNÉE : ${TARGET_YEAR}`);
  console.log(
    'MODE : DIAGNOSTIC — AUCUNE ÉCRITURE JSON'
  );
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
    /*
     * =====================================================
     * 1. RÉCUPÉRATION DES 261 DÉCISIONS
     * =====================================================
     */

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

      const result = await extractPage(page);

      console.log(
        `Liens de décisions détectés : ${result.links.length}`
      );

      console.log(
        `Liens de pagination détectés : ${result.paginationLinks.length}`
      );

      let decisions2026ThisPage = 0;
      let decisionsBefore2026ThisPage = 0;

      for (const link of result.links) {
        const date = parseDateFromSlug(link.href);

        if (!date) {
          continue;
        }

        const year = date.getUTCFullYear();

        if (year === TARGET_YEAR) {
          if (!allDecisions.has(link.href)) {
            allDecisions.set(link.href, {
              date: date.toISOString().slice(0, 10),
              titre: getRealTitle(
                link.title,
                link.href
              ),
              url: link.href,
              matiere: '',
              bodyText: '',
              documentLinks: [],
              signals: [],
              contexts: []
            });

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
        console.log('Fin de 2026 détectée.');
        break;
      }

      const paginationCandidates = [];

      for (const pagination of result.paginationLinks) {
        const match = pagination.href.match(
          /b_start:int=(\d+)/
        );

        if (!match) {
          continue;
        }

        paginationCandidates.push({
          offset: Number(match[1]),
          href: pagination.href
        });
      }

      const currentOffsetMatch =
        currentUrl.match(/b_start:int=(\d+)/);

      const currentOffset =
        currentOffsetMatch
          ? Number(currentOffsetMatch[1])
          : 0;

      const nextCandidates =
        paginationCandidates
          .filter(
            item => item.offset > currentOffset
          )
          .sort(
            (a, b) => a.offset - b.offset
          );

      if (nextCandidates.length === 0) {
        console.log(
          'Aucun lien de pagination suivant trouvé.'
        );
        break;
      }

      currentUrl = nextCandidates[0].href;
    }

    console.log('');
    console.log('========================================');
    console.log(
      `TOTAL UNIQUE : ${allDecisions.size} décisions 2026`
    );
    console.log('========================================');

    if (allDecisions.size < 100) {
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
     * 2. ANALYSE APPROFONDIE
     * =====================================================
     */

    console.log('');
    console.log('========================================');
    console.log(
      'ANALYSE DU CONTENU DES 261 DÉCISIONS'
    );
    console.log('========================================');
    console.log('');

    let counter = 0;

    for (const decision of allDecisions.values()) {
      counter++;

      const details =
        await extractDecisionDetails(
          page,
          decision.url
        );

      decision.matiere =
        normalizeText(details.matiere);

      decision.bodyText =
        normalizeText(details.bodyText);

      decision.documentLinks =
        details.documentLinks || [];

      decision.signals =
        getFiscalSignals(
          decision.titre,
          decision.matiere,
          decision.bodyText
        );

      if (decision.signals.length > 0) {
        decision.contexts =
          extractFiscalContexts(
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
            decision.matiere || '(non trouvée)'
          }`
        );

        console.log(
          `INDICES  : ${decision.signals.join(', ')}`
        );

        console.log(
          `DOCUMENTS : ${decision.documentLinks.length}`
        );

        if (decision.contexts.length > 0) {
          console.log('');
          console.log('CONTEXTE :');

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

      if (counter % 25 === 0) {
        console.log('');
        console.log(
          `Progression : ${counter}/${allDecisions.size}`
        );
      }

      await sleep(100);
    }

    /*
     * =====================================================
     * 3. RÉSUMÉ
     * =====================================================
     */

    const candidates =
      [...allDecisions.values()]
        .filter(
          decision =>
            decision.signals &&
            decision.signals.length > 0
        )
        .sort(
          (a, b) =>
            b.date.localeCompare(a.date)
        );

    console.log('');
    console.log('');
    console.log('========================================');
    console.log(
      'RÉSUMÉ DU DIAGNOSTIC APPROFONDI'
    );
    console.log('========================================');

    console.log(
      `Décisions 2026 analysées : ${allDecisions.size}`
    );

    console.log(
      `Décisions candidates : ${candidates.length}`
    );

    /*
     * =====================================================
     * 4. STATISTIQUES DES INDICES
     * =====================================================
     */

    const signalCounts = new Map();

    for (const decision of candidates) {
      for (const signal of decision.signals) {
        signalCounts.set(
          signal,
          (signalCounts.get(signal) || 0) + 1
        );
      }
    }

    console.log('');
    console.log('INDICES DÉTECTÉS :');

    for (
      const [signal, count]
      of [...signalCounts.entries()]
        .sort((a, b) => b[1] - a[1])
    ) {
      console.log(
        `  ${signal} : ${count}`
      );
    }

    /*
     * =====================================================
     * 5. LISTE DES CANDIDATS
     * =====================================================
     */

    console.log('');
    console.log('========================================');
    console.log(
      'LISTE DES CANDIDATS'
    );
    console.log('========================================');

    for (const decision of candidates) {
      console.log('');
      console.log(
        `${decision.date} | ${decision.titre}`
      );

      console.log(
        `MATIÈRE : ${
          decision.matiere || '(inconnue)'
        }`
      );

      console.log(
        `INDICES : ${decision.signals.join(', ')}`
      );

      console.log(
        `URL : ${decision.url}`
      );
    }

    /*
     * =====================================================
     * 6. FIN
     * =====================================================
     */

    console.log('');
    console.log('========================================');
    console.log(
      'FIN DU DIAGNOSTIC'
    );
    console.log('========================================');
    console.log('');

    console.log(
      "IMPORTANT : aucun fichier JSON n'a été modifié."
    );

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
