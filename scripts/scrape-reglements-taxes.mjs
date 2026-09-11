/**
 * SCRAPER LIÈGE — TEST 2026
 *
 * Charge la page réelle des décisions de Liège avec Puppeteer,
 * récupère les vrais liens de pagination générés par le site,
 * puis parcourt les pages jusqu'à sortir de 2026.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OUTPUT_FILE = path.join(
  __dirname,
  '../src/data/reglements-taxes.json'
);

const BASE_URL = 'https://www.deliberations.be';
const LIEGE_URL = `${BASE_URL}/liege/decisions`;

const TARGET_YEAR = 2026;

const USER_AGENT =
  'VeilleFiscaleCommunale-bot/1.0 (+contact: voir depot GitHub)';

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

  const date = new Date(
    Date.UTC(year, months[monthName], day)
  );

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}


/* ============================================================
   EXTRACTION DES DÉCISIONS
   ============================================================ */

async function extractPage(page) {

  const result = await page.evaluate(() => {

    const links = [];

    for (const a of document.querySelectorAll('a[href]')) {

      const href = a.href || '';

      /*
       * Une vraie décision Liège ressemble à :
       *
       * /liege/decisions/07-septembre-2026-18-00/xxxxx
       *
       * On exclut :
       * - @@faceted_query
       * - autres pages techniques
       */
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

      /*
       * Structure attendue :
       *
       * liege
       * decisions
       * date-reunion
       * slug-decision
       */
      if (parts.length < 4) {
        continue;
      }

      const title = (
        a.innerText ||
        a.textContent ||
        ''
      ).replace(/\s+/g, ' ').trim();

      links.push({
        href,
        title
      });
    }


    /*
     * Récupération des liens de pagination réellement
     * générés par deliberations.be.
     */
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
      paginationLinks,
      url: window.location.href,
      title: document.title
    };
  });


  return result;
}


/* ============================================================
   CLASSIFICATION FISCALE
   ============================================================ */

function isFiscalTitle(title) {

  const t = normalizeText(title)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');


  /*
   * On utilise uniquement le titre.
   *
   * IMPORTANT :
   * pas de recherche de "ipp" seule :
   * cela provoquait notamment le faux positif "Philippet".
   */

  const fiscalPatterns = [

    /\breglement\b.*\btaxe\b/,
    /\breglement\b.*\btaxes\b/,

    /\breglement\b.*\bredevance\b/,
    /\breglement\b.*\bredevances\b/,

    /\breglement\b.*\bfiscal\b/,
    /\breglement\b.*\btaxation\b/,

    /\bprecompte immobilier\b/,
    /\bprecompte\b/,

    /\bcentimes additionnels\b/,
    /\badditionnels a l'ipp\b/,
    /\bimpot des personnes physiques\b/,
    /\bimpot des personnes morales\b/,

    /\bforce motrice\b/,

    /\btaxe sur\b/,
    /\btaxe communale\b/,
    /\btaxe additionnelle\b/,
    /\btaxe locale\b/,

    /\bredevance sur\b/,
    /\bredevance communale\b/
  ];


  const excludedPatterns = [

    /\bbail commercial\b/,
    /\bbail-type\b/,
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

    /\bcirculation\b/,
    /\blimitation de la vitesse\b/,
    /\bzone 30\b/
  ];


  if (excludedPatterns.some(pattern => pattern.test(t))) {
    return false;
  }

  return fiscalPatterns.some(pattern => pattern.test(t));
}


/* ============================================================
   MATIÈRE
   ============================================================ */

