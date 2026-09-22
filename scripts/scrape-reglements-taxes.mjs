import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer";

const YEAR = 2026;
const BASE_URL = "https://www.deliberations.be/liege/decisions";
const OUTPUT_FILE = path.resolve(
  "src/data/reglements-taxes.json"
);

const CONCURRENCY = 3;
const MAX_RETRIES = 3;

const MIN_EXPECTED_DECISIONS = 500;

/*
 * IMPORTANT
 * ----------
 * Le classificateur ne considère PLUS les mots génériques présents
 * dans le texte de la page comme une preuve de fiscalité.
 *
 * La fiscalité doit être identifiable dans le TITRE de la décision
 * ou dans une combinaison très stricte de titre + matière.
 *
 * Objectif :
 * - éviter les faux positifs ;
 * - conserver les vrais règlements/taxes ;
 * - ne jamais considérer simplement "redevance communale" comme fiscal.
 */

// ---------------------------------------------------------------------------
// OUTILS
// ---------------------------------------------------------------------------

function normalize(text = "") {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanText(text = "") {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDecision2026(url) {
  return (
    typeof url === "string" &&
    /\/decisions\/\d{1,2}-[a-z]+-2026-\d{1,2}-\d{2}\//i.test(url)
  );
}

function isFiscalTitle(title) {
  const t = normalize(title);

  /*
   * -----------------------------------------------------------------------
   * EXCLUSIONS ABSOLUES
   * -----------------------------------------------------------------------
   *
   * Ces termes peuvent contenir des mots comme "taxe", "redevance",
   * "règlement", etc., mais ne constituent pas en eux-mêmes une décision
   * fiscale.
   */

  const absoluteExclusions = [
    // marchés publics / achats
    /\bmarche(?:s)? public/,
    /\bbon(?:s)? de commande/,
    /\bcommande(?:s)? publique/,
    /\bdelegation de competence/,
    /\bfonctionnaire(?:s)? delegue/,

    // contrats / conventions
    /\bcontrat(?:s)?\b/,
    /\bconvention(?:s)?\b/,
    /\bprotocole(?:s)?\b/,
    /\baccord(?:s)?\b/,

    // subsides / subventions
    /\bsubside(?:s)?\b/,
    /\bsubvention(?:s)?\b/,
    /\baide(?:s)? financiere(?:s)?\b/,
    /\bsoutien financier/,

    // personnel
    /\brecrutement/,
    /\bengagement/,
    /\bnomination/,
    /\bfonctionnaire/,
    /\bagent(?:s)?\b/,

    // police / sécurité
    /\breglement de police\b/,
    /\bpolice administrative/,
    /\bpetites incivilites/,
    /\bproprete publique/,
    /\bsecurite/,

    // patrimoine / occupation du domaine public
    /\boccupation de la voie publique\b/,
    /\boccupation du domaine public\b/,
    /\bgestion patrimoniale\b/,
    /\bpatrimonial/,

    // événements
    /\bfetes? du\b/,
    /\bfestival/,
    /\bevenement/,
    /\bmanifestation/,

    // parking / stationnement
    /\bstationnement/,
    /\bparking/,
    /\bzone payante/,
    /\bzone bleue/,

    // ambulants / marchés
    /\bactivites ambulantes/,
    /\bcommerce ambulant/,
    /\bmarche ambulant/,
    /\boccupation.*ambulant/,

    // baux / locations / concessions
    /\bbail\b/,
    /\blocation/,
    /\bconcession/,
    /\bmise a disposition/,

    // urbanisme
    /\bpermis d'urbanisme/,
    /\bpermis unique/,
    /\burbanisme/,

    // données / informatique / RGPD
    /\bdonnees a caractere personnel/,
    /\bbanque carrefour/,
    /\brgpd\b/,
    /\bprotection des donnees/,
  ];

  if (absoluteExclusions.some((pattern) => pattern.test(t))) {
    return false;
  }

  /*
   * -----------------------------------------------------------------------
   * OBJETS FISCAUX EXPLICITES
   * -----------------------------------------------------------------------
   *
   * Ici, nous recherchons des objets qui correspondent réellement à de la
   * fiscalité communale.
   */

  const explicitFiscalObjects = [
    // terme générique très fort lorsqu'il est dans le titre
    /\breglement[- ]taxe\b/,
    /\breglement[- ]taxes\b/,
    /\breglement taxe\b/,
    /\breglement taxes\b/,

    // taxes
    /\btaxe communale\b/,
    /\btaxes communales\b/,
    /\btaxe directe\b/,
    /\btaxe indirecte\b/,
    /\btaxe sur\b/,
    /\btaxe relative a\b/,
    /\btaxe applicable\b/,

    // redevances : seulement lorsqu'un objet précis est identifié
    /\bredevance.*(?:occupation|concession|enlevement|depot|collecte|distribution|eau|egout|assainissement|permis|autorisation|document|copie)/,
    /\bredevance.*(?:service|prestation)/,

    // centimes additionnels
    /\bcentimes additionnels\b/,
    /\bcentimes additionnels au precompte immobilier\b/,
    /\bcentimes additionnels a l'impot\b/,
    /\badditionnels au precompte immobilier\b/,

    // IPP
    /\bimpot des personnes physiques\b/,
    /\bipp\b/,
    /\badditionnels.*ipp\b/,

    // précompte immobilier
    /\bprecompte immobilier\b/,
    /\bprecompte immobilier\b.*\bcentimes\b/,

    // force motrice
    /\bforce motrice\b/,

    // taxe sur les immeubles / propriétés
    /\btaxe.*immeuble/,
    /\btaxe.*propriete/,
    /\btaxe.*proprietes/,
    /\btaxe.*terrain/,
    /\btaxe.*terrains/,

    // véhicules
    /\btaxe.*vehicule/,
    /\btaxe.*vehicules/,
    /\btaxe.*voiture/,
    /\btaxe.*voitures/,

    // enseignes / publicité
    /\btaxe.*enseigne/,
    /\btaxe.*enseignes/,
    /\btaxe.*publicite/,
    /\btaxe.*publicitaire/,

    // commerces / surfaces
    /\btaxe.*commerce/,
    /\btaxe.*commerces/,
    /\btaxe.*surface commerciale/,
    /\btaxe.*surfaces commerciales/,

    // déchets
    /\btaxe.*dechet/,
    /\btaxe.*dechets/,
    /\btaxe.*ordure/,
    /\btaxe.*ordures/,
    /\bredevance.*dechet/,
    /\bredevance.*dechets/,
    /\bredevance.*ordure/,
    /\bredevance.*ordures/,

    // secondes résidences
    /\btaxe.*seconde residence/,
    /\btaxe.*secondes residences/,
    /\btaxe.*residence secondaire/,
    /\btaxe.*residences secondaires/,

    // terrasses
    /\btaxe.*terrasse/,
    /\btaxe.*terrasses/,

    // débits de boissons
    /\btaxe.*debit de boissons/,
    /\btaxe.*debits de boissons/,

    // hôtels / hébergements
    /\btaxe.*hotel/,
    /\btaxe.*hotels/,
    /\btaxe.*hebergement/,
    /\btaxe.*hebergements/,
    /\btaxe.*sejour/,

    // affichage / publicité
    /\btaxe.*affichage/,
    /\btaxe.*affiches/,

    // chiens / animaux
    /\btaxe.*chien/,
    /\btaxe.*chiens/,
    /\btaxe.*animal/,
    /\btaxe.*animaux/,

    // personnel / activité économique
    /\btaxe.*personnel/,
    /\btaxe.*activite economique/,
    /\btaxe.*activites economiques/,
  ];

  if (explicitFiscalObjects.some((pattern) => pattern.test(t))) {
    return true;
  }

  /*
   * -----------------------------------------------------------------------
   * CAS PARTICULIER : "TAXE" / "REDEVANCE"
   * -----------------------------------------------------------------------
   *
   * Un titre contenant simplement "taxe" n'est pas automatiquement accepté.
   *
   * On accepte "taxe" lorsqu'elle est manifestement le sujet de la décision,
   * notamment lorsqu'il s'agit :
   *
   * - d'adopter un règlement-taxe ;
   * - de modifier un règlement-taxe ;
   * - de fixer le taux ;
   * - de fixer le montant ;
   * - d'arrêter les modalités ;
   * - de renouveler une taxe.
   */

  const fiscalAction = /\b(?:adoption|adopter|modification|modifier|abrogation|abroger|renouvellement|renouveler|fixation|fixer|etablissement|etablir|actualisation|actualiser)\b/;

  const taxWord = /\b(?:taxe|taxes|imposition|impositions)\b/;

  const taxRegulation = /\b(?:reglement|reglements)\b.*\b(?:taxe|taxes)\b/;

  if (fiscalAction.test(t) && taxRegulation.test(t)) {
    return true;
  }

  /*
   * "redevance" seule n'est JAMAIS suffisante.
   *
   * Il faut un objet fiscal clairement identifiable.
   */
  if (/\bredevance\b/.test(t)) {
    const preciseObject = [
      /\bredevance.*eau/,
      /\bredevance.*egout/,
      /\bredevance.*assainissement/,
      /\bredevance.*dechet/,
      /\bredevance.*dechets/,
      /\bredevance.*ordure/,
      /\bredevance.*ordures/,
      /\bredevance.*document/,
      /\bredevance.*copie/,
      /\bredevance.*service/,
      /\bredevance.*prestation/,
      /\bredevance.*occupation.*(?:domaine|voie)/,
      /\bredevance.*occupation.*(?:sol|terrain)/,
    ];

    if (preciseObject.some((pattern) => pattern.test(t))) {
      return true;
    }
  }

  /*
   * Par défaut : NON FISCAL.
   */
  return false;
}

// ---------------------------------------------------------------------------
// EXTRACTION DES DÉCISIONS
// ---------------------------------------------------------------------------

async function extractDecisionLinks(page) {
  return await page.evaluate(() => {
    const links = [];

    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.href;
      const text = (a.innerText || a.textContent || "").trim();

      if (!href) return;

      if (
        /\/liege\/decisions\/\d{1,2}-[a-z]+-2026-\d{1,2}-\d{2}\//i.test(
          href
        )
      ) {
        links.push({
          url: href,
          title: text,
        });
      }
    });

    return links;
  });
}

