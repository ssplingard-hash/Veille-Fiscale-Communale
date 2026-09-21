import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

const BASE_URL = 'https://www.deliberations.be';
const LIEGE_URL = `${BASE_URL}/liege/decisions`;

const TARGET_YEAR = 2026;

const PAGE_TIMEOUT_MS = 30000;
const LIST_WAIT_MS = 1200;
const DETAIL_WAIT_MS = 700;

const MIN_EXPECTED_DECISIONS = 500;
const MIN_EXPECTED_FISCAL = 1;

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

  return new Date(Date.UTC(
    year,
    months[monthName],
    day
  ));
}

function titleFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;

    const parts = pathname
      .split('/')
      .filter(Boolean);

    const slug = parts[parts.length - 1];

    if (!slug) return '';

    return decodeURIComponent(slug)
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, c => c.toUpperCase());

  } catch {
    return '';
  }
}

function getRealTitle(linkTitle, url) {
  const slugTitle = titleFromUrl(url);

  if (slugTitle && slugTitle.length >= 5) {
    return slugTitle;
  }

  return normalizeText(linkTitle) || 'Décision';
}

async function extractDecisionLinks(page) {
  return await page.evaluate(() => {
    const results = [];

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

      results.push({
        url: href,
        linkTitle: (
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
 * Récupère tout le texte visible de la décision.
 *
 * On ne cherche plus uniquement "Matière".
 * C'est volontaire : certaines décisions fiscales
 * peuvent ne pas présenter cette information de manière
 * suffisamment exploitable dans le HTML.
 */
async function extractDecisionText(page) {
  return await page.evaluate(() => {
    return (
      document.body?.innerText ||
      document.body?.textContent ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
  });
}

/*
 * Extraction spécifique de la matière lorsqu'elle existe.
 */
async function extractMatiere(page) {
  return await page.evaluate(() => {
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
          return nextText;
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

        if (match?.[1]) {
          return match[1].trim();
        }
      }
    }

    return '';
  });
}

/*
 * Classification fiscale.
 *
 * Principe :
 * - le titre reste important ;
 * - le contenu complet de la décision peut confirmer ;
 * - les faux positifs connus sont explicitement exclus ;
 * - on conserve un score et les raisons dans le log.
 */
function classifyFiscalDecision(
  titre,
  matiere,
  contenu
) {
  const t = normalizeForSearch(titre);
  const m = normalizeForSearch(matiere);
  const c = normalizeForSearch(contenu);

  let score = 0;

  const raisons = [];
  const exclusions = [];

  /*
   * EXCLUSIONS FORTES
   */

  if (/\bbail\b/.test(t)) {
    exclusions.push('BAIL');
  }

  if (
    /\bmarches publics\b/.test(t) ||
    /\bmarches public\b/.test(t)
  ) {
    exclusions.push('MARCHES_PUBLICS');
  }

  if (
    /\btva\b/.test(t) ||
    /\btaxe sur la valeur ajoutee\b/.test(t)
  ) {
    exclusions.push('TVA');
  }

  /*
   * Stationnement / parking :
   * ce n'est fiscal que si le titre fait réellement
   * apparaître taxe/redevance/impôt/précompte/etc.
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
      /\bimpot\b/.test(t) ||
      /\bprecompte\b/.test(t) ||
      /\bcentimes additionnels\b/.test(t)
    )
  ) {
    exclusions.push('STATIONNEMENT');
  }

  /*
   * Le titre est le signal le plus fiable.
   */

  const titleSignals = [
    [
      /\breglement[- ]taxe\b/,
      100,
      'REGLEMENT_TAXE'
    ],
    [
      /\breglement[- ]redevance\b/,
      100,
      'REGLEMENT_REDEVANCE'
    ],
    [
      /\breglement\b.*\btaxe\b/,
      90,
      'REGLEMENT_ET_TAXE'
    ],
    [
      /\breglement\b.*\bredevance\b/,
      90,
      'REGLEMENT_ET_REDEVANCE'
    ],
    [
      /\btaxe communale\b/,
      90,
      'TAXE_COMMUNALE'
    ],
    [
      /\bredevance communale\b/,
      90,
      'REDEVANCE_COMMUNALE'
    ],
    [
      /\bprecompte immobilier\b/,
      100,
      'PRECOMPTE_IMMOBILIER'
    ],
    [
      /\bcentimes additionnels\b/,
      100,
      'CENTIMES_ADDITIONNELS'
    ],
    [
      /\bforce motrice\b/,
      100,
      'FORCE_MOTRICE'
    ],
    [
      /\bimpot des personnes physiques\b/,
      100,
      'IPP'
    ],
    [
      /\bimpots communaux\b/,
      90,
      'IMPOTS_COMMUNAUX'
    ],
    [
      /\badditionnels\b.*\bipp\b/,
      90,
      'IPP_ADDITIONNELS'
    ]
  ];

  for (const [regex, points, reason] of titleSignals) {
    if (regex.test(t)) {
      score += points;
      raisons.push(reason);
    }
  }

  /*
   * Un "taxe" ou "redevance" isolé dans le titre
   * est un signal moins fort.
   */
  if (/\btaxes?\b/.test(t)) {
    score += 40;
    raisons.push('TAXE_DANS_TITRE');
  }

  if (/\bredevances?\b/.test(t)) {
    score += 40;
    raisons.push('REDEVANCE_DANS_TITRE');
  }

  /*
   * La matière peut confirmer.
   */
  if (/\btaxe\b/.test(m)) {
    score += 20;
    raisons.push('TAXE_MATIERE');
  }

  if (/\bredevance\b/.test(m)) {
    score += 20;
    raisons.push('REDEVANCE_MATIERE');
  }

  if (/\bfiscal/.test(m)) {
    score += 30;
    raisons.push('FISCAL_MATIERE');
  }

  /*
   * CONTENU DE LA DÉCISION
   *
   * On ne considère pas qu'un simple mot fiscal dans
   * n'importe quel texte suffit.
   *
   * Il faut plusieurs occurrences ou une combinaison
   * suffisamment forte.
   */

  const contentSignals = [
    [
      /\breglement[- ]taxe\b/g,
      80,
      'REGLEMENT_TAXE_CONTENU'
    ],
    [
      /\breglement[- ]redevance\b/g,
      80,
      'REGLEMENT_REDEVANCE_CONTENU'
    ],
    [
      /\bprecompte immobilier\b/g,
      80,
      'PRECOMPTE_CONTENU'
    ],
    [
      /\bcentimes additionnels\b/g,
      80,
      'CENTIMES_CONTENU'
    ],
    [
      /\bforce motrice\b/g,
      80,
      'FORCE_MOTRICE_CONTENU'
    ],
    [
      /\bimpot des personnes physiques\b/g,
      80,
      'IPP_CONTENU'
    ]
  ];

  for (const [regex, points, reason] of contentSignals) {
    const matches = c.match(regex);

    if (matches && matches.length > 0) {
      score += points;
      raisons.push(reason);
    }
  }

  /*
   * Combinaisons très significatives dans le contenu.
   */
  const hasTax = /\btaxe\b/.test(c);
  const hasReglement = /\breglement\b/.test(c);
  const hasCommunal = /\bcommunal\b/.test(c);

  if (hasTax && hasReglement && hasCommunal) {
    score += 35;
    raisons.push('TAXE_REGLEMENT_COMMUNAL_CONTENU');
  }

  /*
   * Si une exclusion forte existe, on élimine.
   */
  if (
    exclusions.includes('BAIL') ||
    exclusions.includes('MARCHES_PUBLICS') ||
    exclusions.includes('TVA') ||
    exclusions.includes('STATIONNEMENT')
  ) {
    return {
      niveau: 'NON_FISCAL',
      score,
      raisons,
      exclusions
    };
  }

  /*
   * Seuils :
   *
   * >= 80 : fiscal certain
   * 50-79 : fiscal probable
   * < 50 : non fiscal
   */
  if (score >= 80) {
    return {
      niveau: 'FISCAL_CERTAIN',
      score,
      raisons,
      exclusions
    };
  }

  if (score >= 50) {
    return {
      niveau: 'FISCAL_PROBABLE',
      score,
      raisons,
      exclusions
    };
  }

  return {
    niveau: 'NON_FISCAL',
    score,
    raisons,
    exclusions
  };
}

async function scrapeAllDecisions(page) {
  const allDecisions = new Map();

  let offset = 0;

  while (true) {
    const url =
      offset === 0
        ? LIEGE_URL
        : `${LIEGE_URL}/@@faceted_query?b_start:int=${offset}`;

    console.log('');
    console.log(`Page offset ${offset}`);
    console.log(`→ ${url}`);

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: PAGE_TIMEOUT_MS
    });

    await sleep(LIST_WAIT_MS);

    const links =
      await extractDecisionLinks(page);

    const yearLinks =
      links.filter(link => {
        const date =
          parseDateFromSlug(link.url);

        return (
          date &&
          date.getUTCFullYear() === TARGET_YEAR
        );
      });

    let newCount = 0;

    for (const link of yearLinks) {
      if (allDecisions.has(link.url)) {
        continue;
      }

      const date =
        parseDateFromSlug(link.url);

      allDecisions.set(link.url, {
        date: date.toISOString().slice(0, 10),
        titre: getRealTitle(
          link.linkTitle,
          link.url
        ),
        matiere: '',
        contenu: '',
        url: link.url
      });

      newCount++;
    }

    console.log(
      `  ${yearLinks.length} décision(s) 2026`
    );

    console.log(
      `  ${newCount} nouvelle(s)`
    );

    if (yearLinks.length < 20) {
      console.log(
        '  Dernière page atteinte.'
      );
      break;
    }

    offset += 20;
  }

  return [...allDecisions.values()];
}

async function main() {
  console.log('');
  console.log('========================================');
  console.log('SCRAPER FISCAL V7 — LIÈGE');
  console.log(`ANNÉE : ${TARGET_YEAR}`);
  console.log('========================================');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors'
    ]
  });

  const page = await browser.newPage();

  try {
    const decisions =
      await scrapeAllDecisions(page);

    console.log('');
    console.log('========================================');
    console.log(
      `TOTAL : ${decisions.length} décisions ${TARGET_YEAR}`
    );
    console.log('========================================');

    if (
      decisions.length <
      MIN_EXPECTED_DECISIONS
    ) {
      console.log('');
      console.log('⚠️ PROTECTION ACTIVÉE');
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
     * ==================================================
     * DIAGNOSTIC DES TITRES
     * ==================================================
     *
     * On affiche maintenant les 30 premiers titres.
     * Cela permet de vérifier définitivement que les
     * titres issus des URL sont bien ceux attendus.
     */

    console.log('');
    console.log('========================================');
    console.log('DIAGNOSTIC — 30 PREMIERS TITRES');
    console.log('========================================');

    decisions.slice(0, 30).forEach(
      (decision, index) => {
        console.log(
          `${index + 1}. ${decision.date} | ${decision.titre}`
        );
        console.log(
          `   ${decision.url}`
        );
      }
    );

    /*
     * ==================================================
     * PREMIER FILTRE
     * ==================================================
     *
     * On ne charge le contenu complet que pour les
     * décisions dont le titre contient un signal fiscal.
     */

    const candidates = [];

    for (const decision of decisions) {
      const analyse =
        classifyFiscalDecision(
          decision.titre,
          '',
          ''
        );

      decision.analyse = analyse;

      if (
        analyse.niveau !== 'NON_FISCAL'
      ) {
        candidates.push(decision);
      }
    }

    console.log('');
    console.log('========================================');
    console.log(
      `CANDIDATS APRÈS TITRE : ${candidates.length}`
    );
    console.log('========================================');

    /*
     * ==================================================
     * LECTURE DES PAGES CANDIDATES
     * ==================================================
     */

    let counter = 0;

    for (const decision of candidates) {
      counter++;

      console.log('');
      console.log(
        `[${counter}/${candidates.length}] ${decision.titre}`
      );

      try {
        await page.goto(
          decision.url,
          {
            waitUntil: 'networkidle2',
            timeout: PAGE_TIMEOUT_MS
          }
        );

        await sleep(DETAIL_WAIT_MS);

        decision.matiere =
          normalizeText(
            await extractMatiere(page)
          );

        decision.contenu =
          normalizeText(
            await extractDecisionText(page)
          );

      } catch (error) {
        console.log(
          `  ⚠️ Impossible de lire la page : ${error.message}`
        );

        decision.matiere = '';
        decision.contenu = '';
      }

      const analyse =
        classifyFiscalDecision(
          decision.titre,
          decision.matiere,
          decision.contenu
        );

      decision.analyse = analyse;

      console.log(
        `  Score : ${analyse.score}`
      );

      console.log(
        `  Niveau : ${analyse.niveau}`
      );

      console.log(
        `  Raisons : ${
          analyse.raisons.join(', ') ||
          '(aucune)'
        }`
      );

      console.log(
        `  Matière : ${
          decision.matiere ||
          '(inconnue)'
        }`
      );
    }

    /*
     * ==================================================
     * RÉSULTAT FINAL
     * ==================================================
     */

    const finalCandidates =
      candidates.filter(
        decision =>
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
    console.log('========================================');
    console.log(
      `DÉCISIONS FISCALES RETENUES : ${finalCandidates.length}`
    );
    console.log('========================================');

    console.log(
      `Fiscal certain : ${certains.length}`
    );

    console.log(
      `Fiscal probable : ${probables.length}`
    );

    for (const decision of finalCandidates) {
      console.log('');
      console.log('----------------------------------------');

      console.log(
        `${decision.date} | ${decision.titre}`
      );

      console.log(
        `SCORE : ${decision.analyse.score}`
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
          decision.analyse.raisons.join(', ')
        }`
      );

      console.log(
        `URL : ${decision.url}`
      );
    }

    /*
     * ==================================================
     * PROTECTION ABSOLUE
     * ==================================================
     */

    if (
      finalCandidates.length <
      MIN_EXPECTED_FISCAL
    ) {
      console.log('');
      console.log('========================================');
      console.log(
        '⚠️ PROTECTION FISCALE ACTIVÉE'
      );
      console.log(
        'Aucune décision fiscale exploitable.'
      );
      console.log(
        "LE JSON EXISTANT N'EST PAS MODIFIÉ."
      );
      console.log('========================================');

      return;
    }

    /*
     * ==================================================
     * ÉCRITURE JSON
     * ==================================================
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
            date: decision.date,
            titre: decision.titre,
            matiere:
              decision.matiere || '',
            url: decision.url
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
    console.log('========================================');
    console.log('✓ JSON MIS À JOUR');
    console.log('========================================');

    console.log(
      `Liège : ${finalCandidates.length} décisions fiscales`
    );

    console.log(outputPath);

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
