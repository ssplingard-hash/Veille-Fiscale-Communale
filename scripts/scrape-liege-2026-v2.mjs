import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import puppeteer from "puppeteer";

const execFileAsync = promisify(execFile);

const BASE_URL = "https://www.deliberations.be/liege/decisions";
const YEAR = 2026;

const OUTPUT_DIR = path.resolve("tmp");
const RAW_FILE = path.join(
  OUTPUT_DIR,
  "liege-2026-analysis.json"
);

const MIN_EXPECTED_DECISIONS = 500;
const MAX_PAGES = 100;

const DECISION_URL_REGEX =
  /\/decisions\/\d{1,2}-[a-zàâäéèêëîïôöùûüÿç]+-2026-\d{1,2}-\d{2}\//i;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanText(text = "") {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(text = "") {
  return cleanText(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function absoluteUrl(url) {
  try {
    return new URL(url, BASE_URL).href;
  } catch {
    return "";
  }
}

function getDateFromUrl(url) {
  const match = url.match(
    /\/decisions\/(\d{1,2})-([a-zàâäéèêëîïôöùûüÿç]+)-2026-\d{1,2}-\d{2}\//i
  );

  if (!match) return null;

  const months = {
    janvier: "01",
    fevrier: "02",
    février: "02",
    mars: "03",
    avril: "04",
    mai: "05",
    juin: "06",
    juillet: "07",
    aout: "08",
    août: "08",
    septembre: "09",
    octobre: "10",
    novembre: "11",
    decembre: "12",
    décembre: "12"
  };

  const month =
    months[normalizeText(match[2])];

  if (!month) return null;

  return `2026-${month}-${String(
    match[1]
  ).padStart(2, "0")}`;
}

function getTitleFromUrl(url) {
  try {
    const pathname =
      new URL(url).pathname;

    const parts =
      pathname.split("/").filter(Boolean);

    const slug =
      parts[parts.length - 1] || "";

    return decodeURIComponent(slug)
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function extractOffset(url) {
  const match =
    url.match(/[?&]b_start(?::int)?=(\d+)/i);

  return match
    ? Number(match[1])
    : 0;
}

function buildPaginationUrl(
  offset,
  seanceId
) {
  return (
    `${BASE_URL}/@@faceted_query` +
    `?b_start:int=${offset}` +
    `&seance%5B%5D=${encodeURIComponent(
      seanceId
    )}`
  );
}

async function discoverSeanceId(page) {
  await page.goto(BASE_URL, {
    waitUntil: "networkidle2",
    timeout: 120000
  });

  await sleep(1000);

  const html =
    await page.content();

  const patterns = [
    /seance(?:%5B%5D|\[\])=([a-z0-9]+)/i,
    /seance=([a-z0-9]+)/i
  ];

  for (const pattern of patterns) {
    const match =
      html.match(pattern);

    if (match) {
      return match[1];
    }
  }

  const currentUrl =
    page.url();

  for (const pattern of patterns) {
    const match =
      currentUrl.match(pattern);

    if (match) {
      return match[1];
    }
  }

  throw new Error(
    "Impossible de récupérer l'identifiant de séance."
  );
}

async function extractDecisionLinks(page, url) {
  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 120000
  });

  await sleep(500);

  return await page.evaluate(
    decisionRegexSource => {
      const regex =
        new RegExp(
          decisionRegexSource,
          "i"
        );

      return Array.from(
        document.querySelectorAll("a")
      )
        .map(a => ({
          href: a.href || "",
          text:
            a.innerText?.trim() || ""
        }))
        .filter(x =>
          regex.test(x.href)
        );
    },
    DECISION_URL_REGEX.source
  );
}

async function collectAllDecisionLinks(
  browser
) {
  const page =
    await browser.newPage();

  try {
    console.log(
      "Recherche de l'identifiant de séance..."
    );

    const seanceId =
      await discoverSeanceId(
        page
      );

    console.log(
      `Séance détectée : ${seanceId}`
    );

    const decisionMap =
      new Map();

    /*
     * IMPORTANT :
     * Nous ne suivons plus les liens de pagination
     * fournis par la page.
     *
     * Nous générons nous-mêmes :
     * 0, 20, 40, 60, 80, etc.
     */

    for (
      let pageNumber = 0;
      pageNumber < MAX_PAGES;
      pageNumber++
    ) {
      const offset =
        pageNumber * 20;

      const url =
        buildPaginationUrl(
          offset,
          seanceId
        );

      console.log("");
      console.log(
        `PAGE ${pageNumber + 1} — offset ${offset}`
      );
      console.log(url);

      let links = [];

      try {
        links =
          await extractDecisionLinks(
            page,
            url
          );
      } catch (error) {
        console.log(
          `Erreur sur offset ${offset} : ${error.message}`
        );
        continue;
      }

      let newCount = 0;

      for (const link of links) {
        const cleanUrl =
          link.href.split("#")[0];

        if (
          !decisionMap.has(
            cleanUrl
          )
        ) {
          decisionMap.set(
            cleanUrl,
            {
              url: cleanUrl,
              linkText:
                cleanText(
                  link.text
                )
            }
          );

          newCount++;
        }
      }

      console.log(
        `Décisions 2026 sur cette page : ${links.length}`
      );

      console.log(
        `Nouvelles décisions : ${newCount}`
      );

      console.log(
        `Total unique : ${decisionMap.size}`
      );

      /*
       * Si la page ne contient plus aucune
       * nouvelle décision, on considère que
       * nous avons atteint la fin.
       */
      if (
        links.length === 0
      ) {
        console.log(
          "Aucune décision sur cette page : fin de la pagination."
        );
        break;
      }

      /*
       * Sécurité supplémentaire :
       * si aucune nouvelle décision n'est trouvée
       * pendant une page complète, on arrête.
       */
      if (
        newCount === 0
      ) {
        console.log(
          "Aucune nouvelle décision : fin de la pagination."
        );
        break;
      }

      await sleep(300);
    }

    console.log("");
    console.log(
      `TOTAL FINAL : ${decisionMap.size} décisions 2026`
    );

    if (
      decisionMap.size <
      MIN_EXPECTED_DECISIONS
    ) {
      throw new Error(
        `Seulement ${decisionMap.size} décisions trouvées. Arrêt de sécurité.`
      );
    }

    return [
      ...decisionMap.values()
    ];
  } finally {
    await page.close();
  }
}

async function extractDecisionPage(
  page,
  decision
) {
  for (
    let attempt = 1;
    attempt <= 3;
    attempt++
  ) {
    try {
      await page.goto(
        decision.url,
        {
          waitUntil:
            "networkidle2",
          timeout: 120000
        }
      );

      await sleep(300);

      const result =
        await page.evaluate(
          () => {
            const links =
              Array.from(
                document.querySelectorAll(
                  "a"
                )
              ).map(a => ({
                text:
                  a.innerText?.trim() ||
                  "",
                href:
                  a.href || ""
              }));

            const bodyText =
              document.body
                ?.innerText || "";

            const headings =
              Array.from(
                document.querySelectorAll(
                  "h1,h2,h3,h4"
                )
              )
                .map(
                  x =>
                    x.innerText?.trim() ||
                    ""
                )
                .filter(Boolean);

            return {
              bodyText,
              headings,
              links
            };
          }
        );

      const documentLinks =
        result.links
          .filter(link => {
            const href =
              normalizeText(
                link.href
              );

            const text =
              normalizeText(
                link.text
              );

            return (
              /\.pdf(?:$|\?)/i.test(
                href
              ) ||
              /\/document/i.test(
                href
              ) ||
              /\/download/i.test(
                href
              ) ||
              /\/attachment/i.test(
                href
              ) ||
              text.includes("pdf") ||
              text.includes(
                "document"
              ) ||
              text.includes(
                "annexe"
              ) ||
              text.includes(
                "télécharger"
              ) ||
              text.includes(
                "telecharger"
              )
            );
          })
          .map(link => ({
            text:
              cleanText(
                link.text
              ),
            href:
              absoluteUrl(
                link.href
              )
          }))
          .filter(x => x.href);

      const uniqueDocuments =
        [
          ...new Map(
            documentLinks.map(
              x => [
                x.href,
                x
              ]
            )
          ).values()
        ].slice(0, 10);

      return {
        url: decision.url,
        date:
          getDateFromUrl(
            decision.url
          ),
        title:
          getTitleFromUrl(
            decision.url
          ),
        linkText:
          cleanText(
            decision.linkText
          ),
        headings:
          result.headings.map(
            cleanText
          ),
        pageText:
          cleanText(
            result.bodyText
          ),
        documents:
          uniqueDocuments
      };
    } catch (error) {
      console.log(
        `   Tentative ${attempt}/3 : ${error.message}`
      );

      if (
        attempt < 3
      ) {
        await sleep(
          1000 * attempt
        );
      }
    }
  }

  return null;
}

async function downloadPdf(
  url
) {
  try {
    const response =
      await fetch(
        url,
        {
          redirect:
            "follow",
          signal:
            AbortSignal.timeout(
              45000
            )
        }
      );

    if (
      !response.ok
    ) {
      return null;
    }

    const contentType =
      response.headers.get(
        "content-type"
      ) || "";

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    if (
      buffer.length >
      15 * 1024 * 1024
    ) {
      return null;
    }

    if (
      buffer
        .subarray(0, 4)
        .toString() !==
        "%PDF" &&
      !contentType
        .toLowerCase()
        .includes("pdf")
    ) {
      return null;
    }

    return buffer;
  } catch {
    return null;
  }
}

async function extractPdfText(
  buffer,
  index
) {
  const tempDir =
    path.join(
      OUTPUT_DIR,
      "pdf-temp"
    );

  fs.mkdirSync(
    tempDir,
    {
      recursive: true
    }
  );

  const pdfPath =
    path.join(
      tempDir,
      `document-${process.pid}-${index}.pdf`
    );

  const txtPath =
    `${pdfPath}.txt`;

  try {
    fs.writeFileSync(
      pdfPath,
      buffer
    );

    await execFileAsync(
      "pdftotext",
      [
        "-layout",
        pdfPath,
        txtPath
      ],
      {
        timeout: 60000
      }
    );

    return cleanText(
      fs.readFileSync(
        txtPath,
        "utf8"
      )
    );
  } catch {
    return "";
  } finally {
    try {
      fs.unlinkSync(
        pdfPath
      );
    } catch {}

    try {
      fs.unlinkSync(
        txtPath
      );
    } catch {}
  }
}

function classifyDecision(
  decision
) {
  const title =
    normalizeText(
      decision.title
    );

  const pdfText =
    normalizeText(
      decision.pdfText || ""
    );

  const combined =
    `${title} ${pdfText}`;

  const exclusions = [
    "subvention",
    "subside",
    "convention",
    "bail",
    "marche public",
    "commande publique",
    "travaux",
    "fourniture",
    "personnel",
    "police",
    "stationnement",
    "parking",
    "occupation du domaine public",
    "occupation de la voirie",
    "manifestation",
    "festival",
    "evenement",
    "activité ambulante",
    "activite ambulante"
  ];

  if (
    exclusions.some(
      x =>
        title.includes(x)
    )
  ) {
    return {
      status:
        "NON_FISCAL",
      confidence:
        "EXCLU",
      reasons: [
        "EXCLUSION_TITRE"
      ]
    };
  }

  const certainSignals = [
    "reglement-taxe",
    "reglement taxe",
    "reglement des taxes",
    "reglement de taxe",
    "reglement d une taxe",
    "taxe communale",
    "taxes communales",
    "centimes additionnels",
    "precompte immobilier",
    "force motrice",
    "impot des personnes physiques",
    "impots des personnes physiques",
    "ipp communal"
  ];

  const certainMatches =
    certainSignals.filter(
      x =>
        combined.includes(x)
    );

  if (
    certainMatches.length
  ) {
    return {
      status:
        "FISCAL",
      confidence:
        "CERTAIN",
      reasons:
        certainMatches
    };
  }

  const objects = [
    "taxe sur les immeubles",
    "taxe sur les bureaux",
    "taxe sur les enseignes",
    "taxe sur les pylones",
    "taxe sur les logements",
    "taxe sur les commerces",
    "taxe sur les entreprises",
    "taxe sur les surfaces commerciales",
    "taxe sur les panneaux",
    "taxe sur la publicite",
    "taxe sur les antennes",
    "taxe sur les dechets",
    "taxe sur les immondices",
    "taxe sur les secondes residences",
    "taxe sur les vehicules",
    "taxe sur les véhicules"
  ];

  const objectMatches =
    objects.filter(
      x =>
        combined.includes(x)
    );

  if (
    objectMatches.length
  ) {
    return {
      status:
        "FISCAL",
      confidence:
        "CERTAIN",
      reasons:
        objectMatches
    };
  }

  return {
    status:
      "NON_FISCAL",
    confidence:
      "FAIBLE",
    reasons: []
  };
}

async function processDecision(
  browser,
  decision,
  index,
  total
) {
  const page =
    await browser.newPage();

  try {
    console.log(
      `[${index + 1}/${total}] ${decision.url}`
    );

    const result =
      await extractDecisionPage(
        page,
        decision
      );

    if (!result) {
      return {
        ...decision,
        classification: {
          status:
            "ERREUR",
          confidence:
            "ERREUR",
          reasons: []
        }
      };
    }

    let pdfText = "";
    let pdfCount = 0;

    for (
      let i = 0;
      i <
        result.documents
          .length;
      i++
    ) {
      const document =
        result.documents[i];

      const buffer =
        await downloadPdf(
          document.href
        );

      if (!buffer) {
        continue;
      }

      const text =
        await extractPdfText(
          buffer,
          `${index}-${i}`
        );

      if (text) {
        pdfText +=
          `\n${text}`;
        pdfCount++;
      }
    }

    const enriched = {
      ...result,
      pdfText,
      pdfDocumentsDownloaded:
        pdfCount
    };

    return {
      url:
        enriched.url,
      date:
        enriched.date,
      title:
        enriched.title,
      linkText:
        enriched.linkText,
      headings:
        enriched.headings,
      documents:
        enriched.documents,
      pdfDocumentsDownloaded:
        pdfCount,
      classification:
        classifyDecision(
          enriched
        )
    };
  } finally {
    await page.close();
  }
}

async function main() {
  console.log("");
  console.log(
    "=================================================="
  );
  console.log(
    "LIÈGE 2026 — PIPELINE V2"
  );
  console.log(
    "=================================================="
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
    console.log("");
    console.log(
      "ÉTAPE 1 — COLLECTE"
    );

    const decisions =
      await collectAllDecisionLinks(
        browser
      );

    console.log("");
    console.log(
      "ÉTAPE 2 — DOCUMENTS"
    );

    const results = [];

    /*
     * On traite les décisions
     * une par une pour ce premier test.
     *
     * C'est plus lent mais beaucoup
     * plus stable.
     */
    for (
      let i = 0;
      i < decisions.length;
      i++
    ) {
      const result =
        await processDecision(
          browser,
          decisions[i],
          i,
          decisions.length
        );

      results.push(result);
    }

    const fiscal =
      results.filter(
        x =>
          x.classification
            ?.status ===
          "FISCAL"
      );

    const documents =
      results.filter(
        x =>
          x.documents?.length
      );

    const pdfs =
      results.reduce(
        (sum, x) =>
          sum +
          (x.pdfDocumentsDownloaded ||
            0),
        0
      );

    const output = {
      commune:
        "Liège",
      annee:
        YEAR,
      generatedAt:
        new Date().toISOString(),
      totalDecisions:
        results.length,
      decisionsAvecDocuments:
        documents.length,
      pdfDocumentsTelecharges:
        pdfs,
      fiscalCertain:
        fiscal.length,
      decisions:
        results
    };

    fs.writeFileSync(
      RAW_FILE,
      JSON.stringify(
        output,
        null,
        2
      ),
      "utf8"
    );

    console.log("");
    console.log(
      "=================================================="
    );
    console.log(
      "RÉSULTAT"
    );
    console.log(
      "=================================================="
    );

    console.log(
      `Décisions : ${results.length}`
    );

    console.log(
      `Avec documents : ${documents.length}`
    );

    console.log(
      `PDF téléchargés : ${pdfs}`
    );

    console.log(
      `Fiscales certaines : ${fiscal.length}`
    );

    console.log("");

    console.log(
      "========== FISCALES =========="
    );

    fiscal.forEach(
      (x, i) => {
        console.log(
          `${i + 1}. ${x.date} — ${x.title}`
        );

        console.log(
          `   ${x.url}`
        );

        console.log(
          `   Raisons : ${x.classification.reasons.join(
            ", "
          )}`
        );

        console.log(
          `   Documents : ${x.documents.length}`
        );

        console.log(
          `   PDF : ${x.pdfDocumentsDownloaded}`
        );
      }
    );

    console.log("");
    console.log(
      `Diagnostic : ${RAW_FILE}`
    );
    console.log("");
    console.log(
      "AUCUNE DONNÉE DE PRODUCTION MODIFIÉE."
    );
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error("");
  console.error(
    "=================================================="
  );
  console.error(
    "ERREUR"
  );
  console.error(
    "=================================================="
  );
  console.error(
    error?.stack || error
  );
  process.exit(1);
});
