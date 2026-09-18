import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  return (text || '').replace(/\s+/g, ' ').trim();
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

async function extractDecisionDetails(page, url) {
  try {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: PAGE_TIMEOUT_MS
    });

    await sleep(500);

    return await page.evaluate(() => {
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

      return {
        matiere
      };
    });
  } catch (error) {
    console.log(`⚠️ Impossible de lire : ${url}`);

    return {
      matiere: ''
    };
  }
}

function getFiscalSignals(title, matiere) {
  const t = normalizeForSearch(title);
  const m = normalizeForSearch(matiere);

  const signals = [];

  // Signaux directement fiscaux
  if (/\btaxe\b/.test(t) || /\btaxes\b/.test(t)) {
    signals.push('TAXE');
  }

  if (
    /\bredevance\b/.test(t) ||
    /\bredevances\b/.test(t)
  ) {
    signals.push('REDEVANCE');
  }

  if (
    /\btarif\b/.test(t) ||
    /\btarifs\b/.test(t)
  ) {
    signals.push('TARIF');
  }

  if (/\btarification\b/.test(t)) {
    signals.push('TARIFICATION');
  }

  if (/\bprecompte\b/.test(t)) {
    signals.push('PRECOMPTE');
  }

  if (
    /\bimpot\b/.test(t) ||
    /\bimpots\b/.test(t)
  ) {
    signals.push('IMPOT');
  }

  if (/\bipp\b/.test(t)) {
    signals.push('IPP');
  }

  if (/\bcentimes additionnels\b/.test(t)) {
    signals.push('CENTIMES_ADDITIONNELS');
  }

  if (/\badditionnels\b/.test(t)) {
    signals.push('ADDITIONNELS');
  }

  if (/\bforce motrice\b/.test(t)) {
    signals.push('FORCE_MOTRICE');
  }

  if (
    /\breglement\b/.test(t) &&
    (
      /\btaxe\b/.test(t) ||
      /\bredevance\b/.test(t) ||
      /\btarif\b/.test(t)
    )
  ) {
    signals.push('REGLEMENT_FISCAL');
  }

  // Signaux liés au stationnement
  if (/\bstationnement\b/.test(t)) {
    signals.push('STATIONNEMENT');
  }

  if (/\bzone payante\b/.test(t)) {
    signals.push('ZONE_PAYANTE');
  }

  // Signaux provenant de la matière
  if (m) {
    if (
      /\btaxe\b/.test(m) ||
      /\btaxes\b/.test(m)
    ) {
      signals.push('MATIERE_TAXE');
    }

    if (
      /\bredevance\b/.test(m) ||
      /\bredevances\b/.test(m)
    ) {
      signals.push('MATIERE_REDEVANCE');
    }

    if (/\bfiscal/.test(m)) {
      signals.push('MATIERE_FISCALITE');
    }

    if (/\bprecompte\b/.test(m)) {
      signals.push('MATIERE_PRECOMPTE');
    }

    if (
      /\bimpot\b/.test(m) ||
      /\bimpots\b/.test(m)
    ) {
      signals.push('MATIERE_IMPOT');
    }

    if (/\bipp\b/.test(m)) {
      signals.push('MATIERE_IPP');
    }

    if (/\bforce motrice\b/.test(m)) {
      signals.push('MATIERE_FORCE_MOTRICE');
    }
  }

  return [...new Set(signals)];
}

async function main() {
  console.log('');
  console.log('========================================');
  console.log('DIAGNOSTIC FISCAL — LIÈGE');
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
     * ÉTAPE 1 — RÉCUPÉRATION DES DÉCISIONS
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
              matiere: ''
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

      /*
       * On récupère les vrais liens de pagination
       * générés par deliberations.be.
       *
       * On ne reconstruit PAS nous-mêmes les URLs.
       */

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

    /*
     * =====================================================
     * ÉTAPE 2 — CONTRÔLE DU NOMBRE DE DÉCISIONS
     * =====================================================
     */

    console.log('');
    console.log('========================================');
    console.log(
      `TOTAL UNIQUE : ${allDecisions.size} décisions 2026`
    );
    console.log('========================================');

    /*
     * Sécurité :
     * si le scraper récupère anormalement peu de décisions,
     * on arrête le diagnostic.
     */

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
     * ÉTAPE 3 — ANALYSE DES DÉCISIONS
     * =====================================================
     */

    console.log('');
    console.log('========================================');
    console.log(
      'ANALYSE DES DÉCISIONS'
    );
    console.log('========================================');

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

      const signals =
        getFiscalSignals(
          decision.titre,
          decision.matiere
        );

      decision.signals = signals;

      /*
       * On affiche uniquement les candidats.
       */

      if (signals.length > 0) {
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
          `INDICES  : ${signals.join(', ')}`
        );

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
     * ÉTAPE 4 — RÉSUMÉ
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
      'RÉSUMÉ DU DIAGNOSTIC'
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
     * ÉTAPE 5 — LISTE COMPLÈTE DES CANDIDATS
     * =====================================================
     */

    console.log('');
    console.log('========================================');
    console.log(
      'LISTE COMPLÈTE DES CANDIDATS'
    );
    console.log('========================================');

    for (const decision of candidates) {
      console.log(
        `${decision.date} | ` +
        `${decision.titre} | ` +
        `${decision.matiere || '(matière inconnue)'} | ` +
        `${decision.signals.join(', ')}`
      );

      console.log(
        `URL: ${decision.url}`
      );
    }

    /*
     * =====================================================
     * FIN
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
