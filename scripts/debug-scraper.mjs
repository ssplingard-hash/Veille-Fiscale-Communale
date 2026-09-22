import puppeteer from "puppeteer";

const BASE_URL = "https://www.deliberations.be/liege/decisions";
const YEAR = 2026;

const MAX_PAGES = 100;
const NAVIGATION_TIMEOUT = 60000;
const WAIT_AFTER_LOAD = 800;

// ============================================================
// NORMALISATION
// ============================================================

function normalize(text = "") {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function clean(text = "") {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// IDENTIFICATION D'UNE DÉCISION 2026
// ============================================================

function isDecision2026(url) {
  return (
    typeof url === "string" &&
    /\/liege\/decisions\/\d{1,2}-[a-zà-ÿ]+-2026-\d{1,2}-\d{2}\//i.test(
      url
    )
  );
}

// ============================================================
// EXTRACTION D'UNE PAGE
// ============================================================

async function extractPage(page, url) {
  console.log("");
  console.log("========================================");
  console.log("PAGE");
  console.log("========================================");
  console.log(url);

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT,
  });

  await new Promise((resolve) =>
    setTimeout(resolve, WAIT_AFTER_LOAD)
  );

  return await page.evaluate(() => {
    const decisions = [];
    const pagination = [];

    // --------------------------------------------------------
    // Décisions
    // --------------------------------------------------------

    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.href;
      const text = (a.innerText || a.textContent || "").trim();

      if (!href) return;

      if (
        /\/liege\/decisions\/\d{1,2}-[a-zà-ÿ]+-2026-\d{1,2}-\d{2}\//i.test(
          href
        )
      ) {
        decisions.push({
          url: href,
          title: text,
        });
      }
    });

    // --------------------------------------------------------
    // Pagination
    // --------------------------------------------------------

    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.href;

      if (!href) return;

      if (
        href.includes("@@faceted_query") &&
        href.includes("b_start")
      ) {
        pagination.push(href);
      }
    });

    return {
      decisions,
      pagination,
    };
  });
}

// ============================================================
// CLASSIFICATION DIAGNOSTIQUE
//
// IMPORTANT :
// On utilise UNIQUEMENT le titre.
//
// Aucun mot présent dans le body de la page ne peut déclencher
// une classification fiscale.
// ============================================================

