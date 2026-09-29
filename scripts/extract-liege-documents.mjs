import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer";

const INPUT = "tmp/liege-2026-analysis.json";
const OUTPUT = "tmp/liege-2026-texts.json";

const PDF_DIR = "tmp/liege-2026-pdf";
const TEXT_DIR = "tmp/liege-2026-text";

const CONCURRENCY = 3;
const NAVIGATION_TIMEOUT = 60000;
const WAIT_AFTER_LOAD = 1200;

await fs.mkdir(PDF_DIR, { recursive: true });
await fs.mkdir(TEXT_DIR, { recursive: true });

const raw = JSON.parse(await fs.readFile(INPUT, "utf8"));

const decisions = Array.isArray(raw)
  ? raw
  : Array.isArray(raw.decisions)
    ? raw.decisions
    : Array.isArray(raw.items)
      ? raw.items
      : [];

if (!decisions.length) {
  throw new Error(`Aucune décision trouvée dans ${INPUT}`);
}

function safeName(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

function isAllowedHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();

    return (
      host === "www.deliberations.be" ||
      host === "deliberations.be" ||
      host.endsWith(".deliberations.be") ||
      host === "www.liege.be" ||
      host === "liege.be" ||
      host.endsWith(".liege.be")
    );
  } catch {
    return false;
  }
}

function normalizeUrl(url, baseUrl) {
  if (!url) return null;

  try {
    const absolute = new URL(url, baseUrl);

    if (!["http:", "https:"].includes(absolute.protocol)) {
      return null;
    }

    return absolute.href;
  } catch {
    return null;
  }
}

function isSafeLink(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();

    return (
      host.includes("safelinks.protection.outlook.com") ||
      host.includes("safelinks.office.com")
    );
  } catch {
    return false;
  }
}

function looksLikePdfUrl(url) {
  if (!url) return false;

  const lower = url.toLowerCase();

  return (
    lower.includes(".pdf") ||
    lower.includes("/@@download") ||
    lower.includes("application/pdf")
  );
}

function runPdftotext(pdfPath, txtPath) {
  return new Promise((resolve) => {
    const child = spawn(
      "pdftotext",
      ["-layout", pdfPath, txtPath],
      {
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code,
        stderr
      });
    });

    child.on("error", (error) => {
      resolve({
        ok: false,
        code: null,
        stderr: error.message
      });
    });
  });
}

async function downloadPdf(url, outputPath) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36",
        Accept: "application/pdf,*/*"
      }
    });

    if (!response.ok) {
      return {
        ok: false,
        reason: `HTTP ${response.status}`,
        finalUrl: response.url
      };
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (
      buffer.length < 5 ||
      buffer.subarray(0, 5).toString() !== "%PDF-"
    ) {
      return {
        ok: false,
        reason: "Réponse reçue mais ce n'est pas un PDF",
        finalUrl: response.url,
        bytes: buffer.length
      };
    }

    await fs.writeFile(outputPath, buffer);

    return {
      ok: true,
      finalUrl: response.url,
      bytes: buffer.length
    };
  } catch (error) {
    return {
      ok: false,
      reason: error.message
    };
  }
}

async function inspectPage(page, decisionUrl) {
  await page.goto(decisionUrl, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT
  });

  await new Promise((resolve) =>
    setTimeout(resolve, WAIT_AFTER_LOAD)
  );

  const result = await page.evaluate(() => {
    const links = [];

    for (const a of document.querySelectorAll("a[href]")) {
      links.push({
        href: a.href,
        text: (a.innerText || a.textContent || "").trim()
      });
    }

    for (const element of document.querySelectorAll(
      "iframe[src], embed[src], object[data], source[src]"
    )) {
      const url =
        element.getAttribute("src") ||
        element.getAttribute("data");

      if (url) {
        links.push({
          href: url,
          text: ""
        });
      }
    }

    return {
      title: document.title || "",
      pageText: document.body?.innerText || "",
      links
    };
  });

  return result;
}

