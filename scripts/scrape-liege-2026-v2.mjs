import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const OUTPUT = "tmp/liege-2026-analysis.json";

const BASE_URL =
  "https://www.deliberations.be/liege/decisions";

const TIMEOUT = 90000;
const OFFSET_STEP = 20;
const MAX_OFFSET = 4000;
const MAX_EMPTY_PAGES = 3;

const MONTHS = {
  janvier: 1,
  février: 2,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  août: 8,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  décembre: 12,
  decembre: 12
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeUrl(url) {
  if (!url) return null;

  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

function parseDecisionDate(url) {
  if (!url) return null;

  try {
    const u = new URL(url);

    const parts = u.pathname
      .split("/")
      .filter(Boolean);

    const index = parts.indexOf("decisions");

    if (index === -1) {
      return null;
    }

    const datePart = parts[index + 1];

    if (!datePart) {
      return null;
    }

    const match = datePart.match(
      /^(\d{1,2})-([a-zàâäçéèêëîïôöùûüÿœæ]+)-(\d{4})(?:-(\d{1,2})-(\d{2}))?$/i
    );

    if (!match) {
      return null;
    }

    const day = Number(match[1]);
    const monthName = match[2].toLowerCase();
    const year = Number(match[3]);

    const hour =
      match[4] !== undefined
        ? Number(match[4])
        : null;

    const minute =
      match[5] !== undefined
        ? Number(match[5])
        : null;

    const month = MONTHS[monthName];

    if (!month) {
      return null;
    }

    return {
      day,
      month,
      year,
      hour,
      minute,
      raw: `${day}-${monthName}-${year}${
        hour !== null
          ? `-${String(hour).padStart(2, "0")}-${String(minute).padStart(2, "0")}`
          : ""
      }`
    };
  } catch {
    return null;
  }
}

function isDecisionUrl(url) {
  if (!url) return false;

  try {
    const u = new URL(url);

    if (u.hostname !== "www.deliberations.be") {
      return false;
    }

    const parts = u.pathname
      .split("/")
      .filter(Boolean);

    if (parts[0] !== "liege") {
      return false;
    }

    if (parts[1] !== "decisions") {
      return false;
    }

    if (parts.length < 4) {
      return false;
    }

    const date = parseDecisionDate(url);

    return Boolean(date);
  } catch {
    return false;
  }
}

async function getPageLinks(page, url) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT
    });
  } catch (error) {
    console.log(
      `⚠️ Navigation ${url} : ${error.message}`
    );
  }

  // deliberations.be charge une partie du contenu en JS.
  await sleep(2000);

  return await page.evaluate(() => {
    return [...document.querySelectorAll("a[href]")]
      .map(a => ({
        href: a.href,
        text: (
          a.innerText ||
          a.textContent ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
      }))
      .filter(x => x.href);
  });
}

function decisionFromLink(link) {
  const url = normalizeUrl(link.href);

  if (!url) {
    return null;
  }

  if (!isDecisionUrl(url)) {
    return null;
  }

  const date = parseDecisionDate(url);

  if (!date) {
    return null;
  }

  return {
    url,
    title: link.text || "",
    date
  };
}

async function collectPage(page, offset) {
  const url =
    offset === 0
      ? BASE_URL
      : `${BASE_URL}#b_start=${offset}`;

  console.log("");
  console.log(`--- Offset ${offset} ---`);
  console.log(url);

  const links =
    await getPageLinks(page, url);

  const decisions = new Map();

  for (const link of links) {
    const decision =
      decisionFromLink(link);

    if (decision) {
      decisions.set(
        decision.url,
        decision
      );
    }
  }

  const result =
    [...decisions.values()];

  console.log(
    `Décisions trouvées : ${result.length}`
  );

  return result;
}

async function main() {
  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    " LIÈGE 2026 - COLLECTE DES DÉCISIONS"
  );
  console.log(
    "=============================================="
  );

  fs.mkdirSync(
    path.dirname(OUTPUT),
    {
      recursive: true
    }
  );

  const browser =
    await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

  const page =
    await browser.newPage();

  await page.setDefaultNavigationTimeout(
    TIMEOUT
  );

  const all =
    new Map();

  let emptyPages = 0;

  try {
    for (
      let offset = 0;
      offset <= MAX_OFFSET;
      offset += OFFSET_STEP
    ) {
      const decisions =
        await collectPage(
          page,
          offset
        );

      let newCount = 0;

      for (const decision of decisions) {
        if (!all.has(decision.url)) {
          all.set(
            decision.url,
            decision
          );

          newCount++;
        }
      }

      console.log(
        `Nouvelles décisions : ${newCount}`
      );

      if (newCount === 0) {
        emptyPages++;
      } else {
        emptyPages = 0;
      }

      if (
        emptyPages >= MAX_EMPTY_PAGES
      ) {
        console.log(
          "Fin de pagination détectée."
        );
        break;
      }
    }
  } finally {
    await browser.close();
  }

  const allDecisions =
    [...all.values()];

  const decisions2026 =
    allDecisions.filter(
      d =>
        d.date &&
        d.date.year === 2026
    );

  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    " RÉSULTAT COLLECTE"
  );
  console.log(
    "=============================================="
  );

  console.log(
    `Décisions uniques : ${allDecisions.length}`
  );

  console.log(
    `Décisions 2026 : ${decisions2026.length}`
  );

  const years = {};

  for (const decision of allDecisions) {
    const year =
      decision.date?.year;

    if (year) {
      years[year] =
        (years[year] || 0) + 1;
    }
  }

  console.log("");
  console.log(
    "Répartition par année :"
  );

  for (
    const year of Object.keys(years).sort()
  ) {
    console.log(
      `  ${year} : ${years[year]}`
    );
  }

  /*
   * Sécurité :
   * nous avons déjà validé qu'une collecte
   * normale donne largement plus de 500 décisions
   * pour Liège en 2026.
   */
  if (decisions2026.length < 500) {
    throw new Error(
      `Sécurité : seulement ${decisions2026.length} décisions 2026 collectées. Aucun fichier de production n'est modifié.`
    );
  }

  /*
   * Vérification finale.
   */
  for (const decision of decisions2026) {
    if (
      !decision.date ||
      decision.date.year !== 2026
    ) {
      throw new Error(
        `Décision non-2026 détectée : ${decision.url}`
      );
    }
  }

  const output = {
    commune: "Liège",
    annee: 2026,
    updatedAt:
      new Date().toISOString(),
    source: BASE_URL,
    count:
      decisions2026.length,
    decisions:
      decisions2026
  };

  fs.writeFileSync(
    OUTPUT,
    JSON.stringify(
      output,
      null,
      2
    ),
    "utf8"
  );

  console.log("");
  console.log(
    `✓ Fichier créé : ${OUTPUT}`
  );

  console.log(
    `✓ ${decisions2026.length} décisions 2026 enregistrées`
  );

  console.log(
    "✓ Données de production inchangées"
  );
}

main().catch(error => {
  console.error("");
  console.error(
    "❌ ERREUR FATALE"
  );
  console.error(error);
  process.exit(1);
});
