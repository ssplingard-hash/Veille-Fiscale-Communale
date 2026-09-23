import puppeteer from "puppeteer";
import fs from "fs";

const BASE_URL = "https://www.deliberations.be/liege/decisions";

const OUTPUT = "tmp/liege-2026-analysis.json";

const MAX_OFFSET = 2200;
const STEP = 20;

const MAX_DECISIONS = 2200;

function normalizeUrl(url) {
  if (!url) return null;

  try {
    const u = new URL(url, BASE_URL);

    if (!u.hostname.endsWith("deliberations.be")) return null;

    if (!u.pathname.startsWith("/liege/decisions")) return null;

    u.hash = "";

    return u.toString();
  } catch {
    return null;
  }
}

function isDecisionUrl(url) {
  if (!url) return false;

  try {
    const u = new URL(url);

    const parts = u.pathname.split("/").filter(Boolean);

    if (parts.length < 3) return false;

    if (parts[0] !== "liege") return false;

    if (parts[1] !== "decisions") return false;

    if (u.pathname.includes("@@")) return false;

    return true;
  } catch {
    return false;
  }
}

async function collectPage(page, url) {

  console.log(`\nVISITE : ${url}`);

  try {

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

  } catch (error) {

    console.log(`⚠️ Navigation : ${error.message}`);

  }

  await new Promise(resolve => setTimeout(resolve, 1500));

  return await page.evaluate(() => {

    return [...document.querySelectorAll("a[href]")].map(a => ({

      href: a.href,

      text: (a.innerText || a.textContent || "").trim(),

    }));

  });
}

async function main() {

  fs.mkdirSync("tmp", { recursive: true });

  console.log("==============================================");
  console.log("COLLECTE DES DÉCISIONS LIÈGE");
  console.log("FILTRAGE 2026");
  console.log("==============================================");

  const browser = await puppeteer.launch({

    headless: "new",

    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],

  });

  const page = await browser.newPage();

  await page.setViewport({
    width: 1440,
    height: 1000,
  });

  /*
   * ---------------------------------------------------------
   * ÉTAPE 1
   * ---------------------------------------------------------
   *
   * On récupère les URLs des décisions.
   *
   * On ne suit PAS les liens contenant "seance".
   */

  const decisions = new Map();

  for (
    let offset = 0;
    offset <= MAX_OFFSET;
    offset += STEP
  ) {

    let url;

    if (offset === 0) {

      url = BASE_URL;

    } else {

      url =
        `${BASE_URL}/@@faceted_query` +
        `?b_start:int=${offset}`;

    }

    const links = await collectPage(page, url);

    let newDecisions = 0;

    for (const item of links) {

      const normalized = normalizeUrl(item.href);

      if (!normalized) continue;

      if (!isDecisionUrl(normalized)) continue;

      if (!decisions.has(normalized)) {

        decisions.set(normalized, {

          url: normalized,

          title: item.text || "",

        });

        newDecisions++;

      }

    }

    console.log(
      `Nouvelles décisions : ${newDecisions}`
    );

    console.log(
      `TOTAL URLs : ${decisions.size}`
    );

    /*
     * Le site contient manifestement environ 2 000+
     * décisions accessibles par cette méthode.
     */

    if (decisions.size >= MAX_DECISIONS) {

      console.log(
        "Nombre maximum d'URLs atteint."
      );

      break;

    }

  }

  console.log("\n==============================================");
  console.log("URLS COLLECTÉES");
  console.log("==============================================");

  console.log(
    `TOTAL URLs : ${decisions.size}`
  );

  /*
   * ---------------------------------------------------------
   * ÉTAPE 2
   * ---------------------------------------------------------
   *
   * Maintenant on visite les décisions individuellement.
   *
   * C'est ici qu'on détermine l'année.
   */

  const allDecisions = [...decisions.values()];

  const decisions2026 = [];

  console.log("\n==============================================");
  console.log("ANALYSE DES DATES");
  console.log("==============================================");

  /*
   * On traite les décisions une par une.
   *
   * Pour éviter de laisser Puppeteer tourner inutilement
   * longtemps, on arrête lorsque nous avons quitté 2026
   * dans l'ordre chronologique du site.
   */

  let processed = 0;

  for (const decision of allDecisions) {

    processed++;

    console.log(
      `\n[${processed}/${allDecisions.length}]`
    );

    console.log(decision.url);

    try {

      await page.goto(decision.url, {

        waitUntil: "domcontentloaded",

        timeout: 30000,

      });

      await new Promise(resolve =>
        setTimeout(resolve, 500)
      );

      const data = await page.evaluate(() => {

        const body =
          document.body?.innerText || "";

        const title =
          document.querySelector("h1")?.innerText ||
          document.title ||
          "";

        /*
         * Recherche des dates sous plusieurs formats.
         */

        const dates = [

          ...(body.match(
            /\b\d{1,2}[\/.-]\d{1,2}[\/.-]2026\b/g
          ) || []),

          ...(body.match(
            /\b2026[\/.-]\d{1,2}[\/.-]\d{1,2}\b/g
          ) || []),

          ...(body.match(
            /\b\d{1,2}\s+(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s+2026\b/gi
          ) || []),

        ];

        return {

          title,

          bodyStart: body.substring(0, 5000),

          dates: [...new Set(dates)],

        };

      });

      const has2026 = data.dates.length > 0;

      if (has2026) {

        decisions2026.push({

          url: decision.url,

          title: decision.title,

          pageTitle: data.title,

          dates: data.dates,

        });

        console.log(
          `✅ 2026 : ${data.dates.join(", ")}`
        );

      } else {

        console.log(
          "❌ Aucune date 2026 détectée"
        );

      }

    } catch (error) {

      console.log(
        `⚠️ Erreur : ${error.message}`
      );

    }

  }

  await browser.close();

  console.log("\n==============================================");
  console.log("RESULTAT FINAL");
  console.log("==============================================");

  console.log(
    `URLs analysées : ${allDecisions.length}`
  );

  console.log(
    `Décisions 2026 : ${decisions2026.length}`
  );

  /*
   * SÉCURITÉ
   */

  if (decisions2026.length < 500) {

    throw new Error(
      `Collecte 2026 insuffisante : ${decisions2026.length}`
    );

  }

  /*
   * SAUVEGARDE
   */

  const result = {

    commune: "Liège",

    annee: 2026,

    updatedAt: new Date().toISOString(),

    source: BASE_URL,

    count: decisions2026.length,

    decisions: decisions2026,

  };

  fs.writeFileSync(

    OUTPUT,

    JSON.stringify(
      result,
      null,
      2
    ),

    "utf8"

  );

  console.log(
    `\n✅ Fichier créé : ${OUTPUT}`
  );

  console.log(
    `✅ ${decisions2026.length} décisions 2026`
  );

}

main().catch(error => {

  console.error("\n==============================================");

  console.error("ERREUR");

  console.error("==============================================");

  console.error(error);

  process.exit(1);

});