async function getPageLinks(browser, url) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let page;

    try {
      page = await browser.newPage();

      await page.setDefaultNavigationTimeout(60000);

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const links = await extractDecisionLinks(page);

      await page.close();

      return links;
    } catch (error) {
      console.log(
        `   ⚠️ Erreur récupération page (tentative ${attempt}/${MAX_RETRIES}) : ${error.message}`
      );

      try {
        if (page) await page.close();
      } catch {}

      if (attempt < MAX_RETRIES) {
        await sleep(1500 * attempt);
      }
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// EXTRACTION DU CONTENU D'UNE DÉCISION
// ---------------------------------------------------------------------------

async function getDecisionDetails(browser, decision) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let page;

    try {
      page = await browser.newPage();

      await page.setDefaultNavigationTimeout(60000);

      await page.goto(decision.url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      const data = await page.evaluate(() => {
        const body = document.body;

        return {
          bodyText: body
            ? body.innerText || body.textContent || ""
            : "",
          html: body ? body.innerHTML : "",
        };
      });

      await page.close();

      const $ = cheerio.load(data.html);

      const links = [];

      $("a[href]").each((_, element) => {
        const href = $(element).attr("href");
        const text = cleanText($(element).text());

        if (!href) return;

        links.push({
          url: href,
          text,
        });
      });

      return {
        ...decision,
        bodyText: cleanText(data.bodyText),
        documentLinks: links,
      };
    } catch (error) {
      console.log(
        `   ⚠️ Erreur décision (tentative ${attempt}/${MAX_RETRIES}) : ${error.message}`
      );

      try {
        if (page) await page.close();
      } catch {}

      if (attempt < MAX_RETRIES) {
        await sleep(1000 * attempt);
      }
    }
  }

  return {
    ...decision,
    bodyText: "",
    documentLinks: [],
  };
}

