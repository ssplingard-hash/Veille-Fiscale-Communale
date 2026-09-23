import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const INPUT = "tmp/liege-2026-analysis.json";
const OUTPUT = "tmp/liege-2026-texts.json";

const CONCURRENCY = 5;
const TIMEOUT = 90000;
const RETRIES = 2;

const execFileAsync = promisify(execFile);

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

function isPdf(url) {
  if (!url) return false;

  const value = url.toLowerCase();

  return (
    value.includes(".pdf") ||
    value.includes("application/pdf") ||
    value.includes("/@@download/")
  );
}

async function findPdfOnPage(page, decisionUrl) {
  await page.goto(decisionUrl, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT
  });

  await sleep(1500);

  const links = await page.evaluate(() => {
    const result = [];

    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href || a.getAttribute("href");
      const text = (
        a.innerText ||
        a.textContent ||
        ""
      ).replace(/\s+/g, " ").trim();

      if (href) {
        result.push({
          href,
          text
        });
      }
    }

    return result;
  });

  const candidates = [];

  for (const link of links) {
    const url = normalizeUrl(link.href);

    if (!url) continue;

    if (isPdf(url)) {
      candidates.push({
        url,
        text: link.text || ""
      });
    }
  }

  /*
   * Si la page elle-même est un PDF.
   */
  if (isPdf(decisionUrl)) {
    candidates.unshift({
      url: normalizeUrl(decisionUrl),
      text: "PDF décision"
    });
  }

  /*
   * Déduplication.
   */
  const unique = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (!seen.has(candidate.url)) {
      seen.add(candidate.url);
      unique.push(candidate);
    }
  }

  return unique;
}

async function downloadPdf(url, outputFile) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT)
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  const header = buffer
    .subarray(0, 5)
    .toString("ascii");

  if (header !== "%PDF-") {
    throw new Error(
      `Réponse reçue mais ce n'est pas un PDF (${buffer.length} octets)`
    );
  }

  fs.writeFileSync(outputFile, buffer);

  return buffer.length;
}

async function extractText(pdfFile, txtFile) {
  await execFileAsync(
    "pdftotext",
    [
      "-layout",
      pdfFile,
      txtFile
    ],
    {
      timeout: TIMEOUT
    }
  );

  if (!fs.existsSync(txtFile)) {
    throw new Error(
      "pdftotext n'a pas produit de fichier"
    );
  }

  return fs.readFileSync(
    txtFile,
    "utf8"
  )
    .replace(/\r/g, "")
    .replace(/\u0000/g, "")
    .trim();
}

async function processDecision(page, decision) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= RETRIES + 1;
    attempt++
  ) {
    let tempDir = null;

    try {
      console.log(
        `      Recherche du PDF sur la page...`
      );

      const pdfs =
        await findPdfOnPage(
          page,
          decision.url
        );

      if (pdfs.length === 0) {
        throw new Error(
          "Aucun lien PDF trouvé sur la page"
        );
      }

      console.log(
        `      ${pdfs.length} PDF trouvé(s)`
      );

      /*
       * On essaie les PDF dans l'ordre.
       * Le premier PDF réellement lisible est conservé.
       */
      for (const pdf of pdfs) {
        tempDir = fs.mkdtempSync(
          path.join(
            os.tmpdir(),
            "liege-pdf-"
          )
        );

        const pdfFile = path.join(
          tempDir,
          "document.pdf"
        );

        const txtFile = path.join(
          tempDir,
          "document.txt"
        );

        try {
          const size =
            await downloadPdf(
              pdf.url,
              pdfFile
            );

          const text =
            await extractText(
              pdfFile,
              txtFile
            );

          if (text.length < 20) {
            throw new Error(
              `Texte trop court (${text.length} caractères)`
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
            pdfUrl: pdf.url,
            pdfText: text,
            textLength: text.length,
            pdfSize: size
          };

        } catch (pdfError) {
          console.log(
            `      ⚠️ PDF ignoré : ${pdfError.message}`
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

          tempDir = null;
        }
      }

      throw new Error(
        "Les PDF trouvés ne sont pas exploitables"
      );

    } catch (error) {
      lastError = error;

      console.log(
        `      ⚠️ Tentative ${attempt}/${RETRIES + 1} : ${error.message}`
      );

      if (tempDir) {
        try {
          fs.rmSync(
            tempDir,
            {
              recursive: true,
              force: true
            }
          );
        } catch {}
      }

      await sleep(1500);
    }
  }

  return {
    ok: false,
    pdfUrl: null,
    pdfText: "",
    textLength: 0,
    pdfSize: 0,
    error:
      lastError?.message ||
      "Erreur inconnue"
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

  for (;;) {
    const index =
      results.nextIndex++;

    if (
      index >= decisions.length
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

      text:
        result.pdfText,

      textLength:
        result.textLength,

      extractionOk:
        result.ok,

      extractionError:
        result.error || null
    });

    if (result.ok) {
      console.log(
        `      ✓ PDF OK | ${result.pdfSize} octets | ${result.textLength} caractères`
      );
    } else {
      console.log(
        `      ❌ ÉCHEC : ${result.error}`
      );
    }
  }

  await page.close();
}

async function main() {
  console.log(
    "=============================================="
  );
  console.log(
    " LIÈGE 2026 - PDF RÉEL + EXTRACTION"
  );
  console.log(
    "=============================================="
  );

  if (!fs.existsSync(INPUT)) {
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

  const decisions =
    input.decisions.filter(
      decision =>
        decision?.date?.year === 2026 &&
        typeof decision.url === "string"
    );

  console.log(
    `Décisions 2026 : ${decisions.length}`
  );

  if (decisions.length < 500) {
    throw new Error(
      `Sécurité : seulement ${decisions.length} décisions`
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

    await Promise.all(workers);

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
        sum + item.textLength,
      0
    );

  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    " RÉSULTAT"
  );
  console.log(
    "=============================================="
  );

  console.log(
    `Décisions : ${ordered.length}`
  );

  console.log(
    `PDF + texte OK : ${successful.length}`
  );

  console.log(
    `Échecs : ${failed.length}`
  );

  console.log(
    `Caractères extraits : ${totalCharacters}`
  );

  console.log("");
  console.log(
    "PREMIERS DOCUMENTS RÉUSSIS :"
  );

  for (
    const item of successful.slice(0, 10)
  ) {
    console.log("");
    console.log(
      item.date?.raw
    );
    console.log(
      item.url
    );
    console.log(
      `PDF : ${item.pdfUrl}`
    );
    console.log(
      `Texte : ${item.textLength} caractères`
    );
    console.log(
      item.text
        .slice(0, 300)
        .replace(/\n+/g, " ")
    );
  }

  if (failed.length > 0) {
    console.log("");
    console.log(
      "PREMIERS ÉCHECS :"
    );

    for (
      const item of failed.slice(0, 30)
    ) {
      console.log(
        `${item.date?.raw || "?"} | ${item.url}`
      );
      console.log(
        `   ${item.extractionError}`
      );
    }
  }

  fs.mkdirSync(
    path.dirname(OUTPUT),
    {
      recursive: true
    }
  );

  fs.writeFileSync(
    OUTPUT,
    JSON.stringify(
      {
        commune: "Liège",
        annee: 2026,
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
      },
      null,
      2
    ),
    "utf8"
  );

  console.log("");
  console.log(
    `Fichier créé : ${OUTPUT}`
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
