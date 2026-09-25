import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const BASE_URL =
  "https://www.deliberations.be/liege/decisions";

const OUTPUT =
  "tmp/liege-2026-analysis.json";

const YEAR = 2026;

const MAX_PAGES = 150;

const NAVIGATION_TIMEOUT = 90000;

const WAIT_AFTER_LOAD = 1200;

// ============================================================
// OUTILS
// ============================================================

function clean(text = "") {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(url, baseUrl = BASE_URL) {
  if (!url) {
    return null;
  }

  try {
    const absolute =
      new URL(url, baseUrl);

    absolute.hash = "";

    return absolute.href;
  } catch {
    return null;
  }
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
// IDENTIFICATION D'UNE DÉCISION LIÈGE
// ============================================================

function isDecisionUrl(url) {
  return (
    typeof url === "string" &&
    /\/liege\/decisions\/\d{1,2}-[a-zà-ÿ]+-\d{4}-\d{1,2}-\d{2}\//i.test(
      url
    )
  );
}

// ============================================================
// EXTRACTION D'UNE PAGE
// ============================================================

async function extractPage(page, url) {
  console.log("");
  console.log(
    "=============================================="
  );
  console.log("PAGE");
  console.log(
    "=============================================="
  );
  console.log(url);

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT
    });
  } catch (error) {
    console.log(
      `⚠️ Navigation : ${error.message}`
    );
  }

  /*
   * Le site construit une partie de son contenu
   * côté navigateur.
   */
  await new Promise(resolve =>
    setTimeout(
      resolve,
      WAIT_AFTER_LOAD
    )
  );

  return await page.evaluate(() => {
    const decisions = [];

    const pagination = [];

    /*
     * ----------------------------------------------------------
     * DÉCISIONS
     * ----------------------------------------------------------
     */

    document
      .querySelectorAll("a[href]")
      .forEach(a => {
        const href =
          a.href ||
          a.getAttribute("href");

        const text = (
          a.innerText ||
          a.textContent ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();

        if (!href) {
          return;
        }

        /*
         * On récupère toutes les décisions.
         * Le filtrage 2026 est fait ensuite à partir
         * de l'année présente dans l'URL.
         */
        if (
          /\/liege\/decisions\/\d{1,2}-[a-zà-ÿ]+-\d{4}-\d{1,2}-\d{2}\//i.test(
            href
          )
        ) {
          decisions.push({
            url: href,
            title: text
          });
        }
      });

    /*
     * ----------------------------------------------------------
     * PAGINATION
     * ----------------------------------------------------------
     *
     * IMPORTANT :
     *
     * Nous NE fabriquons PAS les URLs.
     *
     * Nous récupérons les liens réellement fournis
     * par deliberations.be.
     *
     * Le site utilise notamment :
     *
     * @@faceted_query
     *
     * avec :
     *
     * b_start
     *
     */

    document
      .querySelectorAll("a[href]")
      .forEach(a => {
        const href =
          a.href ||
          a.getAttribute("href");

        if (!href) {
          return;
        }

        if (
          href.includes(
            "@@faceted_query"
          ) &&
          href.includes(
            "b_start"
          )
        ) {
          pagination.push(href);
        }
      });

    /*
     * On récupère également les liens contenant
     * b_start qui pourraient utiliser une variante
     * de l'URL.
     */
    document
      .querySelectorAll("a[href]")
      .forEach(a => {
        const href =
          a.href ||
          a.getAttribute("href");

        if (!href) {
          return;
        }

        if (
          href.includes("b_start") &&
          (
            href.includes(
              "/liege/decisions"
            ) ||
            href.includes(
              "@@faceted_query"
            )
          )
        ) {
          pagination.push(href);
        }
      });

    return {
      decisions,
      pagination
    };
  });
}

// ============================================================
// DÉDUPLICATION
// ============================================================

function deduplicateByUrl(
  decisions
) {
  const map = new Map();

  for (
    const decision of decisions
  ) {
    if (
      !decision ||
      !decision.url
    ) {
      continue;
    }

    const url =
      normalizeUrl(
        decision.url
      );

    if (!url) {
      continue;
    }

    if (
      !map.has(url)
    ) {
      map.set(
        url,
        {
          ...decision,
          url
        }
      );
    }
  }

  return [
    ...map.values()
  ];
}