async function extractMatiere(page, decisionUrl) {

  try {

    await page.goto(decisionUrl, {
      waitUntil: 'networkidle2',
      timeout: PAGE_TIMEOUT_MS
    });

    await sleep(800);

    const html = await page.content();
    const $ = cheerio.load(html);

    let matiere = '';

    $('body *').each((_, el) => {

      const text = normalizeText($(el).text());

      if (
        text.toLowerCase().startsWith('matière')
        && text.length < 500
      ) {

        const parentText = normalizeText(
          $(el).parent().text()
        );

        const match = parentText.match(
          /Mati[eè]re\s*:?\s*(.+)$/i
        );

        if (match && !matiere) {
          matiere = normalizeText(match[1]);
        }
      }
    });

    return matiere;

  } catch {
    return '';
  }
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

  await page.setUserAgent(USER_AGENT);

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'fr'
  });


  const allDecisions = new Map();

  let currentUrl = LIEGE_URL;

  let pageNumber = 0;


  try {

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


      /*
       * Affichage de diagnostic des premiers liens.
       */
      for (const link of result.links.slice(0, 5)) {
        console.log(
          `  → ${link.title.substring(0, 120)}`
        );
        console.log(
          `    ${link.href}`
        );
      }


      /*
       * Ajouter les décisions.
       */
      let decisions2026ThisPage = 0;
      let decisionsBefore2026ThisPage = 0;

      for (const link of result.links) {

        const date = parseDateFromSlug(link.href);

        if (!date) {
          continue;
        }

        const year = date.getUTCFullYear();


        if (year === TARGET_YEAR) {

          const key = link.href;

          if (!allDecisions.has(key)) {

            allDecisions.set(key, {
              date: date.toISOString().slice(0, 10),
              titre: link.title || 'Décision',
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


      /*
       * Si on commence à rencontrer des décisions antérieures
       * à 2026, on peut arrêter lorsque la page contient
       * clairement des décisions plus anciennes.
       */
      if (
        decisionsBefore2026ThisPage > 0
        && decisions2026ThisPage === 0
      ) {

        console.log(
          'Fin de 2026 détectée.'
        );

        break;
      }


      /*
       * Chercher le prochain lien de pagination.
       *
       * On récupère le plus grand b_start supérieur à la page
       * actuelle.
       */
      const candidates = [];

      for (const pagination of result.paginationLinks) {

        const match = pagination.href.match(
          /b_start:int=(\d+)/
        );

        if (!match) {
          continue;
        }

        const offset = Number(match[1]);

        candidates.push({
          offset,
          href: pagination.href
        });
      }


      const currentOffset = (() => {

        const match = currentUrl.match(
          /b_start:int=(\d+)/
        );

        return match ? Number(match[1]) : 0;

      })();


      const nextCandidates = candidates
        .filter(item => item.offset > currentOffset)
        .sort((a, b) => a.offset - b.offset);


      if (nextCandidates.length === 0) {

        console.log(
          'Aucun lien de pagination suivant trouvé.'
        );

        break;
      }


      const next = nextCandidates[0];

      console.log(
        `Page suivante trouvée : offset ${next.offset}`
      );


      if (next.href === currentUrl) {

        console.log(
          'Protection : lien de pagination identique.'
        );

        break;
      }


      currentUrl = next.href;
    }


    console.log('');
    console.log('========================================');
    console.log(
      `TOTAL UNIQUE : ${allDecisions.size} décisions 2026`
    );
    console.log('========================================');


    /*
     * Maintenant seulement, ouvrir les décisions fiscales
     * pour récupérer la matière.
     */
    const fiscalDecisions = [
      ...allDecisions.values()
    ].filter(item => isFiscalTitle(item.titre));


    console.log('');
    console.log(
      `Décisions fiscales détectées : ${fiscalDecisions.length}`
    );


    for (let i = 0; i < fiscalDecisions.length; i++) {

      const item = fiscalDecisions[i];

      console.log(
        `[${i + 1}/${fiscalDecisions.length}] ${item.titre.substring(0, 120)}`
      );

      item.matiere = await extractMatiere(
        page,
        item.url
      );

      await sleep(300);
    }


    /*
     * Tri chronologique décroissant.
     */
    const finalItems = fiscalDecisions.sort(
      (a, b) => b.date.localeCompare(a.date)
    );


    /*
     * Protection absolue :
     * on ne touche pas au JSON si le scraping semble avoir échoué.
     */
    if (allDecisions.size < 100) {

      console.log('');
      console.log('⚠️ PROTECTION ACTIVÉE');
      console.log(
        `Seulement ${allDecisions.size} décisions 2026 récupérées.`
      );
      console.log(
        'Le JSON existant reste inchangé.'
      );

      return;
    }


    /*
     * Lire le JSON existant.
     */
    let existingData = {};

    try {

      existingData = JSON.parse(
        await fs.readFile(
          OUTPUT_FILE,
          'utf-8'
        )
      );

    } catch {
      existingData = {};
    }


    existingData['Liège'] = {
      updatedAt: new Date().toISOString(),

      reglementsEnVigueur: finalItems,

      prochainesTaxes: []
    };


    await fs.mkdir(
      path.dirname(OUTPUT_FILE),
      { recursive: true }
    );


    await fs.writeFile(
      OUTPUT_FILE,
      JSON.stringify(existingData, null, 2),
      'utf-8'
    );


    console.log('');
    console.log('========================================');
    console.log('JSON MIS À JOUR');
    console.log(`Décisions fiscales : ${finalItems.length}`);
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
