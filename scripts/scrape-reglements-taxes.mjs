import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const BASE_URL = "https://www.deliberations.be/liege/decisions";
const YEAR = 2026;

const OUTPUT_FILE = path.resolve(
  "src/data/reglements-taxes.json"
);

// ------------------------------------------------------------
// PARAMÈTRES
// ------------------------------------------------------------

const PAGE_SIZE = 20;
const MAX_OFFSET = 2000;

// On reste volontairement prudent.
// Le site avait déjà permis de récupérer 761 décisions 2026.
const MIN_EXPECTED_DECISIONS = 500;
const MIN_EXPECTED_FISCAL = 1;

// 3 pages simultanées : suffisamment rapide mais plus stable
// que 5 ou davantage sur deliberations.be.
const CONCURRENCY = 3;

// Nombre de tentatives par décision
const MAX_RETRIES = 3;

// ------------------------------------------------------------
// NORMALISATION
// ------------------------------------------------------------

function normalizeText(text = "") {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(text = "") {
  return text
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

// ------------------------------------------------------------
// IDENTIFICATION D'UNE URL DE DÉCISION 2026
// ------------------------------------------------------------
//
// Les URL de deliberations.be ont une structure du type :
//
// /decisions/29-juin-2026-17-00/...
//
// On vérifie donc l'année dans le SEGMENT DE DATE,
// et non simplement la présence de "2026" dans l'URL.
// ------------------------------------------------------------

function isDecision2026(url) {
  if (!url) return false;

  const pattern =
    /\/decisions\/\d{1,2}-[a-zàâäéèêëîïôöùûüÿç]+-2026-\d{1,2}-\d{2}\//i;

  return pattern.test(url);
}

// ------------------------------------------------------------
// RÉCUPÉRATION DES LIENS
// ------------------------------------------------------------

async function getDecisionLinks(page) {
  const allLinks = new Set();

  let emptyCurrentYearPages = 0;

  for (
    let offset = 0;
    offset <= MAX_OFFSET;
    offset += PAGE_SIZE
  ) {
    const url =
      offset === 0
        ? BASE_URL
        : `${BASE_URL}/@@faceted_query?b_start:int=${offset}`;

    console.log("");
    console.log(`   → ${url}`);

    try {
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 120000
      });

      await new Promise(resolve => setTimeout(resolve, 700));

      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a"))
          .map(a => ({
            href: a.href || "",
            text: a.innerText?.trim() || ""
          }))
          .filter(item => item.href);
      });

      // ------------------------------------------------------
      // UNIQUEMENT LES URL DE DÉCISIONS 2026
      // ------------------------------------------------------

      const yearLinks = links.filter(link =>
        /\/decisions\/\d{1,2}-[a-zàâäéèêëîïôöùûüÿç]+-2026-\d{1,2}-\d{2}\//i.test(
          link.href
        )
      );

      const before = allLinks.size;

      for (const link of yearLinks) {
        allLinks.add(link.href);
      }

      const added = allLinks.size - before;

      console.log(
        `      ${links.length} liens trouvés`
      );

      console.log(
        `      ${yearLinks.length} décisions 2026`
      );

      console.log(
        `      ${added} nouvelles → total 2026 : ${allLinks.size}`
      );

      // ------------------------------------------------------
      // ARRÊT AUTOMATIQUE
      // ------------------------------------------------------

      if (yearLinks.length === 0) {
        emptyCurrentYearPages++;

        console.log(
          `      Aucune décision 2026 sur cette page (${emptyCurrentYearPages}/2)`
        );

        // Une page vide peut exceptionnellement arriver.
        // Deux pages consécutives sans décision 2026 =
        // on considère que les décisions 2026 sont terminées.
        if (emptyCurrentYearPages >= 2) {
          console.log(
            "      Fin de la série 2026 détectée."
          );
          break;
        }
      } else {
        emptyCurrentYearPages = 0;
      }
    } catch (error) {
      console.log(
        `      ERREUR page ${offset} : ${error.message}`
      );
    }
  }

  return [...allLinks];
}

// ------------------------------------------------------------
// EXTRACTION D'UNE DÉCISION
// ------------------------------------------------------------

