import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const BASE_URL = "https://www.deliberations.be/liege/decisions";
const YEAR = 2026;

const OUTPUT_FILE = path.resolve(
  "src/data/reglements-taxes.json"
);

const PAGE_SIZE = 20;
const MAX_OFFSET = 2000;

const MIN_EXPECTED_DECISIONS = 500;
const MIN_EXPECTED_FISCAL = 1;

const CONCURRENCY = 3;
const MAX_RETRIES = 3;

// ============================================================
// OUTILS
// ============================================================

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

// ============================================================
// URL : DÉCISION 2026
// ============================================================

function isDecision2026(url) {
  if (!url) return false;

  return /\/decisions\/\d{1,2}-[a-zàâäéèêëîïôöùûüÿç]+-2026-\d{1,2}-\d{2}\//i.test(
    url
  );
}

// ============================================================
// RÉCUPÉRATION DES LIENS
// ============================================================

async function getDecisionLinks(page) {
  const allLinks = new Set();

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
    console.log(`→ ${url}`);

    try {
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 120000
      });

      await new Promise(resolve =>
        setTimeout(resolve, 500)
      );

      const links = await page.evaluate(() => {
        return Array.from(
          document.querySelectorAll("a")
        )
          .map(a => ({
            href: a.href || "",
            text: a.innerText?.trim() || ""
          }))
          .filter(x => x.href);
      });

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
        `   ${yearLinks.length} décisions 2026`
      );

      console.log(
        `   ${added} nouvelles → total ${allLinks.size}`
      );

      // ------------------------------------------------------
      // IMPORTANT :
      //
      // On continue jusqu'à ce qu'il n'y ait plus de résultats
      // 2026. On ne se fie pas à un nombre fixe de décisions.
      // ------------------------------------------------------

      if (
        offset > 0 &&
        yearLinks.length === 0
      ) {
        console.log(
          "   Plus aucune décision 2026."
        );
        break;
      }
    } catch (error) {
      console.log(
        `   Erreur offset ${offset} : ${error.message}`
      );
    }
  }

  return [...allLinks];
}

// ============================================================
// EXTRACTION D'UNE DÉCISION
// ============================================================

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

      await new Promise(resolve =>
        setTimeout(resolve, 400)
      );

      const result = await page.evaluate(() => {
        const title =
          document.querySelector("h1")
            ?.innerText
            ?.trim() ||
          document.querySelector("title")
            ?.innerText
            ?.trim() ||
          "";

        const bodyText =
          document.body?.innerText || "";

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
        `   Tentative ${attempt}/${MAX_RETRIES} échouée`
      );

      console.log(
        `   ${error.message}`
      );

      if (attempt < MAX_RETRIES) {
        await new Promise(resolve =>
          setTimeout(
            resolve,
            1000 * attempt
          )
        );
      }
    }
  }

  console.log(
    `   Échec définitif : ${url}`
  );

  return null;
}

// ============================================================
// CLASSIFICATION FISCALE
// ============================================================
//
// PRINCIPE :
//
// Une simple occurrence de :
//   - taxe
//   - redevance
//   - tarif
//   - communal
//
// NE SUFFIT JAMAIS.
//
// On cherche un véritable objet fiscal.
// ============================================================

