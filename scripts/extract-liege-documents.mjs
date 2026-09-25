import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import puppeteer from "puppeteer";

const INPUT =
  "tmp/liege-2026-analysis.json";

const OUTPUT =
  "tmp/liege-2026-texts.json";

const CONCURRENCY = 5;

const TIMEOUT = 90000;

const RETRIES = 2;

const PAGE_WAIT = 1800;

const execFileAsync =
  promisify(execFile);

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

function normalizeUrl(
  url,
  baseUrl
) {
  if (!url) return null;

  try {
    return new URL(
      url,
      baseUrl
    ).href;
  } catch {
    return null;
  }
}

function isPdfUrl(url) {
  if (!url) return false;

  const value =
    url.toLowerCase();

  return (
    value.includes(".pdf") ||
    value.includes(
      "application/pdf"
    ) ||
    value.includes(
      "/@@download/"
    ) ||
    value.includes(
      "/download/"
    ) ||
    value.includes(
      "download"
    )
  );
}

function candidateScore(item) {
  const url =
    (item.url || "")
      .toLowerCase();

  const text =
    (item.text || "")
      .toLowerCase();

  let score = 0;

  if (
    url.endsWith(".pdf") ||
    url.includes(".pdf?")
  ) {
    score += 100;
  }

  if (
    url.includes("/@@download/")
  ) {
    score += 90;
  }

  if (
    url.includes("download")
  ) {
    score += 60;
  }

  if (
    url.includes("pdf")
  ) {
    score += 50;
  }

  if (
    url.includes("document")
  ) {
    score += 25;
  }

  if (
    url.includes("preview")
  ) {
    score += 20;
  }

  if (
    text.includes("pdf")
  ) {
    score += 40;
  }

  if (
    text.includes("télécharger") ||
    text.includes("telecharger")
  ) {
    score += 35;
  }

  if (
    text.includes("document")
  ) {
    score += 25;
  }

  if (
    text.includes("délibération") ||
    text.includes("deliberation")
  ) {
    score += 20;
  }

  return score;
}