function findDocumentCandidates(pageResult, decisionUrl) {
  const candidates = [];

  for (const item of pageResult.links || []) {
    const url = normalizeUrl(item.href, decisionUrl);

    if (!url) continue;
    if (isSafeLink(url)) continue;
    if (!isAllowedHost(url)) continue;

    let score = 0;
    const lower = url.toLowerCase();
    const text = String(item.text || "").toLowerCase();

    if (looksLikePdfUrl(url)) score += 100;
    if (lower.includes("/@@download")) score += 80;
    if (lower.includes(".pdf")) score += 80;

    if (
      text.includes("pdf") ||
      text.includes("document") ||
      text.includes("annexe") ||
      text.includes("délibération") ||
      text.includes("decision") ||
      text.includes("ordre du jour")
    ) {
      score += 20;
    }

    if (score > 0) {
      candidates.push({
        url,
        text: item.text || "",
        score
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

async function processDecision(browser, decision, index) {
  const decisionUrl =
    decision.url ||
    decision.decisionUrl ||
    decision.link ||
    "";

  const id =
    safeName(
      decision.id ||
      decision.slug ||
      decision.title ||
      decisionUrl.split("/").pop()
    ) || `decision-${index + 1}`;

  const result = {
    index,
    id,
    title: decision.title || "",
    url: decisionUrl,
    status: null,
    source: null,
    documentUrl: null,
    finalDocumentUrl: null,
    pdfPath: null,
    textPath: null,
    pageText: "",
    pageTextCharacters: 0,
    pdfTextCharacters: 0,
    candidates: [],
    error: null
  };

  if (!decisionUrl) {
    result.status = "NO_URL";
    result.source = "none";
    return result;
  }

  const page = await browser.newPage();

  try {
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

    const pageResult = await inspectPage(page, decisionUrl);

    result.pageText = pageResult.pageText || "";
    result.pageTextCharacters = result.pageText.length;

    result.candidates = findDocumentCandidates(
      pageResult,
      decisionUrl
    );

    // Cas où l'URL de la décision elle-même est un PDF.
    if (looksLikePdfUrl(decisionUrl) && !isSafeLink(decisionUrl)) {
      result.candidates.unshift({
        url: decisionUrl,
        text: "",
        score: 200
      });
    }

    // Tentative PDF réel.
    for (const candidate of result.candidates.slice(0, 10)) {
      const pdfPath = path.join(
        PDF_DIR,
        `${String(index + 1).padStart(4, "0")}-${id}.pdf`
      );

      const download = await downloadPdf(
        candidate.url,
        pdfPath
      );

      if (!download.ok) {
        continue;
      }

      const textPath = path.join(
        TEXT_DIR,
        `${String(index + 1).padStart(4, "0")}-${id}.txt`
      );

      const extraction = await runPdftotext(
        pdfPath,
        textPath
      );

      if (!extraction.ok) {
        continue;
      }

      let pdfText = "";

      try {
        pdfText = await fs.readFile(textPath, "utf8");
      } catch {
        pdfText = "";
      }

      if (!pdfText.trim()) {
        continue;
      }

      result.status = "PDF_OK";
      result.source = "pdf";
      result.documentUrl = candidate.url;
      result.finalDocumentUrl = download.finalUrl;
      result.pdfPath = pdfPath;
      result.textPath = textPath;
      result.pdfTextCharacters = pdfText.length;

      // On garde également le texte de la page comme information complémentaire.
      result.pageText = pageResult.pageText || "";
      result.pageTextCharacters = result.pageText.length;

      return result;
    }

    // Aucun PDF exploitable :
    // le texte réellement rendu de la page devient la source de secours.
    if (result.pageText.trim()) {
      const textPath = path.join(
        TEXT_DIR,
        `${String(index + 1).padStart(4, "0")}-${id}-page.txt`
      );

      await fs.writeFile(
        textPath,
        result.pageText,
        "utf8"
      );

      result.status = "PAGE_TEXT_OK";
      result.source = "page";
      result.textPath = textPath;

      return result;
    }

    result.status = "NO_CONTENT";
    result.source = "none";

    return result;
  } catch (error) {
    result.status = "PAGE_ERROR";
    result.source = "none";
    result.error = error.message;

    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor++;

      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => runner()
    )
  );

  return results;
}

console.log("");
console.log("========================================");
console.log("EXTRACTION DOCUMENTS LIÈGE 2026");
console.log("========================================");
console.log(`Décisions : ${decisions.length}`);
console.log(`Concurrence : ${CONCURRENCY}`);
console.log("");

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage"
  ]
});

let results;

try {
  results = await runPool(
    decisions,
    async (decision, index) => {
      const result = await processDecision(
        browser,
        decision,
        index
      );

      const label =
        result.status === "PDF_OK"
          ? "PDF"
          : result.status === "PAGE_TEXT_OK"
            ? "PAGE"
            : result.status === "NO_CONTENT"
              ? "VIDE"
              : result.status === "PAGE_ERROR"
                ? "ERREUR"
                : result.status;

      console.log(
        `[${String(index + 1).padStart(3, "0")}/${decisions.length}] ${label} - ${result.title || result.url}`
      );

      return result;
    },
    CONCURRENCY
  );
} finally {
  await browser.close();
}

const summary = {
  total: results.length,
  pdfOk: results.filter((r) => r.status === "PDF_OK").length,
  pageTextOk: results.filter((r) => r.status === "PAGE_TEXT_OK").length,
  usable: results.filter(
    (r) =>
      r.status === "PDF_OK" ||
      r.status === "PAGE_TEXT_OK"
  ).length,
  noContent: results.filter(
    (r) => r.status === "NO_CONTENT"
  ).length,
  pageErrors: results.filter(
    (r) => r.status === "PAGE_ERROR"
  ).length,
  noUrl: results.filter(
    (r) => r.status === "NO_URL"
  ).length,
  totalPageTextCharacters: results.reduce(
    (sum, r) => sum + (r.pageTextCharacters || 0),
    0
  ),
  totalPdfTextCharacters: results.reduce(
    (sum, r) => sum + (r.pdfTextCharacters || 0),
    0
  )
};

const output = {
  generatedAt: new Date().toISOString(),
  commune: "Liège",
  year: 2026,
  summary,
  decisions: results
};

await fs.writeFile(
  OUTPUT,
  JSON.stringify(output, null, 2),
  "utf8"
);

console.log("");
console.log("========================================");
console.log("RÉSULTAT");
console.log("========================================");
console.log(`Total : ${summary.total}`);
console.log(`PDF + texte OK : ${summary.pdfOk}`);
console.log(`Texte de page OK : ${summary.pageTextOk}`);
console.log(`Contenu exploitable : ${summary.usable}`);
console.log(`Aucun contenu : ${summary.noContent}`);
console.log(`Erreur page : ${summary.pageErrors}`);
console.log(`URL absente : ${summary.noUrl}`);
console.log(
  `Caractères texte pages : ${summary.totalPageTextCharacters}`
);
console.log(
  `Caractères texte PDF : ${summary.totalPdfTextCharacters}`
);
console.log("");
console.log(`Fichier : ${OUTPUT}`);
console.log("========================================");