async function extractDecision(page, url) {
  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 120000
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      const result = await page.evaluate(() => {
        const bodyText =
          document.body?.innerText || "";

        const title =
          document.querySelector("h1")?.innerText?.trim() ||
          document.querySelector("title")?.innerText?.trim() ||
          "";

        const links = Array.from(
          document.querySelectorAll("a")
        )
          .map(a => ({
            text: a.innerText?.trim() || "",
            href: a.href || ""
          }))
          .filter(x => x.href);

        return {
          title,
          bodyText,
          links
        };
      });

      return {
        url,
        title: cleanText(result.title),
        text: cleanText(result.bodyText),
        links: result.links
      };
    } catch (error) {
      console.log(
        `      Tentative ${attempt}/${MAX_RETRIES} échouée`
      );

      console.log(
        `      ${error.message}`
      );

      if (attempt < MAX_RETRIES) {
        await new Promise(resolve =>
          setTimeout(resolve, 1000 * attempt)
        );
      }
    }
  }

  console.log(
    `      ÉCHEC DÉFINITIF : ${url}`
  );

  return null;
}

// ------------------------------------------------------------
// CLASSIFICATION FISCALE
// ------------------------------------------------------------

function classifyFiscalDecision(decision) {
  const title = normalizeText(decision.title);
  const text = normalizeText(decision.text);

  // ----------------------------------------------------------
  // EXCLUSIONS
  // ----------------------------------------------------------

  const exclusionPatterns = [
    /\bbail\b/,
    /\bbaux\b/,
    /\blocatif\b/,
    /\blocation\b/,
    /\bmarche public\b/,
    /\bmarche de travaux\b/,
    /\bcommande publique\b/,
    /\bsubvention\b/,
    /\bsubside\b/,
    /\bparking\b/,
    /\bstationnement\b/,
    /\bzone payante\b/,
    /\bterrasse\b/,
    /\bactivites ambulantes\b/,
    /\bactivite ambulante\b/,
    /\bcommerce ambulant\b/,
    /\bcreashop\b/,
    /\bpatrimoine\b/,
    /\bpersonnes morales\b/,
    /\bpersonnes physiques\b/
  ];

  if (
    exclusionPatterns.some(pattern =>
      pattern.test(title)
    )
  ) {
    return {
      isFiscal: false,
      confidence: "EXCLU",
      reasons: ["EXCLUSION_TITRE"]
    };
  }

  // ----------------------------------------------------------
  // SIGNAUX FISCAUX TRÈS FORTS DANS LE TITRE
  // ----------------------------------------------------------

  const strongTitleSignals = [
    "reglement taxe",
    "reglement-taxe",
    "reglement redevance",
    "reglement-redevance",
    "taxe communale",
    "taxes communales",
    "redevance communale",
    "redevances communales",
    "precompte immobilier",
    "centimes additionnels",
    "force motrice",
    "impot des personnes physiques",
    "impots des personnes physiques",
    "ipp communal",
    "taxe sur les secondes residences",
    "taxe sur les immeubles",
    "taxe sur les bureaux",
    "taxe sur les enseignes",
    "taxe sur les pylones",
    "taxe sur les logements",
    "taxe sur les commerces",
    "taxe sur les entreprises",
    "taxe sur les surfaces commerciales"
  ];

  const strongTitleMatches =
    strongTitleSignals.filter(signal =>
      title.includes(signal)
    );

  if (strongTitleMatches.length > 0) {
    return {
      isFiscal: true,
      confidence: "FISCAL_CERTAIN",
      reasons: strongTitleMatches
    };
  }

  // ----------------------------------------------------------
  // OBJETS FISCAUX EXPLICITES DANS LE CONTENU
  // ----------------------------------------------------------

  const fiscalObjects = [
    "precompte immobilier",
    "centimes additionnels",
    "force motrice",
    "impot des personnes physiques",
    "impots des personnes physiques",
    "ipp communal",
    "taxe sur les secondes residences",
    "taxe sur les immeubles",
    "taxe sur les bureaux",
    "taxe sur les enseignes",
    "taxe sur les pylones",
    "taxe sur les logements",
    "taxe sur les commerces",
    "taxe sur les entreprises",
    "taxe sur les surfaces commerciales",
    "taxe communale",
    "taxes communales",
    "redevance communale",
    "redevances communales"
  ];

  const fiscalObjectMatches =
    fiscalObjects.filter(signal =>
      text.includes(signal)
    );

  // ----------------------------------------------------------
  // RÈGLEMENT FISCAL EXPLICITE
  // ----------------------------------------------------------

  const hasReglement =
    text.includes("reglement") ||
    text.includes("reglementation");

  const hasTax =
    text.includes("taxe") ||
    text.includes("taxes");

  const hasRedevance =
    text.includes("redevance") ||
    text.includes("redevances");

  const hasCommunal =
    text.includes("communal") ||
    text.includes("communale") ||
    text.includes("commune de liege") ||
    text.includes("ville de liege");

  // ----------------------------------------------------------
  // CAS FISCAL FORT
  // ----------------------------------------------------------

  if (
    hasReglement &&
    (hasTax || hasRedevance) &&
    hasCommunal &&
    fiscalObjectMatches.length > 0
  ) {
    return {
      isFiscal: true,
      confidence: "FISCAL_CERTAIN",
      reasons: [
        "REGLEMENT_FISCAL_EXPLICITE",
        ...fiscalObjectMatches
      ]
    };
  }

  // ----------------------------------------------------------
  // OBJETS FISCAUX PARTICULIÈREMENT SIGNIFICATIFS
  // ----------------------------------------------------------

  const veryStrongObjects = [
    "precompte immobilier",
    "centimes additionnels",
    "force motrice",
    "impot des personnes physiques",
    "impots des personnes physiques"
  ];

  const veryStrongMatches =
    veryStrongObjects.filter(signal =>
      text.includes(signal)
    );

  if (veryStrongMatches.length > 0) {
    return {
      isFiscal: true,
      confidence: "FISCAL_PROBABLE",
      reasons: veryStrongMatches
    };
  }

  // ----------------------------------------------------------
  // IMPORTANT :
  //
  // "redevance" seule
  // "tarif" seul
  // "taxe" seule
  //
  // NE SUFFISENT PAS.
  // ----------------------------------------------------------

  return {
    isFiscal: false,
    confidence: "NON_FISCAL",
    reasons: []
  };
}

