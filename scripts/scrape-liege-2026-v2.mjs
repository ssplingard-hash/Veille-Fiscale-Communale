import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const BASE_URL =
  "https://www.deliberations.be/liege/decisions";

const OUTPUT =
  "tmp/liege-2026-analysis.json";

const YEAR = 2026;

const MIN_EXPECTED = 500;

const MAX_PAGES = 500;

const NAVIGATION_TIMEOUT = 60000;

const WAIT_AFTER_LOAD = 800;

const PAGE_SIZE = 20;


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


function isDecision2026(url) {
  return (
    typeof url === "string" &&
    /\/liege\/decisions\/\d{1,2}-[a-zà-ÿ]+-2026-\d{1,2}-\d{2}\//i.test(
      url
    )
  );
}


// ============================================================
// EXTRACTION DES DÉCISIONS D'UNE PAGE
// ============================================================

async function extractDecisions(page) {
  return await page.evaluate(() => {
    const decisions = [];

    document
      .querySelectorAll("a[href]")
      .forEach((a) => {
        const href = a.href;

        const title =
          (
            a.innerText ||
            a.textContent ||
            ""
          ).trim();

        if (!href) {
          return;
        }

        if (
          /\/liege\/decisions\/\d{1,2}-[a-zà-ÿ]+-2026-\d{1,2}-\d{2}\//i.test(
            href
          )
        ) {
          decisions.push({
            url: href,
            title
          });
        }
      });

    return decisions;
  });
}


// ============================================================
// EXTRACTION DES IDENTIFIANTS DE SÉANCES
//
// On cherche les UUID associés à "seance" dans :
// - href
// - value
// - data-*
// - attributs
// - HTML complet
// ============================================================

async function extractSeanceIds(page) {
  return await page.evaluate(() => {

    const ids = new Set();

    const uuidRegex =
      /[0-9a-f]{32}/gi;


    function addFromText(text) {
      if (!text) {
        return;
      }

      const matches =
        text.match(uuidRegex);

      if (!matches) {
        return;
      }

      for (const id of matches) {
        ids.add(id.toLowerCase());
      }
    }


    // --------------------------------------------------------
    // Attributs des éléments
    // --------------------------------------------------------

    document
      .querySelectorAll("*")
      .forEach((element) => {

        for (
          const attribute
          of Array.from(element.attributes)
        ) {

          const name =
            attribute.name
              .toLowerCase();

          const value =
            attribute.value || "";


          if (
            name.includes("seance") ||
            name.includes("session") ||
            name.includes("facet") ||
            name.includes("value") ||
            name.startsWith("data-")
          ) {
            addFromText(value);
          }
        }
      });


    // --------------------------------------------------------
    // Liens
    // --------------------------------------------------------

    document
      .querySelectorAll("a[href]")
      .forEach((a) => {

        const href =
          a.href || "";

        const text =
          a.innerText ||
          a.textContent ||
          "";

        if (
          href.includes("seance") ||
          href.includes("session")
        ) {
          addFromText(href);
          addFromText(text);
        }
      });


    // --------------------------------------------------------
    // HTML complet
    // --------------------------------------------------------

    addFromText(
      document.documentElement.outerHTML
    );


    return Array.from(ids);
  });
}


// ============================================================
// CHARGEMENT D'UNE PAGE
// ============================================================

async function loadPage(page, url) {

  console.log("");
  console.log(
    "----------------------------------------------"
  );

  console.log(
    `Chargement : ${url}`
  );


  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT
  });


  await new Promise((resolve) =>
    setTimeout(
      resolve,
      WAIT_AFTER_LOAD
    )
  );


  const decisions =
    await extractDecisions(page);


  console.log(
    `Décisions 2026 visibles : ${decisions.length}`
  );


  return decisions;
}


// ============================================================
// AJOUT DES DÉCISIONS
// ============================================================

function addDecisions(
  map,
  decisions
) {

  let added = 0;

  for (
    const decision
    of decisions
  ) {

    const url =
      normalizeUrl(
        decision.url
      );

    if (!url) {
      continue;
    }

    if (
      !isDecision2026(url)
    ) {
      continue;
    }

    if (
      !map.has(url)
    ) {

      map.set(
        url,
        {
          url,
          title:
            clean(
              decision.title
            )
        }
      );

      added++;
    }
  }

  return added;
}


// ============================================================
// CONSTRUCTION D'UNE URL DE PAGINATION
// ============================================================

function paginationUrl(
  start,
  seanceId = null
) {

  const url =
    new URL(
      `${BASE_URL}/@@faceted_query`
    );


  url.searchParams.set(
    "b_start:int",
    String(start)
  );


  if (seanceId) {

    url.searchParams.set(
      "seance[]",
      seanceId
    );
  }


  return url.href;
}


// ============================================================
// STRATÉGIE 1 : PAGINATION SANS FILTRE DE SÉANCE
// ============================================================