function classifyFiscalDecision(decision) {
  const title = normalizeText(
    decision.title
  );

  const text = normalizeText(
    decision.text
  );

  const combined =
    `${title} ${text}`;

  // ----------------------------------------------------------
  // 1. EXCLUSIONS FORTES
  // ----------------------------------------------------------

  const exclusionTitlePatterns = [
    /\bsubvention\b/,
    /\bsubventions\b/,
    /\bsubside\b/,
    /\bsubsides\b/,
    /\bconvention\b/,
    /\bconventions\b/,
    /\bbail\b/,
    /\bbaux\b/,
    /\blocation\b/,
    /\blocatif\b/,
    /\bmarche public\b/,
    /\bcommande publique\b/,
    /\btravaux\b/,
    /\bfourniture\b/,
    /\bprestations\b/,
    /\bparking\b/,
    /\bstationnement\b/,
    /\bzone payante\b/,
    /\bterrasse\b/,
    /\bactivite ambulante\b/,
    /\bactivites ambulantes\b/,
    /\bcommerce ambulant\b/,
    /\bpatrimoine\b/,
    /\bmanifestation\b/,
    /\bfestival\b/,
    /\bevenement\b/
  ];

  if (
    exclusionTitlePatterns.some(
      pattern => pattern.test(title)
    )
  ) {
    return {
      isFiscal: false,
      confidence: "EXCLU",
      reasons: ["EXCLUSION_TITRE"]
    };
  }

  // ----------------------------------------------------------
  // 2. SIGNAUX FISCAUX DIRECTS DANS LE TITRE
  // ----------------------------------------------------------

  const directFiscalTitleSignals = [
    "reglement-taxe",
    "reglement taxe",
    "reglement des taxes",
    "reglement d une taxe",
    "reglement de taxe",

    "reglement-redevance",
    "reglement redevance",
    "reglement des redevances",
    "reglement de redevance",

    "taxe communale",
    "taxes communales",

    "centimes additionnels",

    "precompte immobilier",

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
    "taxe sur les logements",
    "taxe sur les commerces",
    "taxe sur les entreprises",
    "taxe sur les surfaces commerciales",

    "taxe sur les panneaux",
    "taxe sur la publicite",
    "taxe sur les antennes",
    "taxe sur les parkings",
    "taxe sur les dechets",
    "taxe sur les immondices"
  ];

  const directTitleMatches =
    directFiscalTitleSignals.filter(
      signal =>
        title.includes(signal)
    );

  if (
    directTitleMatches.length > 0
  ) {
    return {
      isFiscal: true,
      confidence: "FISCAL_CERTAIN",
      reasons: directTitleMatches
    };
  }

  // ----------------------------------------------------------
  // 3. OBJETS FISCAUX TRÈS SPÉCIFIQUES
  // ----------------------------------------------------------

  const strongFiscalObjects = [
    "precompte immobilier",
    "centimes additionnels",
    "force motrice",
    "impot des personnes physiques",
    "impots des personnes physiques",
    "ipp communal"
  ];

  const strongObjectMatches =
    strongFiscalObjects.filter(
      signal =>
        combined.includes(signal)
    );

  if (
    strongObjectMatches.length > 0
  ) {
    return {
      isFiscal: true,
      confidence: "FISCAL_PROBABLE",
      reasons: strongObjectMatches
    };
  }

  // ----------------------------------------------------------
  // 4. VÉRITABLE RÈGLEMENT FISCAL
  // ----------------------------------------------------------
  //
  // On exige plusieurs éléments simultanément.
  //
  // "redevance communale" toute seule = NON
  //
  // "redevance communale + règlement + objet précis"
  // = POSSIBLE
  // ----------------------------------------------------------

  const hasReglement =
    /\breglement\b/.test(combined) ||
    /\breglementation\b/.test(combined);

  const hasTax =
    /\btaxe\b/.test(combined) ||
    /\btaxes\b/.test(combined);

  const hasRedevance =
    /\bredevance\b/.test(combined) ||
    /\bredevances\b/.test(combined);

  const hasFiscalObject =
    [
      "immeuble",
      "immeubles",
      "bureau",
      "bureaux",
      "enseigne",
      "enseignes",
      "pylone",
      "pylones",
      "antenne",
      "antennes",
      "publicite",
      "logement",
      "logements",
      "dechet",
      "dechets",
      "immondice",
      "immondices",
      "surface commerciale",
      "surfaces commerciales",
      "commerce",
      "commerces",
      "entreprise",
      "entreprises",
      "seconde residence",
      "secondes residences"
    ].some(signal =>
      combined.includes(signal)
    );

  if (
    hasReglement &&
    (hasTax || hasRedevance) &&
    hasFiscalObject
  ) {
    return {
      isFiscal: true,
      confidence: "FISCAL_PROBABLE",
      reasons: [
        "REGLEMENT_FISCAL",
        hasTax
          ? "TAXE"
          : "REDEVANCE",
        "OBJET_FISCAL"
      ]
    };
  }

  // ----------------------------------------------------------
  // 5. CAS : TAUX / CENTIMES / EXERCICE
  // ----------------------------------------------------------
  //
  // Une décision fiscale peut ne pas contenir le mot
  // "règlement", par exemple une fixation de taux.
  // ----------------------------------------------------------

  const hasTaux =
    /\btaux\b/.test(combined);

  const hasExercice =
    new RegExp(
      `\\bexercice\\s+${YEAR}\\b`
    ).test(combined);

  const hasCentimes =
    /\bcentimes additionnels\b/.test(combined);

  if (
    hasTaux &&
    hasExercice &&
    (hasTax || hasCentimes)
  ) {
    return {
      isFiscal: true,
      confidence: "FISCAL_PROBABLE",
      reasons: [
        "TAUX_FISCAL",
        `EXERCICE_${YEAR}`
      ]
    };
  }

  // ----------------------------------------------------------
  // 6. TOUT LE RESTE = PAS FISCAL
  // ----------------------------------------------------------

  return {
    isFiscal: false,
    confidence: "NON_FISCAL",
    reasons: []
  };
}