function analyseTitre(title) {
  const t = normalize(title);

  const result = {
    fiscal: false,
    niveau: "NON",
    raisons: [],
  };

  // ----------------------------------------------------------
  // EXCLUSIONS MANIFESTES
  // ----------------------------------------------------------

  const exclusions = [
    ["marché public", /\bmarche(?:s)? public/],
    ["bon de commande", /\bbon(?:s)? de commande/],
    ["délégation", /\bdelegation de competence/],
    ["contrat", /\bcontrat(?:s)?\b/],
    ["convention", /\bconvention(?:s)?\b/],
    ["subside", /\bsubside(?:s)?\b/],
    ["subvention", /\bsubvention(?:s)?\b/],
    ["personnel", /\bnomination\b|\brecrutement\b|\bengagement\b/],
    ["règlement de police", /\breglement de police\b/],
    ["stationnement", /\bstationnement\b/],
    ["parking", /\bparking\b/],
    ["occupation de voirie", /\boccupation de la voie publique\b/],
    ["occupation domaine public", /\boccupation du domaine public\b/],
    ["festival", /\bfestival\b/],
    ["événement", /\bevenement\b/],
    ["bail", /\bbail\b/],
    ["location", /\blocation\b/],
    ["urbanisme", /\burbanisme\b/],
  ];

  for (const [label, regex] of exclusions) {
    if (regex.test(t)) {
      result.raisons.push(`EXCLUSION: ${label}`);
    }
  }

  /*
   * Une exclusion manifeste ne sera pas considérée comme fiscale,
   * sauf si le titre contient simultanément un véritable objet
   * fiscal explicite.
   */

  // ----------------------------------------------------------
  // SIGNAUX FISCAUX TRÈS FORTS
  // ----------------------------------------------------------

  const strongSignals = [
    ["règlement-taxe", /\breglement[- ]taxe\b/],
    ["règlement taxe", /\breglement taxe\b/],
    ["règlement taxes", /\breglement taxes\b/],

    ["centimes additionnels", /\bcentimes additionnels\b/],
    [
      "additionnels précompte immobilier",
      /\badditionnels.*precompte immobilier\b/,
    ],

    ["précompte immobilier", /\bprecompte immobilier\b/],

    ["impôt des personnes physiques", /\bimpot des personnes physiques\b/],
    ["IPP", /\bipp\b/],

    ["force motrice", /\bforce motrice\b/],

    ["taxe communale", /\btaxe communale\b/],
    ["taxes communales", /\btaxes communales\b/],

    ["taxe sur", /\btaxe sur\b/],
    ["taxe relative à", /\btaxe relative a\b/],
    ["taxe applicable", /\btaxe applicable\b/],

    ["imposition", /\bimposition(?:s)?\b/],
  ];

  for (const [label, regex] of strongSignals) {
    if (regex.test(t)) {
      result.fiscal = true;
      result.niveau = "FORT";
      result.raisons.push(`FISCAL: ${label}`);
    }
  }

  // ----------------------------------------------------------
  // OBJETS FISCAUX PRÉCIS
  // ----------------------------------------------------------

  const fiscalObjects = [
    ["immeubles", /\btaxe.*immeuble/],
    ["propriété", /\btaxe.*propriet/],
    ["terrains", /\btaxe.*terrain/],
    ["véhicules", /\btaxe.*vehicule/],
    ["voitures", /\btaxe.*voiture/],
    ["enseignes", /\btaxe.*enseigne/],
    ["publicité", /\btaxe.*publicite/],
    ["surfaces commerciales", /\btaxe.*surface commerciale/],
    ["commerces", /\btaxe.*commerce/],
    ["déchets", /\btaxe.*dechet/],
    ["ordures", /\btaxe.*ordure/],
    ["seconde résidence", /\btaxe.*seconde residence/],
    ["résidence secondaire", /\btaxe.*residence secondaire/],
    ["terrasses", /\btaxe.*terrasse/],
    ["débits de boissons", /\btaxe.*debit de boissons/],
    ["hôtels", /\btaxe.*hotel/],
    ["hébergement", /\btaxe.*hebergement/],
    ["séjour", /\btaxe.*sejour/],
    ["affichage", /\btaxe.*affichage/],
    ["chiens", /\btaxe.*chien/],
    ["animaux", /\btaxe.*animal/],
    ["activité économique", /\btaxe.*activite economique/],
    ["personnel", /\btaxe.*personnel/],
  ];

  for (const [label, regex] of fiscalObjects) {
    if (regex.test(t)) {
      result.fiscal = true;
      result.niveau = "FORT";
      result.raisons.push(`OBJET FISCAL: ${label}`);
    }
  }

  // ----------------------------------------------------------
  // RÈGLEMENT + TAXE
  // ----------------------------------------------------------

  if (
    /\breglement\b/.test(t) &&
    /\btaxe(?:s)?\b/.test(t)
  ) {
    result.fiscal = true;
    result.niveau = "FORT";
    result.raisons.push("RÈGLEMENT + TAXE");
  }

  // ----------------------------------------------------------
  // ACTION FISCALE + TAXE
  // ----------------------------------------------------------

  const fiscalActions =
    /\b(?:adoption|adopter|modification|modifier|abrogation|abroger|fixation|fixer|etablissement|etablir|actualisation|actualiser|renouvellement|renouveler)\b/;

  if (
    fiscalActions.test(t) &&
    /\btaxe(?:s)?\b/.test(t)
  ) {
    result.fiscal = true;
    result.niveau = "FORT";
    result.raisons.push("ACTION FISCALE + TAXE");
  }

  // ----------------------------------------------------------
  // REDEVANCE
  //
  // IMPORTANT :
  // "redevance" seule = INSUFFISANT.
  //
  // On la garde uniquement comme CANDIDAT À VÉRIFIER.
  // ----------------------------------------------------------

  if (/\bredevance\b/.test(t)) {
    result.raisons.push(
      "REDEVANCE : candidat à vérifier manuellement"
    );

    if (result.niveau === "NON") {
      result.niveau = "A_VERIFIER";
    }
  }

  // ----------------------------------------------------------
  // MOT "TAXE" SEUL
  //
  // On le signale mais on ne considère pas automatiquement
  // la décision comme fiscale.
  // ----------------------------------------------------------

  if (
    /\btaxe\b/.test(t) &&
    !result.fiscal
  ) {
    result.raisons.push(
      "TAXE présente mais contexte insuffisant"
    );

    result.niveau = "A_VERIFIER";
  }

  return result;
}