async function findPdfCandidates(
  page,
  decisionUrl
) {
  const discovered =
    new Map();

  function addCandidate(
    url,
    text,
    source
  ) {
    const normalized =
      normalizeUrl(
        url,
        decisionUrl
      );

    if (!normalized) {
      return;
    }

    if (
      !normalized.startsWith(
        "http://"
      ) &&
      !normalized.startsWith(
        "https://"
      )
    ) {
      return;
    }

    const existing =
      discovered.get(
        normalized
      );

    const item = {
      url: normalized,
      text: text || "",
      source:
        source || "page"
    };

    if (
      !existing ||
      candidateScore(item) >
        candidateScore(existing)
    ) {
      discovered.set(
        normalized,
        item
      );
    }
  }

  /*
   * Si l'URL elle-même est un PDF,
   * aucun besoin de chercher plus loin.
   */
  if (
    isPdfUrl(decisionUrl)
  ) {
    addCandidate(
      decisionUrl,
      "URL directe",
      "decision-url"
    );
  }

  const networkPdfUrls =
    new Set();

  const responseHandler =
    response => {
      try {
        const url =
          response.url();

        const headers =
          response.headers();

        const contentType =
          (
            headers[
              "content-type"
            ] || ""
          ).toLowerCase();

        if (
          contentType.includes(
            "application/pdf"
          ) ||
          isPdfUrl(url)
        ) {
          networkPdfUrls.add(
            url
          );
        }
      } catch {}
    };

  page.on(
    "response",
    responseHandler
  );

  try {
    await page.goto(
      decisionUrl,
      {
        waitUntil:
          "domcontentloaded",
        timeout:
          TIMEOUT
      }
    );
  } catch (error) {
    console.log(
      `      ⚠️ ouverture page : ${error.message}`
    );
  }

  await sleep(
    PAGE_WAIT
  );

  /*
   * Récupération des liens et
   * sources de documents présents
   * dans le DOM.
   */
  const domItems =
    await page.evaluate(() => {
      const items = [];

      const selectors = [
        "a[href]",
        "iframe[src]",
        "embed[src]",
        "object[data]",
        "source[src]",
        "[data-href]",
        "[data-url]",
        "[data-download]"
      ];

      for (
        const selector of selectors
      ) {
        for (
          const element of
            document.querySelectorAll(
              selector
            )
        ) {
          const href =
            element.getAttribute(
              "href"
            ) ||
            element.getAttribute(
              "src"
            ) ||
            element.getAttribute(
              "data"
            ) ||
            element.getAttribute(
              "data-href"
            ) ||
            element.getAttribute(
              "data-url"
            ) ||
            element.getAttribute(
              "data-download"
            );

          if (!href) {
            continue;
          }

          const text =
            (
              element.innerText ||
              element.textContent ||
              ""
            )
              .replace(
                /\s+/g,
                " "
              )
              .trim();

          items.push({
            url: href,
            text
          });
        }
      }

      /*
       * Certains sites mettent l'URL du
       * document directement dans le HTML
       * d'un attribut ou d'un script.
       */
      const html =
        document.documentElement
          ?.outerHTML || "";

      const regex =
        /https?:\/\/[^"'<>\\\s]+/gi;

      const matches =
        html.match(regex) || [];

      for (
        const match of matches
      ) {
        if (
          match.includes(
            ".pdf"
          ) ||
          match.includes(
            "@@download"
          ) ||
          match.includes(
            "/download/"
          )
        ) {
          items.push({
            url: match,
            text: "HTML URL"
          });
        }
      }

      return items;
    });

  for (
    const item of domItems
  ) {
    if (
      isPdfUrl(item.url) ||
      candidateScore(item) >= 20
    ) {
      addCandidate(
        item.url,
        item.text,
        "dom"
      );
    }
  }

  /*
   * Ressources PDF détectées
   * pendant le chargement.
   */
  for (
    const url of networkPdfUrls
  ) {
    addCandidate(
      url,
      "Ressource PDF réseau",
      "network"
    );
  }

  page.off(
    "response",
    responseHandler
  );

  /*
   * On récupère aussi les URLs de
   * ressources chargées par le navigateur.
   */
  const resources =
    await page.evaluate(() => {
      try {
        return performance
          .getEntriesByType(
            "resource"
          )
          .map(
            entry =>
              entry.name
          );
      } catch {
        return [];
      }
    });

  for (
    const resource of resources
  ) {
    if (
      isPdfUrl(resource)
    ) {
      addCandidate(
        resource,
        "Ressource navigateur",
        "performance"
      );
    }
  }

  const candidates =
    [...discovered.values()]
      .sort(
        (a, b) =>
          candidateScore(b) -
          candidateScore(a)
      );

  return candidates;
}

async function downloadPdf(
  page,
  url,
  outputFile
) {
  /*
   * On télécharge depuis le contexte
   * du navigateur afin de conserver les
   * éventuels cookies/session du site.
   */
  const result =
    await page.evaluate(
      async url => {
        const response =
          await fetch(
            url,
            {
              credentials:
                "include"
            }
          );

        const contentType =
          response.headers.get(
            "content-type"
          ) || "";

        const buffer =
          await response.arrayBuffer();

        return {
          ok:
            response.ok,
          status:
            response.status,
          statusText:
            response.statusText,
          contentType,
          data:
            Array.from(
              new Uint8Array(
                buffer
              )
            )
        };
      },
      url
    );

  if (!result.ok) {
    throw new Error(
      `HTTP ${result.status} ${result.statusText}`
    );
  }

  const buffer =
    Buffer.from(
      result.data
    );

  if (
    buffer.length < 5
  ) {
    throw new Error(
      `Réponse vide (${buffer.length} octets)`
    );
  }

  const header =
    buffer
      .subarray(
        0,
        5
      )
      .toString(
        "ascii"
      );

  if (
    header !== "%PDF-"
  ) {
    throw new Error(
      `La ressource n'est pas un PDF (content-type: ${result.contentType}, taille: ${buffer.length})`
    );
  }

  fs.writeFileSync(
    outputFile,
    buffer
  );

  return {
    size:
      buffer.length,
    contentType:
      result.contentType
  };
}

async function extractPdfText(
  pdfFile,
  txtFile
) {
  await execFileAsync(
    "pdftotext",
    [
      "-layout",
      pdfFile,
      txtFile
    ],
    {
      timeout:
        TIMEOUT
    }
  );

  if (
    !fs.existsSync(
      txtFile
    )
  ) {
    throw new Error(
      "pdftotext n'a pas créé le fichier texte"
    );
  }

  const text =
    fs.readFileSync(
      txtFile,
      "utf8"
    );

  return text;
}

async function processDecision(
  page,
  decision
) {
  let candidates = [];

  /*
   * Pour les PDF directs, on évite
   * toute navigation supplémentaire.
   */
  if (
    isPdfUrl(
      decision.url
    )
  ) {
    candidates = [
      {
        url:
          decision.url,
        text:
          "PDF direct",
        source:
          "decision-url"
      }
    ];
  } else {
    candidates =
      await findPdfCandidates(
        page,
        decision.url
      );
  }

  if (
    candidates.length === 0
  ) {
    return {
      ok: false,
      pdfUrl: null,
      pdfSize: 0,
      contentType: null,
      text: "",
      textLength: 0,
      error:
        "Aucun lien PDF/document trouvé sur la page"
    };
  }

  let lastError = null;

  /*
   * On essaie les candidats dans
   * leur ordre de pertinence.
   */
  for (
    const candidate of candidates
  ) {
    for (
      let attempt = 1;
      attempt <=
      RETRIES + 1;
      attempt++
    ) {
      const tempDir =
        fs.mkdtempSync(
          path.join(
            os.tmpdir(),
            "liege-pdf-"
          )
        );

      const pdfFile =
        path.join(
          tempDir,
          "document.pdf"
        );

      const txtFile =
        path.join(
          tempDir,
          "document.txt"
        );

      try {
        const download =
          await downloadPdf(
            page,
            candidate.url,
            pdfFile
          );

        const text =
          await extractPdfText(
            pdfFile,
            txtFile
          );

        const cleanText =
          text
            .replace(
              /\r/g,
              ""
            )
            .replace(
              /\u0000/g,
              ""
            )
            .trim();

        /*
         * PDF valide mais texte vide :
         * on garde l'information comme
         * échec d'extraction textuelle.
         */
        if (
          cleanText.length < 20
        ) {
          throw new Error(
            `PDF lisible mais texte extrait trop court (${cleanText.length} caractères)`
          );
        }

        fs.rmSync(
          tempDir,
          {
            recursive: true,
            force: true
          }
        );

        return {
          ok: true,
          pdfUrl:
            candidate.url,
          pdfSize:
            download.size,
          contentType:
            download.contentType,
          text:
            cleanText,
          textLength:
            cleanText.length
        };
      } catch (error) {
        lastError =
          error;

        console.log(
          `      ⚠️ ${candidate.source} | ${candidate.url} | tentative ${attempt}/${RETRIES + 1} : ${error.message}`
        );

        try {
          fs.rmSync(
            tempDir,
            {
              recursive: true,
              force: true
            }
          );
        } catch {}

        await sleep(
          800
        );
      }
    }
  }

  return {
    ok: false,
    pdfUrl:
      candidates[0]?.url ||
      null,
    pdfSize: 0,
    contentType: null,
    text: "",
    textLength: 0,
    error:
      lastError?.message ||
      "Aucun document exploitable"
  };
}

async function worker(
  browser,
  decisions,
  results,
  workerId
) {
  const page =
    await browser.newPage();

  await page.setDefaultNavigationTimeout(
    TIMEOUT
  );

  try {
    for (;;) {
      const index =
        results.nextIndex++;

      if (
        index >=
        decisions.length
      ) {
        break;
      }

      const decision =
        decisions[index];

      console.log(
        `[Worker ${workerId}] ${index + 1}/${decisions.length} | ${decision.date?.raw || "?"}`
      );

      const result =
        await processDecision(
          page,
          decision
        );

      results.items.push({
        ...decision,

        pdfUrl:
          result.pdfUrl,

        pdfSize:
          result.pdfSize,

        pdfContentType:
          result.contentType,

        text:
          result.text,

        textLength:
          result.textLength,

        extractionOk:
          result.ok,

        extractionError:
          result.error ||
          null
      });

      if (
        result.ok
      ) {
        console.log(
          `   → ✓ PDF OK | ${result.pdfSize} octets | ${result.textLength} caractères`
        );
      } else {
        console.log(
          `   → ❌ ÉCHEC : ${result.error}`
        );
      }
    }
  } finally {
    await page.close();
  }
}

async function main() {
  console.log(
    "=============================================="
  );

  console.log(
    " LIÈGE 2026 - RECHERCHE DES VRAIS DOCUMENTS PDF"
  );

  console.log(
    "=============================================="
  );

  if (
    !fs.existsSync(
      INPUT
    )
  ) {
    throw new Error(
      `Fichier introuvable : ${INPUT}`
    );
  }

  const input =
    JSON.parse(
      fs.readFileSync(
        INPUT,
        "utf8"
      )
    );

  if (
    !Array.isArray(
      input.decisions
    )
  ) {
    throw new Error(
      "Le fichier ne contient pas de tableau 'decisions'."
    );
  }

  const decisions =
    input.decisions.filter(
      decision =>
        decision?.date?.year ===
          2026 &&
        typeof decision.url ===
          "string"
    );

  console.log(
    `Décisions 2026 : ${decisions.length}`
  );

  if (
    decisions.length < 500
  ) {
    throw new Error(
      `Sécurité : seulement ${decisions.length} décisions 2026.`
    );
  }

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

  const results = {
    nextIndex: 0,
    items: []
  };

  try {
    const workers = [];

    for (
      let i = 0;
      i < CONCURRENCY;
      i++
    ) {
      workers.push(
        worker(
          browser,
          decisions,
          results,
          i + 1
        )
      );
    }

    await Promise.all(
      workers
    );
  } finally {
    await browser.close();
  }

  const byUrl =
    new Map(
      results.items.map(
        item => [
          item.url,
          item
        ]
      )
    );

  const ordered =
    decisions.map(
      decision =>
        byUrl.get(
          decision.url
        ) || {
          ...decision,
          pdfUrl: null,
          pdfSize: 0,
          pdfContentType: null,
          text: "",
          textLength: 0,
          extractionOk: false,
          extractionError:
            "Résultat manquant"
        }
    );

  const successful =
    ordered.filter(
      item =>
        item.extractionOk
    );

  const failed =
    ordered.filter(
      item =>
        !item.extractionOk
    );

  const totalCharacters =
    successful.reduce(
      (sum, item) =>
        sum +
        item.textLength,
      0
    );

  console.log("");
  console.log(
    "=============================================="
  );

  console.log(
    " RÉSULTAT EXTRACTION"
  );

  console.log(
    "=============================================="
  );

  console.log(
    `Décisions : ${ordered.length}`
  );

  console.log(
    `PDF/textes OK : ${successful.length}`
  );

  console.log(
    `Échecs : ${failed.length}`
  );

  console.log(
    `Total caractères extraits : ${totalCharacters}`
  );

  if (
    failed.length > 0
  ) {
    console.log("");
    console.log(
      "PREMIERS ÉCHECS :"
    );

    for (
      const item of
        failed.slice(0, 30)
    ) {
      console.log(
        `${item.date?.raw || "?"} | ${item.url}`
      );

      console.log(
        `   ${item.extractionError}`
      );
    }

    if (
      failed.length > 30
    ) {
      console.log(
        `... ${failed.length - 30} autres échecs dans le fichier JSON`
      );
    }
  }

  console.log("");
  console.log(
    "EXEMPLES DE TEXTE EXTRAIT :"
  );

  for (
    const item of
      successful.slice(0, 5)
  ) {
    console.log("");
    console.log(
      item.date?.raw || "?"
    );

    console.log(
      item.url
    );

    console.log(
      `Caractères : ${item.textLength}`
    );

    console.log(
      item.text
        .slice(0, 500)
        .replace(
          /\n+/g,
          " "
        )
    );
  }

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
      2026,

    updatedAt:
      new Date().toISOString(),

    source:
      "https://www.deliberations.be/liege/decisions",

    count:
      ordered.length,

    extractionOk:
      successful.length,

    extractionFailed:
      failed.length,

    totalCharacters,

    decisions:
      ordered
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
    "=============================================="
  );
}

main().catch(
  error => {
    console.error("");
    console.error(
      "❌ ERREUR FATALE"
    );
    console.error(error);
    process.exit(1);
  }
);
