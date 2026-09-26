import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer";

const INPUT = "tmp/liege-2026-analysis.json";
const OUTPUT = "tmp/liege-2026-texts.json";

const TEXT_DIR = "tmp/liege-2026-text";
const PDF_DIR = "tmp/liege-2026-pdf";

const CONCURRENCY = 5;
const NAVIGATION_TIMEOUT = 60000;
const NETWORK_IDLE_TIMEOUT = 30000;

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function log(message) {
  console.log(`[EXTRACT] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFilename(value) {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180);
}

function isPdfUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.pathname.toLowerCase().endsWith(".pdf") ||
      parsed.pathname.toLowerCase().includes("/@@download/")
    );
  } catch {
    return false;
  }
}

function looksLikePdfBuffer(buffer) {
  if (!buffer || buffer.length < 5) {
    return false;
  }

  return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

function runPdftotext(pdfPath, txtPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pdftotext",
      ["-layout", pdfPath, txtPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr,
        });
        return;
      }

      reject(
        new Error(
          `pdftotext terminé avec le code ${code}: ${stderr || stdout}`
        )
      );
    });
  });
}

async function getPageLinks(page, decisionUrl) {
  await page.goto(decisionUrl, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT,
  });

  try {
    await page.waitForNetworkIdle({
      idleTime: 1000,
      timeout: NETWORK_IDLE_TIMEOUT,
    });
  } catch {
    // Certaines pages gardent des connexions ouvertes.
    // Le DOM chargé reste exploitable.
  }

  await sleep(500);

  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]"))
      .map((a) => ({
        href: a.href,
        text: (a.textContent || "").replace(/\s+/g, " ").trim(),
        download:
          a.getAttribute("download") ||
          a.getAttribute("data-download") ||
          "",
      }))
      .filter((link) => link.href);
  });
}

function rankDocumentLinks(links) {
  const candidates = [];

  for (const link of links) {
    const href = link.href;
    const text = link.text || "";
    const lowerHref = href.toLowerCase();
    const lowerText = text.toLowerCase();

    let score = 0;

    if (isPdfUrl(href)) {
      score += 100;
    }

    if (lowerHref.includes(".pdf")) {
      score += 50;
    }

    if (lowerHref.includes("/@@download/")) {
      score += 40;
    }

    if (
      lowerText.includes("pdf") ||
      lowerText.includes("document") ||
      lowerText.includes("annexe") ||
      lowerText.includes("délibération") ||
      lowerText.includes("deliberation") ||
      lowerText.includes("rapport")
    ) {
      score += 20;
    }

    if (link.download) {
      score += 10;
    }

    if (score > 0) {
      candidates.push({
        ...link,
        score,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const seen = new Set();

  return candidates.filter((candidate) => {
    if (seen.has(candidate.href)) {
      return false;
    }

    seen.add(candidate.href);
    return true;
  });
}

async function downloadUrl(url, page) {
  // Cas 1 : l'URL de document peut être récupérée directement.
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "application/pdf,application/octet-stream,text/html;q=0.9,*/*;q=0.8",
      },
    });

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (response.ok && looksLikePdfBuffer(buffer)) {
      return {
        buffer,
        finalUrl: response.url,
        status: response.status,
        method: "fetch",
      };
    }
  } catch {
    // On essaie ensuite avec le navigateur.
  }

  // Cas 2 : téléchargement via le contexte Chromium.
  try {
    const result = await page.evaluate(async (targetUrl) => {
      const response = await fetch(targetUrl, {
        credentials: "include",
      });

      const contentType =
        response.headers.get("content-type") || "";

      const arrayBuffer = await response.arrayBuffer();

      return {
        ok: response.ok,
        status: response.status,
        contentType,
        finalUrl: response.url,
        bytes: Array.from(new Uint8Array(arrayBuffer)),
      };
    }, url);

    const buffer = Buffer.from(result.bytes);

    if (result.ok && looksLikePdfBuffer(buffer)) {
      return {
        buffer,
        finalUrl: result.finalUrl,
        status: result.status,
        method: "browser-fetch",
      };
    }
  } catch {
    // Échec définitif de cette URL.
  }

  return null;
}

async function processDecision(browser, item, index, total) {
  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({
    width: 1440,
    height: 1000,
  });

  const id = String(index + 1).padStart(4, "0");

  try {
    log(`[${index + 1}/${total}] ${item.title || item.url}`);

    const links = await getPageLinks(page, item.url);

    const candidates = rankDocumentLinks(links);

    if (candidates.length === 0) {
      return {
        ...item,
        status: "NO_DOCUMENT_LINK",
        documentUrl: null,
        textFile: null,
        pdfFile: null,
        textLength: 0,
        error: "Aucun lien PDF/document détecté sur la page",
      };
    }

    let downloaded = null;
    let selectedCandidate = null;

    for (const candidate of candidates) {
      log(
        `[${index + 1}/${total}] Test document: ${candidate.href}`
      );

      const result = await downloadUrl(candidate.href, page);

      if (result) {
        downloaded = result;
        selectedCandidate = candidate;
        break;
      }
    }

    if (!downloaded) {
      return {
        ...item,
        status: "DOCUMENT_DOWNLOAD_FAILED",
        documentUrl: candidates[0]?.href || null,
        textFile: null,
        pdfFile: null,
        textLength: 0,
        error:
          `Aucun des ${candidates.length} lien(s) candidat(s) ` +
          `n'a fourni un véritable PDF`,
        candidates: candidates.slice(0, 10),
      };
    }

    const baseName = `${id}-${safeFilename(
      item.title || item.url.split("/").pop() || "decision"
    )}`;

    const pdfPath = path.join(PDF_DIR, `${baseName}.pdf`);
    const txtPath = path.join(TEXT_DIR, `${baseName}.txt`);

    await fs.writeFile(pdfPath, downloaded.buffer);

    if (!looksLikePdfBuffer(downloaded.buffer)) {
      return {
        ...item,
        status: "INVALID_PDF",
        documentUrl: selectedCandidate.href,
        textFile: null,
        pdfFile: null,
        textLength: 0,
        error: "Le fichier téléchargé ne commence pas par %PDF-",
      };
    }

    await runPdftotext(pdfPath, txtPath);

    let text = "";

    try {
      text = await fs.readFile(txtPath, "utf8");
    } catch (error) {
      return {
        ...item,
        status: "TEXT_READ_FAILED",
        documentUrl: selectedCandidate.href,
        textFile: txtPath,
        pdfFile: pdfPath,
        textLength: 0,
        error: error.message,
      };
    }

    text = text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\u0000/g, "")
      .trim();

    await fs.writeFile(txtPath, text, "utf8");

    return {
      ...item,
      status: text.length > 0 ? "OK" : "EMPTY_TEXT",
      documentUrl: selectedCandidate.href,
      documentFinalUrl: downloaded.finalUrl,
      documentText: selectedCandidate.text || "",
      downloadMethod: downloaded.method,
      pdfFile: pdfPath,
      textFile: txtPath,
      textLength: text.length,
      candidateCount: candidates.length,
      error: text.length > 0 ? null : "PDF valide mais texte vide",
    };
  } catch (error) {
    return {
      ...item,
      status: "PAGE_ERROR",
      documentUrl: null,
      textFile: null,
      pdfFile: null,
      textLength: 0,
      error: error?.message || String(error),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function worker(browser, items, results, workerId) {
  while (true) {
    const index = items.nextIndex++;

    if (index >= items.list.length) {
      return;
    }

    const item = items.list[index];

    log(`Worker ${workerId} traite ${index + 1}/${items.list.length}`);

    const result = await processDecision(
      browser,
      item,
      index,
      items.list.length
    );

    results[index] = result;

    if (result.status === "OK") {
      log(
        `OK ${index + 1}/${items.list.length} — ` +
        `${result.textLength} caractères`
      );
    } else {
      log(
        `ATTENTION ${index + 1}/${items.list.length} — ` +
        `${result.status} — ${result.error || ""}`
      );
    }

    // Petite pause pour éviter d'agresser le serveur.
    await sleep(150);
  }
}

async function main() {
  log("========================================");
  log("EXTRACTION DES DOCUMENTS DE LIÈGE 2026");
  log("========================================");

  try {
    await fs.access(INPUT);
  } catch {
    throw new Error(
      `Fichier introuvable: ${INPUT}. ` +
      `Le collecteur scrape-liege-2026-v2.mjs doit être exécuté avant.`
    );
  }

  await fs.mkdir("tmp", { recursive: true });
  await fs.mkdir(TEXT_DIR, { recursive: true });
  await fs.mkdir(PDF_DIR, { recursive: true });

  const raw = await fs.readFile(INPUT, "utf8");
  const data = JSON.parse(raw);

  let decisions;

  if (Array.isArray(data)) {
    decisions = data;
  } else if (Array.isArray(data.decisions)) {
    decisions = data.decisions;
  } else if (Array.isArray(data.items)) {
    decisions = data.items;
  } else {
    throw new Error(
      "Format inattendu dans tmp/liege-2026-analysis.json : " +
      "aucune liste de décisions trouvée."
    );
  }

  const normalized = decisions
    .map((item) => ({
      ...item,
      url: item.url || item.decisionUrl || item.link || null,
      title:
        item.title ||
        item.name ||
        item.subject ||
        item.titre ||
        "",
    }))
    .filter((item) => item.url);

  log(`Décisions à traiter : ${normalized.length}`);

  if (normalized.length === 0) {
    throw new Error("Aucune décision exploitable.");
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const results = new Array(normalized.length);

  const state = {
    list: normalized,
    nextIndex: 0,
  };

  try {
    const workers = [];

    for (
      let workerId = 1;
      workerId <= Math.min(CONCURRENCY, normalized.length);
      workerId++
    ) {
      workers.push(worker(browser, state, results, workerId));
    }

    await Promise.all(workers);
  } finally {
    await browser.close();
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    input: INPUT,
    total: results.length,

    ok: results.filter((x) => x.status === "OK").length,

    emptyText: results.filter((x) => x.status === "EMPTY_TEXT").length,

    noDocumentLink: results.filter(
      (x) => x.status === "NO_DOCUMENT_LINK"
    ).length,

    downloadFailed: results.filter(
      (x) => x.status === "DOCUMENT_DOWNLOAD_FAILED"
    ).length,

    invalidPdf: results.filter(
      (x) => x.status === "INVALID_PDF"
    ).length,

    pageErrors: results.filter(
      (x) => x.status === "PAGE_ERROR"
    ).length,

    textReadFailed: results.filter(
      (x) => x.status === "TEXT_READ_FAILED"
    ).length,

    totalCharacters: results.reduce(
      (sum, x) => sum + (x.textLength || 0),
      0
    ),
  };

  const output = {
    summary,
    decisions: results,
  };

  await fs.writeFile(
    OUTPUT,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  log("========================================");
  log("EXTRACTION TERMINÉE");
  log("========================================");
  log(`Total : ${summary.total}`);
  log(`PDF + texte OK : ${summary.ok}`);
  log(`Texte vide : ${summary.emptyText}`);
  log(`Aucun lien document : ${summary.noDocumentLink}`);
  log(`Téléchargement échoué : ${summary.downloadFailed}`);
  log(`PDF invalide : ${summary.invalidPdf}`);
  log(`Erreur page : ${summary.pageErrors}`);
  log(`Erreur lecture texte : ${summary.textReadFailed}`);
  log(`Total caractères : ${summary.totalCharacters}`);
  log(`Résultat : ${OUTPUT}`);
  log("========================================");

  // On ne modifie volontairement PAS src/data/reglements-taxes.json.
}

main().catch((error) => {
  console.error("");
  console.error("ERREUR FATALE :", error);
  console.error("");
  process.exit(1);
});
