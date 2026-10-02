import puppeteer from "puppeteer";

const BASE_URL =
  "https://www.deliberations.be/liege/decisions";

const NAVIGATION_TIMEOUT = 60000;
const WAIT_AFTER_LOAD = 3000;

function clean(text = "") {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function waitForResults(page) {
  await new Promise((resolve) =>
    setTimeout(resolve, WAIT_AFTER_LOAD)
  );
}

async function getResults(page) {
  return await page.evaluate(() => {
    function cleanText(text = "") {
      return text
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    const links = Array.from(
      document.querySelectorAll("a[href]")
    )
      .map((a) => ({
        text: cleanText(
          a.innerText ||
            a.textContent ||
            ""
        ),
        href: a.href || "",
      }))
      .filter((item) => {
        const href = item.href;

        return (
          href.includes(
            "www.deliberations.be/liege/decisions/"
          ) &&
          !href.includes("@@faceted_query") &&
          !href.endsWith("/RSS")
        );
      });

    const unique = [];
    const seen = new Set();

    for (const link of links) {
      if (seen.has(link.href)) {
        continue;
      }

      seen.add(link.href);
      unique.push(link);
    }

    return {
      url: window.location.href,
      title: document.title || "",
      count: unique.length,
      results: unique,
      bodyText: cleanText(
        document.body?.innerText || ""
      ),
    };
  });
}

async function testUrl(page, label, hash) {
  console.log("");
  console.log(
    "=================================================="
  );
  console.log(label);
  console.log(
    "=================================================="
  );
  console.log("");

  const url =
    `${BASE_URL}${hash}`;

  console.log(
    `URL testée : ${url}`
  );

  console.log("");

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT,
  });

  await waitForResults(page);

  const result =
    await getResults(page);

  console.log(
    `URL finale : ${result.url}`
  );

  console.log("");

  console.log(
    `Nombre de décisions détectées : ${result.count}`
  );

  console.log("");

  if (result.count === 0) {
    console.log(
      "Aucune décision détectée."
    );
  } else {
    console.log(
      "Premiers résultats :"
    );

    result.results
      .slice(0, 30)
      .forEach((item, index) => {
        console.log("");
        console.log(
          `${index + 1}. ${item.text || "(sans titre)"}`
        );
        console.log(
          `   ${item.href}`
        );
      });
  }

  console.log("");

  return result;
}

async function main() {
  console.log("");
  console.log(
    "=================================================="
  );
  console.log(
    " DIAGNOSTIC RECHERCHE TAXE — TEST DES URL"
  );
  console.log(
    "=================================================="
  );
  console.log("");

  console.log(
    "Objectif : déterminer si deliberations.be permet"
  );

  console.log(
    "de rechercher directement taxe + année sans"
  );

  console.log(
    "rester limité à une séance."
  );

  console.log("");

  const browser =
    await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

  const page =
    await browser.newPage();

  page.setDefaultNavigationTimeout(
    NAVIGATION_TIMEOUT
  );

  try {
    /*
     * TEST 1
     *
     * Recherche taxe avec la séance actuelle.
     * Sert uniquement de référence.
     */

    await testUrl(
      page,
      "TEST 1 — TAXE + SÉANCE ACTUELLE",
      "#seance=440b6cc1e68a4183b17e640e5eb7a8b8&b_start=0&text=taxe"
    );

    /*
     * TEST 2
     *
     * Recherche taxe sans aucune séance.
     */

    await testUrl(
      page,
      "TEST 2 — TAXE SANS SÉANCE",
      "#b_start=0&text=taxe"
    );

    /*
     * TEST 3
     *
     * Recherche taxe + année 2026,
     * sans séance.
     */

    await testUrl(
      page,
      "TEST 3 — TAXE + 2026 SANS SÉANCE",
      "#b_start=0&text=taxe&annee=2026"
    );

    /*
     * TEST 4
     *
     * Même recherche sans b_start.
     */

    await testUrl(
      page,
      "TEST 4 — TAXE + 2026 SANS SÉANCE NI B_START",
      "#text=taxe&annee=2026"
    );

    /*
     * TEST 5
     *
     * Année + taxe dans l'ordre inverse.
     */

    await testUrl(
      page,
      "TEST 5 — 2026 + TAXE SANS SÉANCE",
      "#annee=2026&text=taxe"
    );

    console.log("");
    console.log(
      "=================================================="
    );
    console.log(
      "FIN DU DIAGNOSTIC"
    );
    console.log(
      "=================================================="
    );
    console.log("");

    console.log(
      "Aucune donnée de production n'a été modifiée."
    );
  } finally {
    await page.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error("");
  console.error(
    "=================================================="
  );
  console.error(
    "ERREUR FATALE"
  );
  console.error(
    "=================================================="
  );
  console.error("");

  console.error(error);

  process.exit(1);
});
