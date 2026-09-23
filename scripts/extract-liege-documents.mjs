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

function isUsefulDocumentLink(url, text = "") {
  if (!url) return false;

  const lowerUrl = url.toLowerCase();
  const lowerText = text.toLowerCase();

  // PDF directs
  if (lowerUrl.includes(".pdf")) return true;

  // Liens de téléchargement / documents
  const urlSignals = [
    "download",
    "document",
    "attachment",
    "file",
    "fichier",
    "telecharg",
    "download_file",
    "view_document"
  ];

  if (urlSignals.some(signal => lowerUrl.includes(signal))) {
    return true;
  }

  // Texte du lien
  const textSignals = [
    "pdf",
    "document",
    "annexe",
    "annexes",
    "télécharger",
    "telecharger",
    "pièce",
    "piece",
    "rapport",
    "règlement",
    "reglement",
    "projet",
    "note",
    "délibération",
    "deliberation"
  ];

  if (textSignals.some(signal => lowerText.includes(signal))) {
    return true;
  }

  return false;
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

      for (const link of result.links) {
        const absolute = absoluteUrl(link.href, decision.url);

        if (!absolute) continue;

        if (isUsefulDocumentLink(absolute, link.text)) {
          documents.push({
            url: absolute,
            text: link.text
          });
        }
      }

      // Déduplication
      const uniqueDocuments = [];
      const seen = new Set();

      for (const doc of documents) {
        if (!seen.has(doc.url)) {
          seen.add(doc.url);
          uniqueDocuments.push(doc);
        }
      }

      return {
        ok: true,
        title: result.title,
        documents: uniqueDocuments
      };

    } catch (error) {
      lastError = error;

      console.log(
        `   ⚠️ Erreur tentative ${attempt}/${RETRIES + 1}: ${error.message}`
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
      `[Worker ${workerId}] ${index + 1}/${decisions.length} | ${decision.date?.raw || "date inconnue"} | ${decision.url}`
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

    if (extracted.ok) {
      console.log(
        `   → ${extracted.documents.length} lien(s) document(s) trouvé(s)`
      );
    } else {
      console.log(`   → ❌ échec`);
    }
  }

  await page.close();
}

async function main() {
  console.log("==============================================");
  console.log(" EXTRACTION DES DOCUMENTS - LIÈGE 2026");
  console.log("==============================================");

  if (!fs.existsSync(INPUT)) {
    throw new Error(
      `Fichier introuvable : ${INPUT}`
    );
  }

  const input = JSON.parse(
    fs.readFileSync(INPUT, "utf8")
  );

  if (!Array.isArray(input.decisions)) {
    throw new Error(
      "Le fichier d'entrée ne contient pas de tableau 'decisions'."
    );
  }

  const decisions = input.decisions.filter(
    decision =>
      decision?.date?.year === 2026 &&
      typeof decision.url === "string"
  );

  console.log(`Décisions 2026 à analyser : ${decisions.length}`);

  if (decisions.length < 500) {
    throw new Error(
      `Sécurité : seulement ${decisions.length} décisions 2026 trouvées.`
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
        worker(browser, decisions, results, i + 1)
      );
    }

    await Promise.all(workers);

  } finally {
    await browser.close();
  }

  // Remettre les résultats dans l'ordre original
  const byUrl = new Map(
    results.items.map(item => [item.url, item])
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

  console.log("");
  console.log("==============================================");
  console.log(" RÉSULTAT");
  console.log("==============================================");
  console.log(`Décisions analysées      : ${ordered.length}`);
  console.log(`Avec document(s)         : ${withDocuments.length}`);
  console.log(`Sans document détecté    : ${withoutDocuments.length}`);
  console.log(`Pages en erreur          : ${failed.length}`);

  console.log("");
  console.log("Exemples avec documents :");

  for (const item of withDocuments.slice(0, 20)) {
    console.log("");
    console.log(`DATE : ${item.date?.raw}`);
    console.log(`URL  : ${item.url}`);

    for (const doc of item.documents) {
      console.log(`  → ${doc.text || "(sans texte)"}`);
      console.log(`    ${doc.url}`);
    }
  }

  console.log("");
  console.log("Exemples sans document :");

  for (const item of withoutDocuments.slice(0, 20)) {
    console.log(
      `- ${item.date?.raw || "?"} | ${item.url}`
    );
  }

  fs.mkdirSync(path.dirname(OUTPUT), {
    recursive: true
  });

  const output = {
    commune: "Liège",
    annee: 2026,
    updatedAt: new Date().toISOString(),
    source: "https://www.deliberations.be/liege/decisions",
    count: ordered.length,
    withDocuments: withDocuments.length,
    withoutDocuments: withoutDocuments.length,
    failedPages: failed.length,
    decisions: ordered
  };

  fs.writeFileSync(
    OUTPUT,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log("");
  console.log(`Fichier créé : ${OUTPUT}`);
  console.log("==============================================");
}

main().catch(error => {
  console.error("");
  console.error("❌ ERREUR FATALE");
  console.error(error);
  process.exit(1);
});