async function collectWithoutSeance(
  page,
  allDecisions
) {

  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    "STRATÉGIE 1 : PAGINATION SANS SÉANCE"
  );
  console.log(
    "=============================================="
  );


  let consecutiveEmptyPages = 0;


  for (
    let start = 0;
    start <= MAX_PAGES * PAGE_SIZE;
    start += PAGE_SIZE
  ) {

    const url =
      paginationUrl(start);


    console.log("");
    console.log(
      `Pagination globale : ${start}`
    );


    try {

      const decisions =
        await loadPage(
          page,
          url
        );


      const added =
        addDecisions(
          allDecisions,
          decisions
        );


      console.log(
        `Nouvelles décisions 2026 : ${added}`
      );


      console.log(
        `TOTAL UNIQUE 2026 : ${allDecisions.size}`
      );


      if (
        added === 0
      ) {

        consecutiveEmptyPages++;

      } else {

        consecutiveEmptyPages = 0;
      }


      // ------------------------------------------------------
      // Si plusieurs pages successives ne donnent plus rien,
      // on considère que la série est terminée.
      // ------------------------------------------------------

      if (
        consecutiveEmptyPages >= 2
      ) {

        console.log(
          "Fin de la pagination globale."
        );

        break;
      }

    } catch (error) {

      console.error(
        `Erreur pagination ${start}:`,
        error.message
      );
    }
  }
}


// ============================================================
// DÉCOUVERTE DES SÉANCES
// ============================================================

async function discoverSeances(
  page
) {

  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    "DÉCOUVERTE DES SÉANCES"
  );
  console.log(
    "=============================================="
  );


  await page.goto(
    BASE_URL,
    {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT
    }
  );


  await new Promise((resolve) =>
    setTimeout(
      resolve,
      WAIT_AFTER_LOAD
    )
  );


  const ids =
    await extractSeanceIds(
      page
    );


  console.log(
    `Identifiants de séances détectés : ${ids.length}`
  );


  for (
    const id
    of ids
  ) {

    console.log(
      `  - ${id}`
    );
  }


  return ids;
}


// ============================================================
// STRATÉGIE 2 : PAR SÉANCE
// ============================================================

async function collectBySeance(
  page,
  seanceIds,
  allDecisions
) {

  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    "STRATÉGIE 2 : COLLECTE PAR SÉANCE"
  );
  console.log(
    "=============================================="
  );


  let sessionNumber = 0;


  for (
    const seanceId
    of seanceIds
  ) {

    sessionNumber++;


    console.log("");
    console.log(
      "=============================================="
    );

    console.log(
      `SÉANCE ${sessionNumber}/${seanceIds.length}`
    );

    console.log(
      `ID : ${seanceId}`
    );

    console.log(
      "=============================================="
    );


    let consecutiveEmptyPages = 0;

    let previousPageSignature =
      null;


    for (
      let start = 0;
      start <= MAX_PAGES * PAGE_SIZE;
      start += PAGE_SIZE
    ) {

      const url =
        paginationUrl(
          start,
          seanceId
        );


      try {

        const decisions =
          await loadPage(
            page,
            url
          );


        const signature =
          decisions
            .map(
              decision =>
                decision.url
            )
            .sort()
            .join("|");


        // ----------------------------------------------------
        // Protection contre une URL qui renvoie toujours
        // exactement la même page.
        // ----------------------------------------------------

        if (
          signature &&
          signature ===
            previousPageSignature
        ) {

          console.log(
            "Page identique à la précédente : fin de cette séance."
          );

          break;
        }


        previousPageSignature =
          signature;


        const added =
          addDecisions(
            allDecisions,
            decisions
          );


        console.log(
          `Nouvelles décisions 2026 : ${added}`
        );


        console.log(
          `TOTAL UNIQUE 2026 : ${allDecisions.size}`
        );


        if (
          decisions.length === 0
        ) {

          break;
        }


        if (
          added === 0
        ) {

          consecutiveEmptyPages++;

        } else {

          consecutiveEmptyPages = 0;
        }


        if (
          consecutiveEmptyPages >= 2
        ) {

          break;
        }

      } catch (error) {

        console.error(
          `Erreur séance ${seanceId}, offset ${start}:`,
          error.message
        );

        break;
      }
    }
  }
}


// ============================================================
// STRATÉGIE 3 : DÉCOUVERTE DES LIENS DE SÉANCE
// ============================================================
//
// Certaines versions du site ne mettent pas directement les
// UUID dans les attributs classiques. On inspecte donc aussi
// les liens de navigation présents sur la page.
//
// ============================================================

