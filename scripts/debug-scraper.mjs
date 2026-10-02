import puppeteer from "puppeteer";
import fs from "node:fs/promises";

const BASE_URL = "https://www.deliberations.be/liege/decisions";
const YEAR = 2026;

const MAX_PAGES = 100;
const NAVIGATION_TIMEOUT = 60000;
const WAIT_AFTER_LOAD = 800;

const EXTRACTION_FILE = "tmp/liege-2026-texts.json";

// ============================================================
// NORMALISATION
// ============================================================

function normalize(text = "") {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function clean(text = "") {
  return String(text)
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
// CLASSIFICATION FISCALE
//
// IMPORTANT :
// - Le titre seul ne suffit plus.
// - On utilise le texte réellement extrait de la décision
//   lorsque celui-ci est disponible.
// - Les faux positifs connus sont explicitement exclus.
// ============================================================

function analyseDecision(title, body = "") {
  const t = normalize(title);
  const b = normalize(body);

  const result = {
    fiscal: false,
    niveau: "NON",
    raisons: [],
    score: 0,
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

  let exclusionTrouvee = false;

  for (const [label, regex] of exclusions) {
    if (regex.test(t)) {
      exclusionTrouvee = true;
      result.raisons.push(`EXCLUSION TITRE: ${label}`);
    }
  }

  // ----------------------------------------------------------
  // SIGNAUX FISCAUX TRÈS FORTS DANS LE TITRE
  // ----------------------------------------------------------

  const strongTitleSignals = [
    ["règlement-taxe", /\breglement[- ]taxe\b/],
    ["règlement taxe", /\breglement taxe\b/],
    ["règlement taxes", /\breglement taxes\b/],
    ["centimes additionnels", /\bcentimes additionnels\b/],
    ["précompte immobilier", /\bprecompte immobilier\b/],
    ["impôt des personnes physiques", /\bimpot des personnes physiques\b/],
    ["IPP", /\bipp\b/],
    ["force motrice", /\bforce motrice\b/],
    ["taxe communale", /\btaxe communale\b/],
    ["taxes communales", /\btaxes communales\b/],
  ];

  for (const [label, regex] of strongTitleSignals) {
    if (regex.test(t)) {
      result.score += 10;
      result.raisons.push(`FISCAL TITRE: ${label}`);
    }
  }

  // ----------------------------------------------------------
  // OBJETS FISCAUX PRÉCIS
  // ----------------------------------------------------------

  const fiscalObjects = [
    ["immeubles", /\btaxe[^.]{0,100}\bimmeuble/],
    ["terrains", /\btaxe[^.]{0,100}\bterrain/],
    ["véhicules", /\btaxe[^.]{0,100}\bvehicule/],
    ["voitures", /\btaxe[^.]{0,100}\bvoiture/],
    ["enseignes", /\btaxe[^.]{0,100}\benseigne/],
    ["publicité", /\btaxe[^.]{0,100}\bpublicite/],
    ["surfaces commerciales", /\btaxe[^.]{0,100}\bsurface commerciale/],
    ["commerces", /\btaxe[^.]{0,100}\bcommerce/],
    ["déchets", /\btaxe[^.]{0,100}\bdechet/],
    ["ordures", /\btaxe[^.]{0,100}\bordure/],
    ["seconde résidence", /\btaxe[^.]{0,100}\bseconde residence/],
    ["résidence secondaire", /\btaxe[^.]{0,100}\bresidence secondaire/],
    ["terrasses", /\btaxe[^.]{0,100}\bterrasse/],
    ["débits de boissons", /\btaxe[^.]{0,100}\bdebit de boissons/],
    ["hôtels", /\btaxe[^.]{0,100}\bhotel/],
    ["hébergement", /\btaxe[^.]{0,100}\bhebergement/],
    ["séjour", /\btaxe[^.]{0,100}\bsejour/],
    ["affichage", /\btaxe[^.]{0,100}\baffichage/],
    ["chiens", /\btaxe[^.]{0,100}\bchien/],
    ["animaux", /\btaxe[^.]{0,100}\banimal/],
    ["activité économique", /\btaxe[^.]{0,100}\bactivite economique/],
    ["personnel", /\btaxe[^.]{0,100}\bpersonnel/],
  ];

  for (const [label, regex] of fiscalObjects) {
    if (regex.test(t)) {
      result.score += 8;
      result.raisons.push(`OBJET FISCAL TITRE: ${label}`);
    }
  }

  // ----------------------------------------------------------
  // CONTEXTE FISCAL DANS LE DOCUMENT
  // ----------------------------------------------------------

  const fiscalDocumentSignals = [
    [
      "règlement-taxe",
      /\breglement[- ]taxe\b/,
    ],
    [
      "règlement de taxe",
      /\breglement de taxe\b/,
    ],
    [
      "règlement fiscal",
      /\breglement fiscal\b/,
    ],
    [
      "taxe communale",
      /\btaxe communale\b/,
    ],
    [
      "taxes communales",
      /\btaxes communales\b/,
    ],
    [
      "centimes additionnels",
      /\bcentimes additionnels\b/,
    ],
    [
      "précompte immobilier",
      /\bprecompte immobilier\b/,
    ],
    [
      "impôt des personnes physiques",
      /\bimpot des personnes physiques\b/,
    ],
    [
      "impôt personnes physiques",
      /\bimpot personnes physiques\b/,
    ],
    [
      "IPP",
      /\bipp\b/,
    ],
    [
      "force motrice",
      /\bforce motrice\b/,
    ],
    [
      "taux de la taxe",
      /\btaux[^.]{0,80}\btaxe\b/,
    ],
    [
      "taux taxe",
      /\btaux[^.]{0,40}\btaxe\b/,
    ],
    [
      "assiette de la taxe",
      /\bassiette[^.]{0,80}\btaxe\b/,
    ],
    [
      "base imposable",
      /\bbase imposable\b/,
    ],
    [
      "imposition",
      /\bimposition(?:s)?\b/,
    ],
  ];

  for (const [label, regex] of fiscalDocumentSignals) {
    if (regex.test(b)) {
      result.score += 4;
      result.raisons.push(`FISCAL DOCUMENT: ${label}`);
    }
  }

  // ----------------------------------------------------------
  // FORMULATIONS TYPIQUES D'UNE DÉCISION FISCALE
  // ----------------------------------------------------------

  const fiscalActions = [
    /\badoption[^.]{0,100}\btaxe\b/,
    /\bmodification[^.]{0,100}\btaxe\b/,
    /\babrogation[^.]{0,100}\btaxe\b/,
    /\bfixation[^.]{0,100}\btaxe\b/,
    /\betablissement[^.]{0,100}\btaxe\b/,
    /\bactualisation[^.]{0,100}\btaxe\b/,
    /\brenouvellement[^.]{0,100}\btaxe\b/,
  ];

  for (const regex of fiscalActions) {
    if (regex.test(b)) {
      result.score += 5;
      result.raisons.push("ACTION SUR UNE TAXE");
      break;
    }
  }

  // ----------------------------------------------------------
  // TAUX / MONTANT / CENTIMES
  // ----------------------------------------------------------

  const fiscalRateContext =
    /\b(?:taux|montant|quotite|quotite-part|centimes)\b[^.]{0,120}\b(?:taxe|impot|precompte|additionnels)\b/;

  if (fiscalRateContext.test(b)) {
    result.score += 5;
    result.raisons.push("TAUX/MONTANT FISCAL");
  }

  // ----------------------------------------------------------
  // CAS PARTICULIER : "REDEVANCE"
  //
  // Une redevance seule n'est PAS une taxe.
  // ----------------------------------------------------------

  if (/\bredevance\b/.test(t)) {
    result.raisons.push(
      "REDEVANCE : non assimilée automatiquement à une taxe"
    );
  }

  // ----------------------------------------------------------
  // DÉCISION FISCALE
  // ----------------------------------------------------------

  if (!exclusionTrouvee && result.score >= 10) {
    result.fiscal = true;
    result.niveau = "FORT";
  } else if (!exclusionTrouvee && result.score >= 5) {
    result.niveau = "A_VERIFIER";
  }

  // ----------------------------------------------------------
  // EXCLUSION FINALE DES FAUX POSITIFS CONNUS
  // ----------------------------------------------------------

  const fauxPositifs = [
    /\bparking\b/,
    /\bstationnement\b/,
    /\bbail\b/,
    /\bcreashop\b/,
    /\bsubside\b/,
    /\bsubvention\b/,
    /\bfestival\b/,
    /\bcommande\b/,
    /\bmarche public\b/,
  ];

  if (fauxPositifs.some((regex) => regex.test(t))) {
    // Une véritable décision fiscale explicite reste possible,
    // mais uniquement si le titre contient lui-même un signal
    // fiscal extrêmement fort.
    const titreFiscalExplicite = strongTitleSignals.some(
      ([, regex]) => regex.test(t)
    );

    if (!titreFiscalExplicite) {
      result.fiscal = false;
      result.niveau = "NON";
      result.raisons.push(
        "EXCLUSION FINALE : faux positif connu"
      );
    }
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
// CHARGEMENT DU TEXTE EXTRAIT
// ============================================================

async function loadExtractedTexts() {
  try {
    const raw = await fs.readFile(
      EXTRACTION_FILE,
      "utf8"
    );

    const data = JSON.parse(raw);

    const decisions = Array.isArray(data)
      ? data
      : data.decisions || data.items || [];

    const map = new Map();

    for (const item of decisions) {
      if (!item?.url) continue;

      const text = clean(
        [
          item.text,
          item.documentText,
          item.pageText,
        ]
          .filter(Boolean)
          .join("\n")
      );

      map.set(item.url, text);
    }

    console.log(
      `Textes extraits chargés : ${map.size}`
    );

    return map;
  } catch (error) {
    console.log("");
    console.log(
      `⚠️ Impossible de charger ${EXTRACTION_FILE}`
    );
    console.log(
      `Motif : ${error.message}`
    );
    console.log(
      "Le classement sera effectué sur les titres uniquement."
    );
    console.log("");

    return new Map();
  }
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
    "IMPORTANT : ce script ne modifie AUCUN fichier de production."
  );
  console.log("");

  const extractedTexts =
    await loadExtractedTexts();

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(
    NAVIGATION_TIMEOUT
  );

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

    // ========================================================
    // ANALYSE
    // ========================================================

    console.log("");
    console.log("==============================================");
    console.log("       ANALYSE FISCALE");
    console.log("==============================================");
    console.log("");

    const analysed = decisions.map(
      (decision) => {
        const extracted =
          extractedTexts.get(decision.url) || "";

        return {
          ...decision,
          analyse: analyseDecision(
            decision.title,
            extracted
          ),
          texteDisponible: Boolean(extracted),
          longueurTexte: extracted.length,
        };
      }
    );

    const strongFiscal =
      analysed.filter(
        (decision) =>
          decision.analyse.niveau === "FORT"
      );

    const toVerify =
      analysed.filter(
        (decision) =>
          decision.analyse.niveau === "A_VERIFIER"
      );

    console.log(
      `Décisions 2026 : ${analysed.length}`
    );

    console.log(
      `Candidats fiscaux FORTS : ${strongFiscal.length}`
    );

    console.log(
      `Candidats À VÉRIFIER : ${toVerify.length}`
    );

    // ========================================================
    // CANDIDATS FISCAUX FORTS
    // ========================================================

    console.log("");
    console.log("==============================================");
    console.log("       CANDIDATS FISCAUX FORTS");
    console.log("==============================================");

    if (strongFiscal.length === 0) {
      console.log(
        "Aucun candidat fiscal fort détecté."
      );
    } else {
      strongFiscal.forEach(
        (decision, index) => {
          console.log("");
          console.log(
            `${index + 1}. ${decision.title}`
          );
          console.log(
            `   URL : ${decision.url}`
          );
          console.log(
            `   Texte disponible : ${
              decision.texteDisponible
                ? "OUI"
                : "NON"
            }`
          );
          console.log(
            `   Raisons : ${decision.analyse.raisons.join(
              " | "
            )}`
          );
        }
      );
    }

    // ========================================================
    // À VÉRIFIER
    // ========================================================

    console.log("");
    console.log("==============================================");
    console.log("       CANDIDATS À VÉRIFIER");
    console.log("==============================================");

    if (toVerify.length === 0) {
      console.log(
        "Aucun candidat nécessitant une vérification."
      );
    } else {
      toVerify.forEach(
        (decision, index) => {
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
        }
      );
    }

    // ========================================================
    // LISTE DES CANDIDATS AVEC TAXE DANS LE TITRE
    // ========================================================

    const titresAvecTaxe =
      analysed.filter((decision) =>
        /\btaxe(?:s)?\b/i.test(
          normalize(decision.title)
        )
      );

    console.log("");
    console.log("==============================================");
    console.log("       TITRES CONTENANT « TAXE »");
    console.log("==============================================");

    titresAvecTaxe.forEach(
      (decision, index) => {
        console.log("");
        console.log(
          `${index + 1}. ${decision.title}`
        );
        console.log(
          `   Niveau : ${decision.analyse.niveau}`
        );
        console.log(
          `   URL : ${decision.url}`
        );
      }
    );

    // ========================================================
    // RÉSUMÉ
    // ========================================================

    console.log("");
    console.log("==============================================");
    console.log("       RÉSUMÉ FINAL");
    console.log("==============================================");
    console.log("");

    console.log(
      `Pages visitées          : ${visitedPages.size}`
    );

    console.log(
      `Décisions 2026          : ${analysed.length}`
    );

    console.log(
      `Fiscaux forts            : ${strongFiscal.length}`
    );

    console.log(
      `À vérifier               : ${toVerify.length}`
    );

    console.log(
      `Titres avec « taxe »     : ${titresAvecTaxe.length}`
    );

    console.log("");

    console.log(
      "Aucun fichier de production n'a été modifié."
    );

    console.log("");
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
