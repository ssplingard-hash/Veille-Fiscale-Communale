import puppeteer from "puppeteer";
import fs from "fs";

const BASE_URL = "https://www.deliberations.be/liege/decisions";
const OUTPUT = "tmp/liege-2026-analysis.json";

const MAX_OFFSET = 2200;
const STEP = 20;

const MONTHS = {
  janvier: 1,
  fevrier: 2,
  février: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  août: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
  décembre: 12,
};

function normalizeUrl(url) {
  if (!url) return null;

  try {
    const u = new URL(url, BASE_URL);

    if (!u.hostname.endsWith("deliberations.be")) {
      return null;
    }

    if (!u.pathname.startsWith("/liege/decisions")) {
      return null;
    }

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

/*
 * Les URLs de deliberations.be commencent par exemple par :
 *
 * /liege/decisions/29-juin-2026-18-00/...
 *
 * On extrait donc l'année de la date de séance
 * directement depuis l'URL.
 */
function getYearFromUrl(url) {
  try {
    const u = new URL(url);

    const parts = u.pathname.split("/").filter(Boolean);

    if (parts.length < 3) return null;

    const datePart = parts[2];

    const match = datePart.match(
      /^(\d{1,2})-([a-zàâçéèêëîïôûùüÿ]+)-(\d{4})/
    );

    if (!match) return null;

    const day = Number(match[1]);
    const monthName = match[2].toLowerCase();
    const year = Number(match[3]);

    const month = MONTHS[monthName];

    if (!month) return null;

    return {
      day,
      month,
      year,
      raw: datePart,
    };
  } catch {
    return null;
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

  await new Promise(resolve => setTimeout(resolve, 1200));

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
  console.log("COLLECTE LIÈGE");
  console.log("FILTRAGE 2026 PAR DATE DE SÉANCE");
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

  const allDecisions = new Map();

  /*
   * ---------------------------------------------------------
   * ÉTAPE 1
   * COLLECTE DE TOUTES LES URLs
   * ---------------------------------------------------------
   */

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

      if (!allDecisions.has(normalized)) {

        const dateInfo = getYearFromUrl(normalized);

        allDecisions.set(normalized, {

          url: normalized,

          title: item.text || "",

          date: dateInfo,

        });

        newDecisions++;

      }

    }

    console.log(
      `Nouvelles décisions : ${newDecisions}`
    );

    console.log(
      `TOTAL UNIQUE : ${allDecisions.size}`
    );

    /*
     * Si nous arrivons à une page vide,
     * inutile de continuer.
     */

    if (newDecisions === 0 && offset > 100) {

      console.log(
        `⚠️ Aucune nouvelle décision à offset ${offset}.`
      );

      console.log(
        "Fin de la collecte."
      );

      break;
    }
  }

  /*
   * ---------------------------------------------------------
   * ÉTAPE 2
   * FILTRE STRICT SUR L'ANNÉE DE L'URL
   * ---------------------------------------------------------
   */

  const decisions2026 = [];

  let noDate = 0;

  for (const decision of allDecisions.values()) {

    if (!decision.date) {

      noDate++;

      continue;
    }

    if (decision.date.year === 2026) {

      decisions2026.push(decision);

    }

  }

  console.log("\n==============================================");
  console.log("RÉSULTAT DU FILTRE");
  console.log("==============================================");

  console.log(
    `Toutes les décisions : ${allDecisions.size}`
  );

  console.log(
    `Décisions avec date URL : ${
      allDecisions.size - noDate
    }`
  );

  console.log(
    `URLs sans date exploitable : ${noDate}`
  );

  console.log(
    `DÉCISIONS 2026 : ${decisions2026.length}`
  );

  /*
   * ---------------------------------------------------------
   * STATISTIQUES PAR ANNÉE
   * ---------------------------------------------------------
   */

  const years = {};

  for (const decision of allDecisions.values()) {

    if (!decision.date) continue;

    const year = decision.date.year;

    years[year] = (years[year] || 0) + 1;
  }

  console.log("\nRépartition par année :");

  Object.keys(years)
    .sort()
    .forEach(year => {

      console.log(
        `  ${year} : ${years[year]}`
      );

    });

  /*
   * ---------------------------------------------------------
   * SÉCURITÉ
   * ---------------------------------------------------------
   */

  if (decisions2026.length < 500) {

    await browser.close();

    throw new Error(
      `Collecte 2026 insuffisante : ${decisions2026.length}`
    );

  }

  /*
   * ---------------------------------------------------------
   * SAUVEGARDE
   * ---------------------------------------------------------
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

  await browser.close();

  console.log("\n==============================================");
  console.log("COLLECTE TERMINÉE");
  console.log("==============================================");

  console.log(
    `✅ ${decisions2026.length} décisions 2026`
  );

  console.log(
    `✅ Fichier : ${OUTPUT}`
  );

}

main().catch(error => {

  console.error("\n==============================================");
  console.error("ERREUR");
  console.error("==============================================");

  console.error(error);

  process.exit(1);

});
