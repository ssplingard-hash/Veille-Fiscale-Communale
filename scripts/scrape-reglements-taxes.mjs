import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer";

const BASE_URL = "https://www.deliberations.be/liege/decisions";
const YEAR = 2026;

const OUTPUT_FILE = path.resolve(
  "src/data/reglements-taxes.json"
);

// ------------------------------------------------------------
// PARAMÈTRES DE SÉCURITÉ
// ------------------------------------------------------------

const MIN_EXPECTED_DECISIONS = 500;
const MIN_EXPECTED_FISCAL = 1;

const PAGE_SIZE = 20;
const MAX_OFFSET = 5000;
const CONCURRENCY = 5;

// ------------------------------------------------------------
// OUTILS
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

function absoluteUrl(url) {
  if (!url) return null;

  try {
    return new URL(url, BASE_URL).href;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// RÉCUPÉRATION DES DÉCISIONS
// ------------------------------------------------------------

async function getDecisionLinks(page) {
  const allLinks = new Set();

  for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE_SIZE) {
    const url =
      offset === 0
        ? BASE_URL
        : `${BASE_URL}/@@faceted_query?b_start:int=${offset}`;

    console.log(`   → ${url}`);

    try {
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 120000
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a"))
          .map(a => ({
            href: a.href,
            text: a.innerText?.trim() || ""
          }))
          .filter(item =>
            item.href &&
            item.href.includes("/liege/decisions/")
          );
      });

      const before = allLinks.size;

      for (const link of links) {
        if (
          link.href.includes("/@@faceted_query") ||
          link.href.endsWith("/decisions") ||
          link.href.includes("#")
        ) {
          continue;
        }

        allLinks.add(link.href);
      }

      const added = allLinks.size - before;

      console.log(
        `      ${links.length} liens trouvés → ${added} nouveaux → total ${allLinks.size}`
      );

      // Si une page ne rapporte plus aucune nouvelle décision,
      // on peut arrêter après avoir vérifié plusieurs pages.
      if (added === 0 && offset > 100) {
        console.log("      Aucun nouveau lien détecté.");
      }
    } catch (error) {
      console.log(
        `      ERREUR offset ${offset}: ${error.message}`
      );
    }
  }

  return [...allLinks];
}

// ------------------------------------------------------------
// EXTRACTION D'UNE DÉCISION
// ------------------------------------------------------------

