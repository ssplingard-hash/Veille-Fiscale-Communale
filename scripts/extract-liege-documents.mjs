import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const INPUT = "tmp/liege-2026-analysis.json";
const OUTPUT = "tmp/liege-2026-documents.json";

const CONCURRENCY = 5;
const TIMEOUT = 60000;
const RETRIES = 2;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
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

function isPdfUrl(url) {
  if (!url) return false;

  const clean = url.toLowerCase();

  return (
    clean.includes(".pdf") ||
    clean.includes("/@@download/") ||
    clean.includes("deliberation-pdf-preview")
  );
}

function isDocumentLikeUrl(url) {
  if (!url) return false;

  const clean = url.toLowerCase();

  return (
    isPdfUrl(clean) ||
    clean.includes("/document") ||
    clean.includes("/attachment") ||
    clean.includes("/annexe") ||
    clean.includes("/annexes") ||
    clean.includes("/download") ||
    clean.includes("/fichier") ||
    clean.includes("/piece-jointe") ||
    clean.includes("/piecejointe")
  );
}

function buildStandardPdfUrl(decisionUrl) {
  return (
    decisionUrl.replace(/\/+$/, "") +
    "/deliberation-pdf-preview/@@download/file/deliberation-pdf-preview.pdf"
  );
}

async function extractPage(page, decision) {
  let lastError = null;

  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    try {
      await page.goto(decision.url, {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUT
      });

      await sleep(1200);

      const result = await page.evaluate(() => {
        const links = [];

        for (const a of document.querySelectorAll("a[href]")) {
          const href = a.getAttribute("href");
          const text = (a.innerText || a.textContent || "")
            .replace(/\s+/g, " ")
            .trim();

          if (href) {
            links.push({
              href,
              text
            });
          }
        }

        return {
          title: document.title || "",
          links
        };
      });

      const documents = [];
      const seen = new Set();

      for (const link of result.links) {
        const absolute = normalizeUrl(
          absoluteUrl(link.href, decision.url)
        );

        if (!absolute) continue;

        if (!isDocumentLikeUrl(absolute)) continue;

        if (seen.has(absolute)) continue;

        seen.add(absolute);

        documents.push({
          url: absolute,
          text: link.text || "",
          type: isPdfUrl(absolute) ? "pdf" : "document"
        });
      }

      /*
       * IMPORTANT :
       * deliberations.be utilise une URL standard pour le PDF
       * de la délibération.
       *
       * On ajoute donc cette URL même lorsqu'elle n'apparaît
       * pas explicitement dans les liens HTML.
       */
      const standardPdf = normalizeUrl(
        buildStandardPdfUrl(decision.url)
      );

      if (
        standardPdf &&
        !seen.has(standardPdf)
      ) {
        documents.unshift({
          url: standardPdf,
          text: "PDF de la délibération",
          type: "pdf",
          source: "standard-url"
        });
      }

      return {
        ok: true,
        title: result.title,
        documents
      };

    } catch (error) {
      lastError = error;

      console.log(
        `   ⚠️ Tentative ${attempt}/${RETRIES + 1} : ${error.message}`
      );

      await sleep(1500);
    }
  }

  return {
    ok: false,
    error: lastError?.message || "Erreur inconnue",
    documents: []
  };
}

async function worker(browser, decisions, results, workerId) {
  const page = await browser.newPage();

  await page.setDefaultNavigationTimeout(TIMEOUT);
  await page.setDefaultTimeout(TIMEOUT);

  for (;;) {
    const index = results.nextIndex++;

    if (index >= decisions.length) break;

    const decision = decisions[index];

    console.log(
      `[Worker ${workerId}] ${index + 1}/${decisions.length} | ${decision.date?.raw || "?"}`
    );

    const extracted = await extractPage(page, decision);

    results.items.push({
      ...decision,
      pageTitle: extracted.title || null,
      documents: extracted.documents,
      documentCount: extracted.documents.length,
      extractionOk: extracted.ok,
      extractionError: extracted.error || null
    });

    console.log(
      `   → ${extracted.documents.length} document(s)`
    );
  }

  await page.close();
}

async function main() {
  console.log("==============================================");
  console.log(" LIÈGE 2026 - RÉCUPÉRATION DES DOCUMENTS");
  console.log("==============================================");

  if (!fs.existsSync(INPUT)) {
    throw new Error(`Fichier introuvable : ${INPUT}`);
  }

  const input = JSON.parse(
    fs.readFileSync(INPUT, "utf8")
  );

  if (!Array.isArray(input.decisions)) {
    throw new Error(
      "Le fichier d'entrée ne contient pas 'decisions'."
    );
  }

  const decisions = input.decisions.filter(
    decision =>
      decision?.date?.year === 2026 &&
      typeof decision.url === "string"
  );

  console.log(
    `Décisions 2026 à analyser : ${decisions.length}`
  );

  if (decisions.length < 500) {
    throw new Error(
      `Sécurité : seulement ${decisions.length} décisions 2026.`
    );
  }

  const browser = await puppeteer.launch({
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

    for (let i = 0; i < CONCURRENCY; i++) {
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

  const byUrl = new Map(
    results.items.map(item => [
      item.url,
      item
    ])
  );

  const ordered = decisions.map(decision =>
    byUrl.get(decision.url) || {
      ...decision,
      pageTitle: null,
      documents: [],
      documentCount: 0,
      extractionOk: false,
      extractionError: "Résultat manquant"
    }
  );

  const withDocuments = ordered.filter(
    item => item.documentCount > 0
  );

  const withoutDocuments = ordered.filter(
    item => item.documentCount === 0
  );

  const failed = ordered.filter(
    item => !item.extractionOk
  );

  const pdfCount = ordered.filter(
    item =>
      item.documents.some(
        document => document.type === "pdf"
      )
  ).length;

  console.log("");
  console.log("==============================================");
  console.log(" RÉSULTAT");
  console.log("==============================================");

  console.log(
    `Décisions analysées : ${ordered.length}`
  );

  console.log(
    `Avec document(s) : ${withDocuments.length}`
  );

  console.log(
    `Sans document : ${withoutDocuments.length}`
  );

  console.log(
    `Avec PDF : ${pdfCount}`
  );

  console.log(
    `Pages en erreur : ${failed.length}`
  );

  console.log("");
  console.log("Exemples de PDF trouvés :");

  let displayed = 0;

  for (const item of ordered) {
    for (const document of item.documents) {
      if (document.type !== "pdf") continue;

      console.log("");
      console.log(
        `${item.date?.raw || "?"}`
      );

      console.log(
        item.url
      );

      console.log(
        `→ ${document.url}`
      );

      displayed++;

      if (displayed >= 20) break;
    }

    if (displayed >= 20) break;
  }

  fs.mkdirSync(
    path.dirname(OUTPUT),
    { recursive: true }
  );

  const output = {
    commune: "Liège",
    annee: 2026,
    updatedAt: new Date().toISOString(),
    source:
      "https://www.deliberations.be/liege/decisions",

    count: ordered.length,

    withDocuments:
      withDocuments.length,

    withoutDocuments:
      withoutDocuments.length,

    withPdf:
      pdfCount,

    failedPages:
      failed.length,

    decisions:
      ordered
  };

  fs.writeFileSync(
    OUTPUT,
    JSON.stringify(output, null, 2),
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

main().catch(error => {
  console.error("");
  console.error("❌ ERREUR FATALE");
  console.error(error);
  process.exit(1);
});