// ============================================================
// DÉDUPLICATION
// ============================================================

function deduplicateDecisions(decisions) {
  const map = new Map();

  for (const decision of decisions) {
    if (!decision.url) continue;

    if (!map.has(decision.url)) {
      map.set(decision.url, decision);
    }
  }

  return Array.from(map.values());
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("");
  console.log("==============================================");
  console.log("       DIAGNOSTIC SCRAPER LIÈGE");
  console.log("==============================================");
  console.log("");
  console.log(`Année recherchée : ${YEAR}`);
  console.log(`URL de départ : ${BASE_URL}`);
  console.log("");
  console.log(
    "IMPORTANT : ce script ne modifie AUCUN fichier."
  );
  console.log("");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

  try {
    // ========================================================
    // FILE D'URLS À VISITER
    // ========================================================

    const urlsToVisit = [BASE_URL];
    const visitedPages = new Set();

    const allDecisions = new Map();

    // ========================================================
    // PAGINATION COMPLÈTE
    // ========================================================

    while (
      urlsToVisit.length > 0 &&
      visitedPages.size < MAX_PAGES
    ) {
      const currentUrl = urlsToVisit.shift();

      if (visitedPages.has(currentUrl)) {
        continue;
      }

      visitedPages.add(currentUrl);

      console.log("");
      console.log(
        `PAGINATION : page ${visitedPages.size}`
      );

      try {
        const result = await extractPage(
          page,
          currentUrl
        );

        const decisions2026 =
          result.decisions.filter((decision) =>
            isDecision2026(decision.url)
          );

        console.log(
          `Décisions trouvées sur cette page : ${result.decisions.length}`
        );

        console.log(
          `Décisions 2026 : ${decisions2026.length}`
        );

        for (const decision of decisions2026) {
          if (!allDecisions.has(decision.url)) {
            allDecisions.set(
              decision.url,
              {
                ...decision,
                title: clean(decision.title),
              }
            );
          }
        }

        console.log(
          `TOTAL UNIQUE 2026 : ${allDecisions.size}`
        );

        // ----------------------------------------------------
        // Ajouter les pages de pagination découvertes
        // ----------------------------------------------------

        for (const paginationUrl of result.pagination) {
          if (
            !visitedPages.has(paginationUrl) &&
            !urlsToVisit.includes(paginationUrl)
          ) {
            urlsToVisit.push(paginationUrl);
          }
        }

        console.log(
          `Pages encore à visiter : ${urlsToVisit.length}`
        );
      } catch (error) {
        console.error("");
        console.error(
          "ERREUR sur la page :",
          currentUrl
        );
        console.error(error.message);
      }
    }

    // ========================================================
    // FIN COLLECTE
    // ========================================================

    const decisions = deduplicateDecisions(
      Array.from(allDecisions.values())
    );

    console.log("");
    console.log("==============================================");
    console.log("       COLLECTE TERMINÉE");
    console.log("==============================================");
    console.log("");
    console.log(
      `Pages visitées : ${visitedPages.size}`
    );
    console.log(
      `Décisions 2026 uniques : ${decisions.length}`
    );
    console.log("");

    if (decisions.length < 500) {
      console.log(
        "⚠️ ATTENTION : moins de 500 décisions récupérées."
      );
      console.log(
        "La pagination n'est probablement pas complète."
      );
      console.log("");
    }

    // ========================================================
    // TRI CHRONOLOGIQUE
    // ========================================================

    decisions.sort((a, b) =>
      a.url.localeCompare(b.url)
    );

    // ========================================================
    // ANALYSE DES TITRES
    // ========================================================

    console.log("");
    console.log("==============================================");
    console.log("       ANALYSE DES TITRES");
    console.log("==============================================");
    console.log("");

    const analysed = decisions.map((decision) => ({
      ...decision,
      analyse: analyseTitre(decision.title),
    }));

    const strongFiscal = analysed.filter(
      (decision) =>
        decision.analyse.niveau === "FORT"
    );

    const toVerify = analysed.filter(
      (decision) =>
        decision.analyse.niveau === "A_VERIFIER"
    );

    // ========================================================
    // RÉSULTATS
    // ========================================================

    console.log(
      `Décisions 2026 : ${analysed.length}`
    );

    console.log(
      `Candidats fiscaux FORTS : ${strongFiscal.length}`
    );

    console.log(
      `Candidats À VÉRIFIER : ${toVerify.length}`
    );

    console.log("");

    // ========================================================
    // CANDIDATS FISCAUX FORTS
    // ========================================================

    console.log("");
    console.log("==============================================");
    console.log("       CANDIDATS FISCAUX FORTS");
    console.log("==============================================");
    console.log("");

    if (strongFiscal.length === 0) {
      console.log(
        "Aucun candidat fiscal fort détecté."
      );
    } else {
      strongFiscal.forEach((decision, index) => {
        console.log("");
        console.log(
          `${index + 1}. ${decision.title}`
        );
        console.log(
          `   URL : ${decision.url}`
        );
        console.log(
          `   Raisons : ${decision.analyse.raisons.join(
            " | "
          )}`
        );
      });
    }

    // ========================================================
    // CANDIDATS À VÉRIFIER
    // ========================================================

    console.log("");
    console.log("");
    console.log("==============================================");
    console.log("       CANDIDATS À VÉRIFIER");
    console.log("==============================================");
    console.log("");

    if (toVerify.length === 0) {
      console.log(
        "Aucun candidat nécessitant une vérification."
      );
    } else {
      toVerify.forEach((decision, index) => {
        console.log("");
        console.log(
          `${index + 1}. ${decision.title}`
        );
        console.log(
          `   URL : ${decision.url}`
        );
        console.log(
          `   Raisons : ${decision.analyse.raisons.join(
            " | "
          )}`
        );
      });
    }

    // ========================================================
    // LISTE COMPLÈTE DES TITRES
    //
    // Utile pour repérer une éventuelle taxe dont le titre
    // utilise une formulation inattendue.
    // ========================================================

    console.log("");
    console.log("");
    console.log("==============================================");
    console.log("       LISTE COMPLÈTE DES DÉCISIONS 2026");
    console.log("==============================================");
    console.log("");

    analysed.forEach((decision, index) => {
      console.log(
        `${String(index + 1).padStart(3, "0")} | ${decision.title}`
      );
    });

    // ========================================================
    // RÉSUMÉ FINAL
    // ========================================================

    console.log("");
    console.log("");
    console.log("==============================================");
    console.log("       RÉSUMÉ FINAL");
    console.log("==============================================");
    console.log("");

    console.log(
      `Pages visitées             : ${visitedPages.size}`
    );

    console.log(
      `Décisions 2026             : ${analysed.length}`
    );

    console.log(
      `Candidats fiscaux forts    : ${strongFiscal.length}`
    );

    console.log(
      `Candidats à vérifier       : ${toVerify.length}`
    );

    console.log("");

    console.log(
      "Aucun fichier de données n'a été modifié."
    );

    console.log("");

    console.log(
      "=============================================="
    );

  } finally {
    await page.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error("");
  console.error("==============================================");
  console.error("ERREUR FATALE");
  console.error("==============================================");
  console.error("");
  console.error(error);
  process.exit(1);
});
