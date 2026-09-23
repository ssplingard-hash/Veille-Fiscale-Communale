import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const BASE_URL =
  "https://www.deliberations.be/liege/decisions";

const YEAR = 2026;

const OUTPUT_DIR = path.resolve("tmp");
const OUTPUT_FILE = path.join(
  OUTPUT_DIR,
  "liege-2026-analysis.json"
);

const MIN_EXPECTED_DECISIONS = 500;
const MAX_PAGES = 200;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clean(text = "") {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDecision2026(url) {
  return /\/decisions\/\d{1,2}-[a-zàâäéèêëîïôöùûüÿç]+-2026-\d{1,2}-\d{2}\//i.test(
    url
  );
}

function getTitle(url) {
  try {
    const parts = new URL(url)
      .pathname
      .split("/")
      .filter(Boolean);

    return decodeURIComponent(
      parts[parts.length - 1] || ""
    )
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function getDate(url) {
  const match = url.match(
    /\/decisions\/(\d{1,2})-([a-zàâäéèêëîïôöùûüÿç]+)-2026-\d{1,2}-\d{2}\//i
  );

  if (!match) return null;

  const months = {
    janvier: "01",
    février: "02",
    fevrier: "02",
    mars: "03",
    avril: "04",
    mai: "05",
    juin: "06",
    juillet: "07",
    août: "08",
    aout: "08",
    septembre: "09",
    octobre: "10",
    novembre: "11",
    décembre: "12",
    decembre: "12"
  };

  const month =
    months[
      match[2].toLowerCase()
    ];

  if (!month) return null;

  return `2026-${month}-${String(
    match[1]
  ).padStart(2, "0")}`;
}

async function inspectPage(page, url) {
  console.log("");
  console.log(`VISITE : ${url}`);

  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 120000
  });

  await sleep(1000);

  return await page.evaluate(
    () => {
      const allLinks =
        Array.from(
          document.querySelectorAll("a")
        ).map(a => ({
          href: a.href || "",
          text:
            a.innerText?.trim() || ""
        }));

      const decisions =
        allLinks.filter(
          x =>
            /\/decisions\/\d{1,2}-[a-zàâäéèêëîïôöùûüÿç]+-2026-\d{1,2}-\d{2}\//i.test(
              x.href
            )
        );

      const pagination =
        allLinks.filter(x => {
          return (
            /faceted_query/i.test(
              x.href
            ) ||
            /b_start/i.test(
              x.href
            ) ||
            /page/i.test(
              x.href
            )
          );
        });

      return {
        decisions,
        pagination,
        currentUrl:
          window.location.href,
        title:
          document.title
      };
    }
  );
}

async function collect(browser) {
  const page =
    await browser.newPage();

  const visited =
    new Set();

  const decisions =
    new Map();

  const queue = [
    BASE_URL
  ];

  try {
    while (
      queue.length > 0 &&
      visited.size < MAX_PAGES
    ) {
      const url =
        queue.shift();

      if (
        visited.has(url)
      ) {
        continue;
      }

      visited.add(url);

      let result;

      try {
        result =
          await inspectPage(
            page,
            url
          );
      } catch (error) {
        console.log(
          `ERREUR : ${error.message}`
        );

        continue;
      }

      let added = 0;

      for (
        const decision of
        result.decisions
      ) {
        const cleanUrl =
          decision.href
            .split("#")[0];

        if (
          !decisions.has(
            cleanUrl
          )
        ) {
          decisions.set(
            cleanUrl,
            {
              url: cleanUrl,
              linkText:
                clean(
                  decision.text
                ),
              title:
                getTitle(
                  cleanUrl
                ),
              date:
                getDate(
                  cleanUrl
                )
            }
          );

          added++;
        }
      }

      console.log(
        `Décisions sur cette page : ${result.decisions.length}`
      );

      console.log(
        `Nouvelles décisions : ${added}`
      );

      console.log(
        `TOTAL UNIQUE : ${decisions.size}`
      );

      console.log(
        `PAGINATION TROUVÉE : ${result.pagination.length}`
      );

      for (
        const paginationLink of
        result.pagination
      ) {
        const href =
          paginationLink.href;

        if (
          !href ||
          visited.has(href)
        ) {
          continue;
        }

        /*
         * On ne suit que les vraies
         * pages de pagination.
         */
        if (
          /faceted_query/i.test(
            href
          ) ||
          /b_start/i.test(
            href
          )
        ) {
          queue.push(href);
        }
      }

      /*
       * Affichage des liens de pagination
       * pour comprendre exactement ce que
       * deliberations.be nous donne.
       */
      if (
        result.pagination.length
      ) {
        console.log(
          "LIENS DE PAGINATION :"
        );

        for (
          const p of
          result.pagination
        ) {
          console.log(
            `  ${p.href}`
          );
        }
      }

      await sleep(500);
    }

    console.log("");
    console.log(
      "=============================================="
    );
    console.log(
      `TOTAL FINAL : ${decisions.size}`
    );
    console.log(
      "=============================================="
    );

    if (
      decisions.size <
      MIN_EXPECTED_DECISIONS
    ) {
      throw new Error(
        `Collecte incomplète : seulement ${decisions.size} décisions.`
      );
    }

    return [
      ...decisions.values()
    ];
  } finally {
    await page.close();
  }
}

async function main() {
  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    "TEST COLLECTE LIÈGE 2026"
  );
  console.log(
    "=============================================="
  );

  fs.mkdirSync(
    OUTPUT_DIR,
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
        "--disable-dev-shm-usage"
      ]
    });

  try {
    const decisions =
      await collect(
        browser
      );

    const output = {
      commune: "Liège",
      annee: YEAR,
      generatedAt:
        new Date().toISOString(),
      count:
        decisions.length,
      decisions
    };

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
      `Fichier créé : ${OUTPUT_FILE}`
    );
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error("");
  console.error(
    "=============================================="
  );
  console.error(
    "ERREUR"
  );
  console.error(
    "=============================================="
  );
  console.error(
    error.stack || error
  );

  process.exit(1);
});