// ============================================================
// MAIN
// ============================================================

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
  console.log("");

  console.log(
    `Année recherchée : ${YEAR}`
  );

  console.log(
    `URL de départ : ${BASE_URL}`
  );

  console.log("");

  console.log(
    "IMPORTANT : ce script ne modifie PAS les données de production."
  );

  console.log("");

  /*
   * ----------------------------------------------------------
   * LANCEMENT DU NAVIGATEUR
   * ----------------------------------------------------------
   */

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

  page.setDefaultNavigationTimeout(
    NAVIGATION_TIMEOUT
  );

  try {
    /*
     * --------------------------------------------------------
     * FILE DES PAGES À VISITER
     * --------------------------------------------------------
     */

    const urlsToVisit = [
      BASE_URL
    ];

    const queuedPages =
      new Set([
        BASE_URL
      ]);

    const visitedPages =
      new Set();

    /*
     * Toutes les décisions trouvées.
     */
    const allDecisions =
      new Map();

    /*
     * --------------------------------------------------------
     * PAGINATION
     * --------------------------------------------------------
     */

    while (
      urlsToVisit.length > 0 &&
      visitedPages.size <
        MAX_PAGES
    ) {
      const currentUrl =
        urlsToVisit.shift();

      if (
        visitedPages.has(
          currentUrl
        )
      ) {
        continue;
      }

      visitedPages.add(
        currentUrl
      );

      console.log("");
      console.log(
        `PAGINATION : page ${visitedPages.size}`
      );

      console.log(
        `Pages restantes dans la file : ${urlsToVisit.length}`
      );

      try {
        const result =
          await extractPage(
            page,
            currentUrl
          );

        /*
         * ----------------------------------------------------
         * DÉCISIONS
         * ----------------------------------------------------
         */

        const decisions2026 =
          result.decisions.filter(
            decision =>
              isDecision2026(
                decision.url
              )
          );

        console.log(
          `Décisions trouvées sur cette page : ${result.decisions.length}`
        );

        console.log(
          `Décisions 2026 sur cette page : ${decisions2026.length}`
        );

        let newDecisions =
          0;

        for (
          const decision of
            decisions2026
        ) {
          const url =
            normalizeUrl(
              decision.url
            );

          if (!url) {
            continue;
          }

          if (
            !allDecisions.has(
              url
            )
          ) {
            allDecisions.set(
              url,
              {
                url,
                title:
                  clean(
                    decision.title
                  )
              }
            );

            newDecisions++;
          }
        }

        console.log(
          `Nouvelles décisions 2026 : ${newDecisions}`
        );

        console.log(
          `TOTAL UNIQUE 2026 : ${allDecisions.size}`
        );

        /*
         * ----------------------------------------------------
         * PAGINATION DÉCOUVERTE
         * ----------------------------------------------------
         */

        let newPages =
          0;

        for (
          const paginationUrlRaw of
            result.pagination
        ) {
          const paginationUrl =
            normalizeUrl(
              paginationUrlRaw,
              currentUrl
            );

          if (!paginationUrl) {
            continue;
          }

          if (
            visitedPages.has(
              paginationUrl
            )
          ) {
            continue;
          }

          if (
            queuedPages.has(
              paginationUrl
            )
          ) {
            continue;
          }

          queuedPages.add(
            paginationUrl
          );

          urlsToVisit.push(
            paginationUrl
          );

          newPages++;
        }

        console.log(
          `Nouvelles pages de pagination découvertes : ${newPages}`
        );

        console.log(
          `Pages encore à visiter : ${urlsToVisit.length}`
        );

      } catch (error) {
        console.error("");

        console.error(
          "ERREUR SUR LA PAGE :"
        );

        console.error(
          currentUrl
        );

        console.error(
          error.message
        );
      }
    }

    /*
     * --------------------------------------------------------
     * FIN DE COLLECTE
     * --------------------------------------------------------
     */

    const decisions =
      deduplicateByUrl(
        [
          ...allDecisions.values()
        ]
      );

    console.log("");
    console.log(
      "=============================================="
    );
    console.log(
      " COLLECTE TERMINÉE"
    );
    console.log(
      "=============================================="
    );
    console.log("");

    console.log(
      `Pages visitées : ${visitedPages.size}`
    );

    console.log(
      `Décisions 2026 uniques : ${decisions.length}`
    );

    console.log("");

    /*
     * --------------------------------------------------------
     * SÉCURITÉ
     * --------------------------------------------------------
     *
     * Nous savons que la collecte complète précédente
     * produisait largement plus de 500 décisions.
     *
     * Si nous obtenons moins de 500 :
     * ON BLOQUE.
     */

    if (
      decisions.length < 500
    ) {
      throw new Error(
        `Sécurité : seulement ${decisions.length} décisions 2026 collectées. La pagination est incomplète. Aucun fichier de données n'est produit.`
      );
    }

    /*
     * --------------------------------------------------------
     * VÉRIFICATION ANNÉE
     * --------------------------------------------------------
     */

    const invalidYear =
      decisions.filter(
        decision =>
          !isDecision2026(
            decision.url
          )
      );

    if (
      invalidYear.length > 0
    ) {
      throw new Error(
        `${invalidYear.length} décision(s) ne correspondent pas à une URL 2026.`
      );
    }

    /*
     * --------------------------------------------------------
     * TRI
     * --------------------------------------------------------
     */

    decisions.sort(
      (a, b) =>
        a.url.localeCompare(
          b.url
        )
    );

    /*
     * --------------------------------------------------------
     * RÉPARTITION PAR DATE
     * --------------------------------------------------------
     */

    const byDate =
      new Map();

    for (
      const decision of
        decisions
    ) {
      const match =
        decision.url.match(
          /\/decisions\/([^/]+)\//
        );

      const date =
        match
          ? match[1]
          : "inconnue";

      byDate.set(
        date,
        (
          byDate.get(
            date
          ) || 0
        ) + 1
      );
    }

    console.log(
      "Répartition par séance/date :"
    );

    for (
      const [
        date,
        count
      ] of byDate
    ) {
      console.log(
        `  ${date} : ${count}`
      );
    }

    /*
     * --------------------------------------------------------
     * ÉCRITURE DU FICHIER
     * --------------------------------------------------------
     */

    fs.mkdirSync(
      path.dirname(
        OUTPUT
      ),
      {
        recursive: true
      }
    );

    const output = {
      commune:
        "Liège",

      annee:
        YEAR,

      updatedAt:
        new Date().toISOString(),

      source:
        BASE_URL,

      count:
        decisions.length,

      decisions
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
      `✓ ${decisions.length} décisions 2026 enregistrées`
    );

    console.log(
      "✓ Aucune donnée de production modifiée"
    );

    console.log("");

  } finally {
    await page.close();

    await browser.close();
  }
}

// ============================================================
// GESTION DES ERREURS
// ============================================================

main().catch(
  error => {
    console.error("");
    console.error(
      "=============================================="
    );
    console.error(
      " ERREUR FATALE"
    );
    console.error(
      "=============================================="
    );
    console.error("");

    console.error(
      error
    );

    process.exit(1);
  }
);