// ------------------------------------------------------------
// MATIÈRE
// ------------------------------------------------------------

function determineMatter(decision) {
  const text = normalizeText(
    `${decision.title} ${decision.text}`
  );

  if (
    text.includes("precompte immobilier") ||
    text.includes("centimes additionnels") ||
    text.includes("force motrice") ||
    text.includes("impot des personnes physiques") ||
    text.includes("taxe communale") ||
    text.includes("redevance communale")
  ) {
    return "Fiscalité communale";
  }

  return "Fiscalité communale";
}

// ------------------------------------------------------------
// TRAITEMENT DES DÉCISIONS
// ------------------------------------------------------------

async function processDecisions(
  browser,
  decisionLinks
) {
  let cursor = 0;

  const allResults = [];

  async function worker(workerId) {
    const page = await browser.newPage();

    try {
      while (true) {
        const index = cursor++;

        if (index >= decisionLinks.length) {
          break;
        }

        const url = decisionLinks[index];

        console.log(
          `   [${index + 1}/${decisionLinks.length}]`
        );

        const decision =
          await extractDecision(page, url);

        if (!decision) {
          continue;
        }

        const classification =
          classifyFiscalDecision(decision);

        if (classification.isFiscal) {
          const matter =
            determineMatter(decision);

          console.log("");
          console.log(
            "   >>> CANDIDAT FISCAL"
          );
          console.log(
            `       ${decision.title}`
          );
          console.log(
            `       Confiance : ${classification.confidence}`
          );
          console.log(
            `       Matière : ${matter}`
          );
          console.log(
            `       Raisons : ${classification.reasons.join(", ")}`
          );
          console.log("");

          allResults.push({
            date: YEAR,
            title: decision.title,
            url: decision.url,
            matter,
            confidence: classification.confidence,
            reasons: classification.reasons
          });
        }
      }
    } finally {
      await page.close();
    }
  }

  await Promise.all(
    Array.from(
      { length: CONCURRENCY },
      (_, index) => worker(index + 1)
    )
  );

  return allResults;
}

// ------------------------------------------------------------
// PROGRAMME PRINCIPAL
// ------------------------------------------------------------