async function extractDecision(page, url) {
  try {
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 120000
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    const result = await page.evaluate(() => {
      const bodyText = document.body?.innerText || "";

      const title =
        document.querySelector("h1")?.innerText?.trim() ||
        document.querySelector("title")?.innerText?.trim() ||
        "";

      const links = Array.from(document.querySelectorAll("a"))
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
      `   ERREUR décision ${url}: ${error.message}`
    );

    return null;
  }
}

// ------------------------------------------------------------
// CLASSIFICATION FISCALE
// ------------------------------------------------------------

function classifyFiscalDecision(decision) {
  const title = normalizeText(decision.title);
  const text = normalizeText(decision.text);

  // ----------------------------------------------------------
  // EXCLUSIONS FORTES
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
    /\bdomaine public\b.*\bambulant\b/,
    /\bactivites ambulantes\b/,
    /\bcommerce ambulant\b/,
    /\bcreashop\b/,
    /\bpatrimoine\b/,
    /\bpersonnes morales\b/,
    /\bpersonnes physiques\b/
  ];

  const excluded = exclusionPatterns.some(pattern => {
    return pattern.test(title);
  });

  if (excluded) {
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
    "taxe sur les secondes residences",
    "taxe sur les immeubles",
    "taxe sur les bureaux",
    "taxe sur les enseignes",
    "taxe sur les pylones",
    "taxe sur les pylônes",
    "taxe sur les residences",
    "taxe sur les logements",
    "taxe sur les commerces",
    "taxe sur les commerces et entreprises"
  ];

  const strongTitleMatches = strongTitleSignals.filter(signal =>
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
  // SIGNAUX FISCAUX DANS LE CONTENU
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

  const fiscalObjectMatches = fiscalObjects.filter(signal =>
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
  // CAS TRÈS FORT :
  // règlement + taxe/redevance + objet fiscal précis
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
  // OBJET FISCAL TRÈS CLAIR
  // ----------------------------------------------------------

  const veryStrongObjects = [
    "precompte immobilier",
    "centimes additionnels",
    "force motrice",
    "impot des personnes physiques",
    "impots des personnes physiques"
  ];

  const veryStrongMatches = veryStrongObjects.filter(signal =>
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
  // TAXE / REDEVANCE SEULE = INSUFFISANT
  //
  // C'est volontaire.
  //
  // Une simple mention de "redevance", "tarif" ou "taxe"
  // ne suffit PAS à considérer une décision comme fiscale.
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

  if (
    text.includes("urbanisme") ||
    text.includes("amenagement du territoire")
  ) {
    return "Urbanisme";
  }

  if (
    text.includes("mobilite") ||
    text.includes("stationnement") ||
    text.includes("parking")
  ) {
    return "Mobilité";
  }

  if (
    text.includes("commerce") ||
    text.includes("commercial") ||
    text.includes("entreprise")
  ) {
    return "Développement économique & commercial";
  }

  if (
    text.includes("patrimoine") ||
    text.includes("batiment") ||
    text.includes("immeuble")
  ) {
    return "Patrimoine";
  }

  return "Autre";
}

// ------------------------------------------------------------
// TRAITEMENT PAR LOTS
// ------------------------------------------------------------

async function processInBatches(items, batchSize, processor) {
  const results = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    console.log(
      `\n   Lot ${Math.floor(i / batchSize) + 1} / ${Math.ceil(
        items.length / batchSize
      )} (${batch.length} décisions)`
    );

    const batchResults = await Promise.all(
      batch.map(item => processor(item))
    );

    results.push(...batchResults);

    console.log(
      `   Progression : ${Math.min(
        i + batch.length,
        items.length
      )} / ${items.length}`
    );
  }

  return results;
}

// ------------------------------------------------------------
// PROGRAMME PRINCIPAL
// ------------------------------------------------------------

async function main() {
  console.log("===============================================");
  console.log("SCRAPER FISCALITÉ COMMUNALE — LIÈGE");
  console.log("===============================================");
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
    // ÉTAPE 1 : RÉCUPÉRER LES LIENS
    // --------------------------------------------------------

    console.log("1. RÉCUPÉRATION DES DÉCISIONS");
    console.log("-----------------------------------------------");

    const listingPage = await browser.newPage();

    const decisionLinks = await getDecisionLinks(listingPage);

    await listingPage.close();

    console.log("");
    console.log(
      `TOTAL : ${decisionLinks.length} décisions trouvées`
    );

    if (decisionLinks.length < MIN_EXPECTED_DECISIONS) {
      throw new Error(
        `SÉCURITÉ : seulement ${decisionLinks.length} décisions trouvées. ` +
        `Minimum attendu : ${MIN_EXPECTED_DECISIONS}. ` +
        `Le fichier existant ne sera PAS modifié.`
      );
    }

    // --------------------------------------------------------
    // ÉTAPE 2 : ANALYSER TOUTES LES DÉCISIONS
    // --------------------------------------------------------

    console.log("");
    console.log("2. ANALYSE DES DÉCISIONS");
    console.log("-----------------------------------------------");

    const pages = [];

    for (let i = 0; i < CONCURRENCY; i++) {
      pages.push(await browser.newPage());
    }

    let cursor = 0;

    async function worker(page) {
      const results = [];

      while (true) {
        const index = cursor++;

        if (index >= decisionLinks.length) {
          break;
        }

        const url = decisionLinks[index];

        console.log(
          `   [${index + 1}/${decisionLinks.length}] ${url}`
        );

        const decision = await extractDecision(page, url);

        if (!decision) {
          continue;
        }

        const classification =
          classifyFiscalDecision(decision);

        if (classification.isFiscal) {
          const matter = determineMatter(decision);

          console.log("");
          console.log(
            `   >>> CANDIDAT FISCAL : ${decision.title}`
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

          results.push({
            date: YEAR,
            title: decision.title,
            url: decision.url,
            matter,
            confidence: classification.confidence,
            reasons: classification.reasons
          });
        }
      }

      return results;
    }

    const workerResults = await Promise.all(
      pages.map(page => worker(page))
    );

    for (const page of pages) {
      await page.close();
    }

    const fiscalDecisions = workerResults.flat();

    // --------------------------------------------------------
    // ÉTAPE 3 : RÉSULTATS
    // --------------------------------------------------------

    console.log("");
    console.log("===============================================");
    console.log("RÉSULTATS");
    console.log("===============================================");

    console.log(
      `Décisions analysées : ${decisionLinks.length}`
    );

    console.log(
      `Décisions fiscales retenues : ${fiscalDecisions.length}`
    );

    const certain = fiscalDecisions.filter(
      d => d.confidence === "FISCAL_CERTAIN"
    );

    const probable = fiscalDecisions.filter(
      d => d.confidence === "FISCAL_PROBABLE"
    );

    console.log(
      `   FISCAL_CERTAIN : ${certain.length}`
    );

    console.log(
      `   FISCAL_PROBABLE : ${probable.length}`
    );

    // --------------------------------------------------------
    // AFFICHAGE DÉTAILLÉ
    // --------------------------------------------------------

    if (fiscalDecisions.length > 0) {
      console.log("");
      console.log("DÉCISIONS FISCALES :");

      fiscalDecisions.forEach((decision, index) => {
        console.log("");
        console.log(`${index + 1}. ${decision.title}`);
        console.log(`   URL : ${decision.url}`);
        console.log(`   Matière : ${decision.matter}`);
        console.log(
          `   Confiance : ${decision.confidence}`
        );
        console.log(
          `   Raisons : ${decision.reasons.join(", ")}`
        );
      });
    }

    // --------------------------------------------------------
    // SÉCURITÉ : NE PAS ÉCRASER LE JSON AVEC DU VIDE
    // --------------------------------------------------------

    if (fiscalDecisions.length < MIN_EXPECTED_FISCAL) {
      throw new Error(
        `SÉCURITÉ : aucune décision fiscale suffisamment ` +
        `identifiée. Le fichier ${OUTPUT_FILE} ` +
        `ne sera PAS modifié.`
      );
    }

    // --------------------------------------------------------
    // ÉCRITURE DU JSON
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
      JSON.stringify(output, null, 2),
      "utf8"
    );

    console.log("");
    console.log(
      `JSON MIS À JOUR : ${OUTPUT_FILE}`
    );

    console.log("");
    console.log("===============================================");
    console.log("SCRAPING TERMINÉ AVEC SUCCÈS");
    console.log("===============================================");
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error("");
  console.error("===============================================");
  console.error("ERREUR DU SCRAPER");
  console.error("===============================================");
  console.error(error);
  process.exit(1);
});