async function discoverSeanceLinks(
  page
) {

  await page.goto(
    BASE_URL,
    {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT
    }
  );


  await new Promise((resolve) =>
    setTimeout(
      resolve,
      WAIT_AFTER_LOAD
    )
  );


  const links =
    await page.evaluate(() => {

      return Array.from(
        document.querySelectorAll(
          "a[href]"
        )
      )
        .map(
          a => ({
            href:
              a.href || "",
            text:
              (
                a.innerText ||
                a.textContent ||
                ""
              ).trim()
          })
        )
        .filter(
          item =>
            item.href.includes(
              "seance"
            )
        );
    });


  return links;
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
    "       COLLECTE LIÈGE 2026"
  );
  console.log(
    "=============================================="
  );

  console.log("");
  console.log(
    `Année : ${YEAR}`
  );

  console.log(
    `Source : ${BASE_URL}`
  );

  console.log("");
  console.log(
    "Aucun fichier de production ne sera modifié."
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


  const page =
    await browser.newPage();


  page.setDefaultNavigationTimeout(
    NAVIGATION_TIMEOUT
  );


  const allDecisions =
    new Map();


  try {

    // ========================================================
    // ÉTAPE 1
    // ========================================================

    await collectWithoutSeance(
      page,
      allDecisions
    );


    console.log("");
    console.log(
      "=============================================="
    );

    console.log(
      `Après stratégie 1 : ${allDecisions.size} décisions`
    );


    // ========================================================
    // SI LA PAGINATION SANS SÉANCE SUFFIT
    // ========================================================

    if (
      allDecisions.size >=
      MIN_EXPECTED
    ) {

      console.log(
        "✓ La pagination globale suffit."
      );

    } else {

      // ======================================================
      // ÉTAPE 2
      // ======================================================

      const seanceIds =
        await discoverSeances(
          page
        );


      // ======================================================
      // ÉTAPE 3
      // ======================================================

      if (
        seanceIds.length > 0
      ) {

        await collectBySeance(
          page,
          seanceIds,
          allDecisions
        );

      } else {

        console.log(
          "Aucun identifiant de séance supplémentaire détecté."
        );
      }


      // ======================================================
      // ÉTAPE 4
      // ======================================================

      const seanceLinks =
        await discoverSeanceLinks(
          page
        );


      console.log("");
      console.log(
        `Liens contenant "seance" détectés : ${seanceLinks.length}`
      );


      for (
        const link
        of seanceLinks
      ) {

        console.log(
          `  ${link.href}`
        );
      }
    }


    // ========================================================
    // RÉSULTAT FINAL
    // ========================================================

    const decisions =
      Array.from(
        allDecisions.values()
      );


    decisions.sort(
      (a, b) =>
        a.url.localeCompare(
          b.url
        )
    );


    console.log("");
    console.log(
      "=============================================="
    );
    console.log(
      "       RÉSULTAT FINAL"
    );
    console.log(
      "=============================================="
    );

    console.log("");
    console.log(
      `Décisions 2026 collectées : ${decisions.length}`
    );


    // ========================================================
    // SÉCURITÉ
    // ========================================================

    if (
      decisions.length <
      MIN_EXPECTED
    ) {

      console.error("");
      console.error(
        "=============================================="
      );

      console.error(
        "COLLECTE INSUFFISANTE"
      );

      console.error(
        "=============================================="
      );

      console.error("");

      console.error(
        `Seulement ${decisions.length} décisions 2026 ont été collectées.`
      );

      console.error(
        `Minimum attendu : ${MIN_EXPECTED}.`
      );

      console.error("");

      console.error(
        "Le fichier de données n'est PAS créé."
      );

      process.exitCode = 1;

      return;
    }


    // ========================================================
    // VÉRIFICATION DE L'ANNÉE
    // ========================================================

    const wrongYear =
      decisions.filter(
        decision =>
          !isDecision2026(
            decision.url
          )
      );


    if (
      wrongYear.length > 0
    ) {

      throw new Error(
        `${wrongYear.length} décision(s) ne correspondent pas à 2026.`
      );
    }


    // ========================================================
    // RÉPARTITION PAR DATE
    // ========================================================

    const byDate =
      new Map();


    for (
      const decision
      of decisions
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


    console.log("");
    console.log(
      "Répartition par séance/date :"
    );


    for (
      const [
        date,
        count
      ]
      of byDate
    ) {

      console.log(
        `  ${date} : ${count}`
      );
    }


    // ========================================================
    // ÉCRITURE DU FICHIER TEMPORAIRE
    // ========================================================

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
      "=============================================="
    );

    console.log(
      "COLLECTE RÉUSSIE"
    );

    console.log(
      "=============================================="
    );

    console.log("");

    console.log(
      `✓ ${decisions.length} décisions 2026`
    );

    console.log(
      `✓ Fichier : ${OUTPUT}`
    );

    console.log(
      "✓ Production inchangée"
    );

    console.log("");

  } finally {

    await page.close();

    await browser.close();
  }
}


// ============================================================
// ERREUR FATALE
// ============================================================

main().catch(
  error => {

    console.error("");

    console.error(
      "=============================================="
    );

    console.error(
      "ERREUR FATALE"
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