async function main() {
  console.log(
    "==============================================="
  );
  console.log(
    "SCRAPER FISCALITÉ COMMUNALE — LIÈGE"
  );
  console.log(
    "==============================================="
  );

  console.log(`Année : ${YEAR}`);
  console.log(`Concurrence : ${CONCURRENCY}`);
  console.log("");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  try {
    // --------------------------------------------------------
    // 1. RÉCUPÉRATION DES LIENS
    // --------------------------------------------------------

    console.log(
      "1. RÉCUPÉRATION DES DÉCISIONS 2026"
    );

    console.log(
      "-----------------------------------------------"
    );

    const listingPage =
      await browser.newPage();

    const decisionLinks =
      await getDecisionLinks(listingPage);

    await listingPage.close();

    console.log("");
    console.log(
      `TOTAL DÉCISIONS 2026 : ${decisionLinks.length}`
    );

    // --------------------------------------------------------
    // SÉCURITÉ
    // --------------------------------------------------------

    if (
      decisionLinks.length <
      MIN_EXPECTED_DECISIONS
    ) {
      throw new Error(
        `SÉCURITÉ : seulement ${decisionLinks.length} ` +
        `décisions 2026 trouvées. ` +
        `Minimum attendu : ${MIN_EXPECTED_DECISIONS}. ` +
        `Le fichier JSON existant ne sera PAS modifié.`
      );
    }

    // --------------------------------------------------------
    // 2. ANALYSE
    // --------------------------------------------------------

    console.log("");
    console.log(
      "2. ANALYSE DES DÉCISIONS 2026"
    );

    console.log(
      "-----------------------------------------------"
    );

    const fiscalDecisions =
      await processDecisions(
        browser,
        decisionLinks
      );

    // --------------------------------------------------------
    // 3. RÉSULTATS
    // --------------------------------------------------------

    console.log("");
    console.log(
      "==============================================="
    );

    console.log("RÉSULTATS");

    console.log(
      "==============================================="
    );

    console.log(
      `Décisions 2026 récupérées : ${decisionLinks.length}`
    );

    console.log(
      `Décisions fiscales retenues : ${fiscalDecisions.length}`
    );

    const certain =
      fiscalDecisions.filter(
        d => d.confidence === "FISCAL_CERTAIN"
      );

    const probable =
      fiscalDecisions.filter(
        d => d.confidence === "FISCAL_PROBABLE"
      );

    console.log(
      `FISCAL_CERTAIN : ${certain.length}`
    );

    console.log(
      `FISCAL_PROBABLE : ${probable.length}`
    );

    // --------------------------------------------------------
    // LISTE DES DÉCISIONS RETENUES
    // --------------------------------------------------------

    if (fiscalDecisions.length > 0) {
      console.log("");
      console.log(
        "DÉCISIONS FISCALES RETENUES :"
      );

      fiscalDecisions.forEach(
        (decision, index) => {
          console.log("");
          console.log(
            `${index + 1}. ${decision.title}`
          );

          console.log(
            `   URL : ${decision.url}`
          );

          console.log(
            `   Confiance : ${decision.confidence}`
          );

          console.log(
            `   Raisons : ${decision.reasons.join(", ")}`
          );
        }
      );
    }

    // --------------------------------------------------------
    // SÉCURITÉ JSON
    // --------------------------------------------------------

    if (
      fiscalDecisions.length <
      MIN_EXPECTED_FISCAL
    ) {
      throw new Error(
        "SÉCURITÉ : aucune décision fiscale suffisamment " +
        "identifiée. Le fichier JSON existant ne sera PAS modifié."
      );
    }

    // --------------------------------------------------------
    // 4. ÉCRITURE JSON
    // --------------------------------------------------------

    const output = {
      commune: "Liège",
      annee: YEAR,
      updatedAt: new Date().toISOString(),
      source: BASE_URL,
      count: fiscalDecisions.length,
      decisions: fiscalDecisions
    };

    fs.mkdirSync(
      path.dirname(OUTPUT_FILE),
      { recursive: true }
    );

    fs.writeFileSync(
      OUTPUT_FILE,
      JSON.stringify(
        output,
        null,
        2
      ),
      "utf8"
    );

    console.log("");
    console.log(
      `JSON MIS À JOUR : ${OUTPUT_FILE}`
    );

    console.log("");
    console.log(
      "==============================================="
    );

    console.log(
      "SCRAPING TERMINÉ AVEC SUCCÈS"
    );

    console.log(
      "==============================================="
    );
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------
// GESTION DES ERREURS
// ------------------------------------------------------------

main().catch(error => {
  console.error("");
  console.error(
    "==============================================="
  );
  console.error(
    "ERREUR DU SCRAPER"
  );
  console.error(
    "==============================================="
  );

  console.error(error);

  process.exit(1);
});