// ---------------------------------------------------------------------------
// RÉCUPÉRATION DES 858 DÉCISIONS
// ---------------------------------------------------------------------------

async function collectAllDecisions(browser) {
  const decisions = new Map();

  let offset = 0;
  let emptyPages = 0;

  while (true) {
    const url =
      offset === 0
        ? BASE_URL
        : `${BASE_URL}/@@faceted_query?b_start:int=${offset}`;

    console.log("");
    console.log(`→ ${url}`);

    const links = await getPageLinks(browser, url);

    const yearLinks = links.filter((x) => isDecision2026(x.url));

    console.log(`   ${yearLinks.length} décisions 2026`);

    let newCount = 0;

    for (const item of yearLinks) {
      if (!decisions.has(item.url)) {
        decisions.set(item.url, item);
        newCount++;
      }
    }

    console.log(
      `   ${newCount} nouvelles → total ${decisions.size}`
    );

    if (yearLinks.length === 0) {
      emptyPages++;

      if (emptyPages >= 2) {
        break;
      }
    } else {
      emptyPages = 0;
    }

    offset += 20;

    // Sécurité
    if (offset > 3000) {
      console.log("⚠️ Arrêt de sécurité pagination.");
      break;
    }
  }

  return Array.from(decisions.values());
}

// ---------------------------------------------------------------------------
// CLASSIFICATION
// ---------------------------------------------------------------------------