// ============================================================
// MATIÈRE
// ============================================================

function determineMatter() {
  return "Fiscalité communale";
}

// ============================================================
// TRAITEMENT
// ============================================================

async function processDecisions(
  browser,
  decisionLinks
) {
  let cursor = 0;

  const fiscalResults = [];

  async function worker() {
    const page =
      await browser.newPage();

    try {
      while (true) {
        const index = cursor++;

        if (
          index >=
          decisionLinks.length
        ) {
          break;
        }

        const url =
          decisionLinks[index];

        console.log(
          `[${index + 1}/${decisionLinks.length}]`
        );

        const decision =
          await extractDecision(
            page,
            url
          );

        if (!decision) {
          continue;
        }

        const classification =
          classifyFiscalDecision(
            decision
          );

        if (
          classification.isFiscal
        ) {
          const result = {
            date: YEAR,
            title: decision.title,
            url: decision.url,
            matter:
              determineMatter(decision),
            confidence:
              classification.confidence,
            reasons:
              classification.reasons
          };

          console.log("");
          console.log(
            ">>> CANDIDAT FISCAL"
          );
          console.log(
            `    ${decision.title}`
          );
          console.log(
            `    ${classification.confidence}`
          );
          console.log(
            `    ${classification.reasons.join(", ")}`
          );
          console.log("");

          fiscalResults.push(
            result
          );
        }
      }
    } finally {
      await page.close();
    }
  }

  await Promise.all(
    Array.from(
      {
        length: CONCURRENCY
      },
      () => worker()
    )
  );

  return fiscalResults;
}

// ============================================================
// PROGRAMME PRINCIPAL
// ============================================================

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

  console.log(
    `Année : ${YEAR}`
  );

  console.log(
    `Concurrence : ${CONCURRENCY}`
  );

  console.log("");

  const browser =
    await puppeteer.launch({
      headless: true,

      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

  try {
    // --------------------------------------------------------
    // 1. RÉCUPÉRATION
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
      await getDecisionLinks(
        listingPage
      );

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
        `Le JSON existant ne sera PAS modifié.`
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

    console.log(
      "RÉSULTATS"
    );

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
        d =>
          d.confidence ===
          "FISCAL_CERTAIN"
      );

    const probable =
      fiscalDecisions.filter(
        d =>
          d.confidence ===
          "FISCAL_PROBABLE"
      );

    console.log(
      `FISCAL_CERTAIN : ${certain.length}`
    );

    console.log(
      `FISCAL_PROBABLE : ${probable.length}`
    );

    // --------------------------------------------------------
    // AFFICHAGE
    // --------------------------------------------------------

    if (
      fiscalDecisions.length > 0
    ) {
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
        "SÉCURITÉ : aucune décision fiscale " +
        "suffisamment identifiée. " +
        "Le fichier JSON existant ne sera PAS modifié."
      );
    }

    // --------------------------------------------------------
    // 4. JSON
    // --------------------------------------------------------

    const output = {
      commune: "Liège",
      annee: YEAR,
      updatedAt:
        new Date().toISOString(),
      source: BASE_URL,
      count:
        fiscalDecisions.length,
      decisions:
        fiscalDecisions
    };

    fs.mkdirSync(
      path.dirname(
        OUTPUT_FILE
      ),
      {
        recursive: true
      }
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

// ============================================================
// ERREUR GLOBALE
// ============================================================

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

  console.error(
    error
  );

  process.exit(1);
});
