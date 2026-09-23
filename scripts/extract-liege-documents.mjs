import fs from "fs";
import path from "path";
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
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

function isDirectPdfUrl(url) {
  if (!url) return false;

  const clean = url.toLowerCase();

  return (
    clean.endsWith(".pdf") ||
    clean.includes(".pdf?")
  );
}

function buildPdfUrl(decisionUrl) {
  /*
   * Si l'URL de la décision est déjà un PDF,
   * on utilise directement cette URL.
   */
  if (isDirectPdfUrl(decisionUrl)) {
    return normalizeUrl(decisionUrl);
  }

  /*
   * Sinon deliberations.be utilise cette structure
   * pour le PDF de la délibération.
   */
  return normalizeUrl(
    decisionUrl.replace(/\/+$/, "") +
      "/deliberation-pdf-preview/@@download/file/deliberation-pdf-preview.pdf"
  );
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

  const contentType =
    response.headers.get("content-type") || "";

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  /*
   * Vérification très importante :
   * un vrai PDF commence par %PDF.
   */
  const header = buffer
    .subarray(0, 5)
    .toString("ascii");

  if (header !== "%PDF-") {
    throw new Error(
      `Le fichier téléchargé n'est pas un PDF (content-type: ${contentType}, taille: ${buffer.length})`
    );
  }

  fs.writeFileSync(
    outputFile,
    buffer
  );

  return {
    size: buffer.length,
    contentType
  };
}

async function extractPdfText(pdfFile, txtFile) {
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
      "pdftotext n'a pas créé le fichier texte"
    );
  }

  const text = fs.readFileSync(
    txtFile,
    "utf8"
  );

  return text;
}

async function processDecision(decision) {
  const pdfUrl = buildPdfUrl(
    decision.url
  );

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= RETRIES + 1;
    attempt++
  ) {
    const tempDir = fs.mkdtempSync(
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
      const download = await downloadPdf(
        pdfUrl,
        pdfFile
      );

      const text =
        await extractPdfText(
          pdfFile,
          txtFile
        );

      const cleanText = text
        .replace(/\r/g, "")
        .replace(/\u0000/g, "")
        .trim();

      if (cleanText.length < 20) {
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
        pdfUrl,
        pdfSize: download.size,
        contentType: download.contentType,
        text: cleanText,
        textLength: cleanText.length
      };

    } catch (error) {
      lastError = error;

      console.log(
        `      ⚠️ tentative ${attempt}/${RETRIES + 1} : ${error.message}`
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

      await sleep(1500);
    }
  }

  return {
    ok: false,
    pdfUrl,
    pdfSize: 0,
    contentType: null,
    text: "",
    textLength: 0,
    error:
      lastError?.message ||
      "Erreur inconnue"
  };
}

async function worker(
  decisions,
  results,
  workerId
) {
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
        result.error || null
    });

    if (result.ok) {
      console.log(
        `   → PDF OK | ${result.pdfSize} octets | ${result.textLength} caractères`
      );
    } else {
      console.log(
        `   → ❌ ÉCHEC : ${result.error}`
      );
    }
  }
}

async function main() {
  console.log(
    "=============================================="
  );

  console.log(
    " LIÈGE 2026 - TÉLÉCHARGEMENT ET EXTRACTION PDF"
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
        decision?.date?.year === 2026 &&
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

  const results = {
    nextIndex: 0,
    items: []
  };

  const workers = [];

  for (
    let i = 0;
    i < CONCURRENCY;
    i++
  ) {
    workers.push(
      worker(
        decisions,
        results,
        i + 1
      )
    );
  }

  await Promise.all(
    workers
  );

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
          pdfUrl:
            buildPdfUrl(
              decision.url
            ),
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

  if (failed.length > 0) {
    console.log("");
    console.log(
      "DÉCISIONS EN ÉCHEC :"
    );

    for (
      const item of failed
    ) {
      console.log(
        `${item.date?.raw || "?"} | ${item.url}`
      );

      console.log(
        `   ${item.extractionError}`
      );
    }
  }

  console.log("");
  console.log(
    "EXEMPLES DE TEXTE EXTRAIT :"
  );

  for (
    const item of successful.slice(
      0,
      5
    )
  ) {
    console.log("");
    console.log(
      `${item.date?.raw || "?"}`
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
        .replace(/\n+/g, " ")
    );
  }

  fs.mkdirSync(
    path.dirname(OUTPUT),
    {
      recursive: true
    }
  );

  const output = {
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
    `Fichier créé : ${OUTPUT}`
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
