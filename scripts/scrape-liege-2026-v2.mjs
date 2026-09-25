import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const BASE_URL =
  "https://www.deliberations.be/liege/decisions";

const OUTPUT =
  "tmp/liege-2026-analysis.json";

const YEAR = 2026;

const PAGE_SIZE = 20;

// Sécurité : on ne dépassera jamais 100 pages.
const MAX_PAGES = 100;

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


  await new Promise(resolve =>
    setTimeout(
      resolve,
      WAIT_AFTER_LOAD
    )
  );


  return await page.evaluate(() => {

    const decisions = [];

    const pagination = [];


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
     * On récupère une vraie URL de pagination fournie
     * par le site afin d'en extraire le paramètre seance[].
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
          href.includes("@@faceted_query") &&
          href.includes("b_start") &&
          href.includes("seance")
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

function deduplicateByUrl(decisions) {

  const map = new Map();


  for (const decision of decisions) {

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


    if (!map.has(url)) {

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
// EXTRACTION DU PARAMÈTRE SEANCE
// ============================================================

function extractSeanceParameter(url) {

  try {

    const parsed =
      new URL(url);


    /*
     * Le site utilise :
     *
     * seance[]=440b6cc1...
     *
     * URLSearchParams renvoie correctement la valeur
     * même avec les crochets.
     */

    const seance =
      parsed.searchParams.get(
        "seance[]"
      );


    if (seance) {
      return seance;
    }


    /*
     * Sécurité supplémentaire si le navigateur
     * encode différemment le nom du paramètre.
     */

    for (
      const [key, value]
      of parsed.searchParams.entries()
    ) {

      if (
        key === "seance" ||
        key === "seance[]"
      ) {

        return value;

      }

    }


    return null;

  } catch {

    return null;

  }
}


// ============================================================
// CONSTRUCTION D'UNE PAGE DE PAGINATION
// ============================================================

function buildPaginationUrl(
  offset,
  seance
) {

  if (!seance) {
    return null;
  }


  return (
    `${BASE_URL}/@@faceted_query` +
    `?b_start:int=${offset}` +
    `&seance%5B%5D=${encodeURIComponent(seance)}`
  );
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
     * ----------------------------------------------------------
     * 1. PAGE INITIALE
     * ----------------------------------------------------------
     */

    console.log("");

    console.log(
      "Recherche du paramètre de séance..."
    );


    const firstPage =
      await extractPage(
        page,
        BASE_URL
      );


    const firstDecisions =
      firstPage.decisions.filter(
        decision =>
          isDecision2026(
            decision.url
          )
      );


    console.log("");

    console.log(
      `Décisions trouvées sur la page initiale : ${firstPage.decisions.length}`
    );


    console.log(
      `Décisions 2026 sur la page initiale : ${firstDecisions.length}`
    );


    /*
     * ----------------------------------------------------------
     * 2. RÉCUPÉRATION DU SEANCE[]
     * ----------------------------------------------------------
     */

    let seance = null;


    for (
      const paginationUrl
      of firstPage.pagination
    ) {

      seance =
        extractSeanceParameter(
          paginationUrl
        );


      if (seance) {
        break;
      }

    }


    if (!seance) {

      throw new Error(
        "Impossible de récupérer le paramètre seance[] utilisé par deliberations.be."
      );

    }


    console.log("");

    console.log(
      `✓ Paramètre seance[] détecté : ${seance}`
    );


    /*
     * ----------------------------------------------------------
     * 3. COLLECTE
     * ----------------------------------------------------------
     */

    const allDecisions =
      new Map();


    for (
      const decision
      of firstDecisions
    ) {

      const url =
        normalizeUrl(
          decision.url
        );


      if (!url) {
        continue;
      }


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

    }


    console.log("");

    console.log(
      `TOTAL UNIQUE 2026 : ${allDecisions.size}`
    );


    /*
     * ----------------------------------------------------------
     * 4. PAGINATION PAR OFFSET
     *
     * Nous utilisons maintenant la bonne URL :
     *
     * @@faceted_query
     * ?b_start:int=20
     * &seance[]=...
     *
     * Le problème précédent venait du fait que nous
     * fabriquions b_start sans conserver seance[].
     * ----------------------------------------------------------
     */

    for (
      let pageNumber = 2;
      pageNumber <= MAX_PAGES;
      pageNumber++
    ) {

      const offset =
        (pageNumber - 1) *
        PAGE_SIZE;


      const paginationUrl =
        buildPaginationUrl(
          offset,
          seance
        );


      if (!paginationUrl) {
        break;
      }


      console.log("");

      console.log(
        "=============================================="
      );

      console.log(
        `PAGINATION : page ${pageNumber}`
      );

      console.log(
        "=============================================="
      );


      console.log(
        `Offset : ${offset}`
      );


      console.log(
        `URL : ${paginationUrl}`
      );


      const result =
        await extractPage(
          page,
          paginationUrl
        );


      const decisions2026 =
        result.decisions.filter(
          decision =>
            isDecision2026(
              decision.url
            )
        );


      console.log("");

      console.log(
        `Décisions trouvées : ${result.decisions.length}`
      );


      console.log(
        `Décisions 2026 : ${decisions2026.length}`
      );


      let newDecisions = 0;


      for (
        const decision
        of decisions2026
      ) {

        const url =
          normalizeUrl(
            decision.url
          );


        if (!url) {
          continue;
        }


        if (
          !allDecisions.has(url)
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
       * --------------------------------------------------------
       * FIN DE PAGINATION
       * --------------------------------------------------------
       *
       * Une page vide ou une page ne contenant plus aucune
       * nouvelle décision signifie que nous avons atteint
       * la fin.
       */

      if (
        result.decisions.length === 0
      ) {

        console.log("");

        console.log(
          "Fin de pagination détectée : page vide."
        );

        break;

      }


      if (
        newDecisions === 0
      ) {

        console.log("");

        console.log(
          "Fin de pagination détectée : aucune nouvelle décision."
        );

        break;

      }


      /*
       * Si la page contient moins de 20 décisions,
       * nous sommes normalement sur la dernière page.
       */

      if (
        result.decisions.length <
        PAGE_SIZE
      ) {

        console.log("");

        console.log(
          "Dernière page détectée : moins de 20 décisions."
        );

        break;

      }

    }


    /*
     * ----------------------------------------------------------
     * 5. FINALISATION
     * ----------------------------------------------------------
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
      `Décisions 2026 uniques : ${decisions.length}`
    );


    console.log("");


    /*
     * ----------------------------------------------------------
     * 6. SÉCURITÉ
     * ----------------------------------------------------------
     */

    if (
      decisions.length < 500
    ) {

      throw new Error(
        `Sécurité : seulement ${decisions.length} décisions 2026 collectées. La collecte est considérée comme incomplète. Aucun fichier de données n'est produit.`
      );

    }


    /*
     * ----------------------------------------------------------
     * 7. VÉRIFICATION ANNÉE
     * ----------------------------------------------------------
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
     * ----------------------------------------------------------
     * 8. TRI
     * ----------------------------------------------------------
     */

    decisions.sort(
      (a, b) =>
        a.url.localeCompare(
          b.url
        )
    );


    /*
     * ----------------------------------------------------------
     * 9. RÉPARTITION PAR DATE
     * ----------------------------------------------------------
     */

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


    /*
     * ----------------------------------------------------------
     * 10. ÉCRITURE
     * ----------------------------------------------------------
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
// ERREURS
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
