import puppeteer from "puppeteer";
import fs from "fs";

const BASE_URL = "https://www.deliberations.be/liege/decisions";
const OUTPUT = "tmp/liege-2026-analysis.json";

const MIN_EXPECTED = 500;
const MAX_OFFSET = 2000;
const STEP = 20;

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

    // Pas les pages techniques de recherche
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

  await new Promise(resolve => setTimeout(resolve, 2000));

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
  console.log("COLLECTE LIÈGE 2026");
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

  const decisions = new Map();

  /*
   * IMPORTANT :
   * On ne suit PAS les liens de pagination générés
   * par deliberations.be.
   *
   * Ils réinjectent automatiquement :
   * seance=440b6cc1...
   *
   * Ce filtre limite la collecte à 101 décisions.
   *
   * On construit donc nous-mêmes les offsets.
   */

  for (let offset = 0; offset <= MAX_OFFSET; offset += STEP) {

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

    console.log(`Décisions trouvées : ${links.filter(x => isDecisionUrl(normalizeUrl(x.href))).length}`);
    console.log(`Nouvelles décisions : ${newDecisions}`);
    console.log(`TOTAL UNIQUE : ${decisions.size}`);

    /*
     * Si on atteint une page sans aucune nouvelle décision,
     * on teste encore une page supplémentaire avant de conclure.
     *
     * Le site peut parfois renvoyer des doublons.
     */

    if (offset > 0 && newDecisions === 0) {
      console.log(`⚠️ Aucune nouvelle décision à offset ${offset}`);

      // On continue quelques offsets pour vérifier qu'il ne
      // s'agit pas simplement d'une page vide/intermédiaire.
      if (offset >= 400) {
        console.log("Fin probable de la pagination.");
        break;
      }
    }
  }

  await browser.close();

  console.log("\n==============================================");
  console.log("RESULTAT FINAL");
  console.log("==============================================");

  console.log(`TOTAL FINAL : ${decisions.size}`);

  if (decisions.size < MIN_EXPECTED) {
    throw new Error(
      `Collecte incomplète : seulement ${decisions.size} décisions.`
    );
  }

  const result = {
    commune: "Liège",
    annee: 2026,
    updatedAt: new Date().toISOString(),
    source: BASE_URL,
    count: decisions.size,
    decisions: [...decisions.values()],
  };

  fs.writeFileSync(
    OUTPUT,
    JSON.stringify(result, null, 2),
    "utf8"
  );

  console.log(`✅ Fichier créé : ${OUTPUT}`);
  console.log(`✅ ${decisions.size} décisions enregistrées.`);
}

main().catch(error => {
  console.error("\n==============================================");
  console.error("ERREUR");
  console.error("==============================================");
  console.error(error);
  process.exit(1);
});