function classifyDecision(decision) {
  const title = cleanText(decision.title || "");

  const fiscal = isFiscalTitle(title);

  if (!fiscal) {
    return {
      ...decision,
      fiscal: false,
      confidence: "NON_FISCAL",
    };
  }

  return {
    ...decision,
    fiscal: true,
    confidence: "FISCAL",
  };
}

// ---------------------------------------------------------------------------
// FORMAT JSON
// ---------------------------------------------------------------------------

function buildOutput(fiscalDecisions) {
  return {
    liege: {
      commune: "Liège",
      annee: YEAR,
      source: BASE_URL,
      updatedAt: new Date().toISOString(),

      reglements: fiscalDecisions.map((decision) => ({
        date: extractDate(decision.url),
        titre: decision.title,
        url: decision.url,
        type: "fiscal",
      })),
    },
  };
}

function extractDate(url) {
  const match = url.match(
    /\/decisions\/(\d{1,2})-([a-z]+)-(\d{4})-/i
  );

  if (!match) return "";

  const [, day, monthName, year] = match;

  const months = {
    janvier: "01",
    fevrier: "02",
    mars: "03",
    avril: "04",
    mai: "05",
    juin: "06",
    juillet: "07",
    aout: "08",
    septembre: "09",
    octobre: "10",
    novembre: "11",
    decembre: "12",
  };

  const month =
    months[normalize(monthName)] || "01";

  return `${year}-${month}-${day.padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

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
      "--disable-dev-shm-usage",
    ],
  });

  try {
    console.log("1. RÉCUPÉRATION DES DÉCISIONS 2026");
    console.log("-----------------------------------------------");

    const decisions = await collectAllDecisions(browser);

    console.log("");
    console.log("===============================================");
    console.log("COLLECTE TERMINÉE");
    console.log("===============================================");
    console.log(`Décisions 2026 récupérées : ${decisions.length}`);

    if (decisions.length < MIN_EXPECTED_DECISIONS) {
      throw new Error(
        `Sécurité : seulement ${decisions.length} décisions récupérées. Minimum attendu : ${MIN_EXPECTED_DECISIONS}.`
      );
    }

    console.log("");
    console.log("2. CLASSIFICATION FISCALE");
    console.log("-----------------------------------------------");

    const classified = decisions.map(classifyDecision);

    const fiscalDecisions = classified.filter(
      (decision) => decision.fiscal
    );

    console.log("");
    console.log("===============================================");
    console.log("RÉSULTATS");
    console.log("===============================================");
    console.log(
      `Décisions 2026 récupérées : ${decisions.length}`
    );
    console.log(
      `Décisions fiscales retenues : ${fiscalDecisions.length}`
    );

    console.log("");

    if (fiscalDecisions.length === 0) {
      console.log(
        "⚠️ Aucune décision fiscale détectée."
      );
      console.log(
        "⚠️ LE JSON EXISTANT N'EST PAS MODIFIÉ."
      );

      return;
    }

    console.log("DÉCISIONS FISCALES RETENUES :");
    console.log("");

    fiscalDecisions.forEach((decision, index) => {
      console.log(
        `${index + 1}. ${decision.title}`
      );
      console.log(`   URL : ${decision.url}`);
      console.log("");
    });

    /*
     * Écriture uniquement après validation des sécurités.
     */

    const output = buildOutput(fiscalDecisions);

    fs.mkdirSync(path.dirname(OUTPUT_FILE), {
      recursive: true,
    });

    fs.writeFileSync(
      OUTPUT_FILE,
      JSON.stringify(output, null, 2),
      "utf8"
    );

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

main().catch((error) => {
  console.error("");
  console.error("===============================================");
  console.error("ERREUR FATALE");
  console.error("===============================================");
  console.error(error);
  process.exit(1);
});
