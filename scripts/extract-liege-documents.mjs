
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

function log(message) {
  console.log(`[LIEGE-EXTRACT] ${message}`);
}

function clean(value = "") {
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeFilename(value) {
  return String(value || "decision")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "decision";
}

function isAllowedHost(hostname) {
  const host = hostname.toLowerCase();

  return (
    host === "deliberations.be" ||
    host.endsWith(".deliberations.be") ||
    host === "liege.be" ||
    host.endsWith(".liege.be")
  );
}

function normalizeUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    url.hash = "";

    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function isPdf(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString("ascii") === "%PDF-"
  );
}

function runPdftotext(pdfPath, txtPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pdftotext",
      ["-layout", pdfPath, txtPath],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `pdftotext code ${code}: ${stderr}`
          )
        );
      }
    });
  });
}

/*
 * Collecte les liens présents dans le DOM :
 * - liens HTML ;
 * - iframes ;
 * - objets et embeds ;
 * - attributs de téléchargement.
 *
 * Les URL externes, notamment Microsoft SafeLinks,
 * sont exclues des candidats documentaires.
 */
async function inspectPage(page, decisionUrl) {
  const response = await page.goto(decisionUrl, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT
  });

  try {
    await page.waitForNetworkIdle({
      idleTime: 800,
      timeout: 10000
    });
  } catch {
    // Certaines connexions restent ouvertes.
  }

  await new Promise(resolve =>
    setTimeout(resolve, WAIT_AFTER_LOAD)
  );

  const pageData = await page.evaluate(() => {
    const bodyText = document.body?.innerText || "";

    const selectors = [
      "a[href]",
      "iframe[src]",
      "embed[src]",
      "object[data]",
      "source[src]",
      "[data-href]",
      "[data-url]",
      "[data-download-url]",
      "[data-file-url]"
    ].join(",");

    const elements = Array.from(
      document.querySelectorAll(selectors)
    );

    const links = elements.map(element => {
      const rawUrl =
        element.getAttribute("href") ||
        element.getAttribute("src") ||
        element.getAttribute("data") ||
        element.getAttribute("data-href") ||
        element.getAttribute("data-url") ||
        element.getAttribute("data-download-url") ||
        element.getAttribute("data-file-url") ||
        "";

      return {
        url: rawUrl,
        text: (
          element.innerText ||
          element.textContent ||
          element.getAttribute("title") ||
          element.getAttribute("aria-label") ||
          ""
        ).replace(/\s+/g, " ").trim(),
        download:
          element.getAttribute("download") || "",
        tag: element.tagName.toLowerCase()
      };
    }).filter(item => item.url);

    return {
      pageTitle: document.title || "",
      pageText: bodyText.slice(0, 150000),
      links
    };
  });

  return {
    httpStatus: response?.status() ?? null,
    finalPageUrl: page.url(),
    ...pageData
  };
}

/*
 * Sélectionne uniquement des liens documentaires plausibles.
 * La présence d'un mot-clé ne suffit pas à valider un PDF :
 * le téléchargement sera ensuite contrôlé octet par octet.
 */
function findDocumentCandidates(links, pageUrl) {
  const candidates = [];
  const seen = new Set();

  for (const link of links) {
    const url = normalizeUrl(link.url, pageUrl);

    if (!url) continue;

    let parsed;

    try {
      parsed = new URL(url);
    } catch {
      continue;
    }

    // Ne jamais télécharger une URL Microsoft SafeLinks.
    if (!isAllowedHost(parsed.hostname)) {
      continue;
    }

    const pathname = parsed.pathname.toLowerCase();
    const text = clean(link.text).toLowerCase();

    let score = 0;

    if (pathname.endsWith(".pdf")) score += 100;
    if (pathname.includes("/@@download/")) score += 90;
    if (pathname.includes("/download")) score += 60;

    if (
      text.includes("pdf") ||
      text.includes("document") ||
      text.includes("annexe") ||
      text.includes("rapport") ||
      text.includes("télécharger") ||
      text.includes("telecharger")
    ) {
      score += 25;
    }

    if (link.download) score += 20;

    if (
      link.tag === "iframe" ||
      link.tag === "embed" ||
      link.tag === "object"
    ) {
      score += 30;
    }

    if (score < 25) continue;
    if (seen.has(url)) continue;

    seen.add(url);

    candidates.push({
      url,
      text: link.text,
      score
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/*
 * Télécharge une URL et ne l'accepte que si le contenu
 * commence réellement par la signature d'un PDF.
 */
async function downloadPdf(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) " +
          "AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/pdf,application/octet-stream,*/*"
      }
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status}`
      };
    }

    const finalUrl = response.url;

    // Refuser toute redirection vers un domaine extérieur.
    const finalHost = new URL(finalUrl).hostname;

    if (!isAllowedHost(finalHost)) {
      return {
        ok: false,
        error: "Redirection vers un domaine externe"
      };
    }

    const buffer = Buffer.from(
      await response.arrayBuffer()
    );

    if (!isPdf(buffer)) {
      return {
        ok: false,
        error:
          "Le contenu reçu n'est pas un PDF valide"
      };
    }

    return {
      ok: true,
      buffer,
      finalUrl
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

async function processDecision(
  browser,
  decision,
  index,
  total
) {
  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

  const decisionUrl =
    decision.url ||
    decision.decisionUrl ||
    decision.link;

  const id = String(index + 1).padStart(4, "0");

  try {
    if (!decisionUrl) {
      return {
        url: null,
        status: "INVALID_DECISION_URL",
        error: "URL de décision absente"
      };
    }

    log(`[${index + 1}/${total}] ${decisionUrl}`);

    const inspected = await inspectPage(page, decisionUrl);

    const candidates = findDocumentCandidates(
      inspected.links,
      inspected.finalPageUrl || decisionUrl
    );

    const baseName =
      `${id}-${safeFilename(
        decision.title ||
        inspected.pageTitle ||
        decisionUrl.split("/").pop()
      )}`;

    const debugLinks = inspected.links
      .map(link => ({
        ...link,
        url: normalizeUrl(
          link.url,
          inspected.finalPageUrl || decisionUrl
        )
      }))
      .filter(link => link.url)
      .slice(0, 60);

    let successfulPdf = null;
    let selectedCandidate = null;
    const downloadErrors = [];

    for (const candidate of candidates) {
      log(
        `[${index + 1}/${total}] Essai document : ${candidate.url}`
      );

      const result = await downloadPdf(candidate.url);

      if (result.ok) {
        successfulPdf = result;
        selectedCandidate = candidate;
        break;
      }

      downloadErrors.push({
        url: candidate.url,
        error: result.error
      });
    }

    if (successfulPdf) {
      const pdfPath = path.join(
        PDF_DIR,
        `${baseName}.pdf`
      );

      const txtPath = path.join(
        TEXT_DIR,
        `${baseName}.txt`
      );

      await fs.writeFile(
        pdfPath,
        successfulPdf.buffer
      );

      await runPdftotext(pdfPath, txtPath);

      const extractedText = clean(
        await fs.readFile(txtPath, "utf8")
      );

      const status = extractedText
        ? "OK"
        : "EMPTY_TEXT";

      log(
        `[${index + 1}/${total}] ${status} ` +
        `PDF ; texte=${extractedText.length}`
      );

      return {
        url: decisionUrl,
        title: inspected.pageTitle || decision.title || "",
        httpStatus: inspected.httpStatus,
        status,
        documentUrl: selectedCandidate.url,
        documentFinalUrl: successfulPdf.finalUrl,
        documentText: selectedCandidate.text,
        pdfFile: pdfPath,
        textFile: txtPath,
        textLength: extractedText.length,
        pageText: inspected.pageText,
        pageTextLength: inspected.pageText.length,
        candidateCount: candidates.length,
        debugLinks,
        downloadErrors,
        error: extractedText
          ? null
          : "PDF valide mais texte vide"
      };
    }

    const status = candidates.length
      ? "DOCUMENT_DOWNLOAD_FAILED"
      : "NO_DOCUMENT_LINK";

    log(
      `[${index + 1}/${total}] ${status} ; ` +
      `liens candidats=${candidates.length} ; ` +
      `texte page=${inspected.pageText.length}`
    );

    return {
      url: decisionUrl,
      title: inspected.pageTitle || decision.title || "",
      httpStatus: inspected.httpStatus,
      status,
      documentUrl: null,
      pdfFile: null,
      textFile: null,
      textLength: 0,
      pageText: inspected.pageText,
      pageTextLength: inspected.pageText.length,
      candidateCount: candidates.length,
      debugLinks,
      downloadErrors,
      error: candidates.length
        ? "Aucun lien candidat n'a fourni un PDF valide"
        : "Aucun lien documentaire détecté dans le DOM"
    };
  } catch (error) {
    log(
      `[${index + 1}/${total}] ERREUR : ${error.message}`
    );

    return {
      url: decisionUrl || null,
      status: "PAGE_ERROR",
      textLength: 0,
      pageText: "",
      pageTextLength: 0,
      error: error.message
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  log("Démarrage de l'extraction Liège 2026");

  await fs.mkdir("tmp", { recursive: true });
  await fs.mkdir(PDF_DIR, { recursive: true });
  await fs.mkdir(TEXT_DIR, { recursive: true });

  const input = JSON.parse(
    await fs.readFile(INPUT, "utf8")
  );

  const decisions = Array.isArray(input)
    ? input
    : input.decisions || input.items;

  if (!Array.isArray(decisions) || !decisions.length) {
    throw new Error(
      `Aucune décision trouvée dans ${INPUT}`
    );
  }

  log(`Décisions à traiter : ${decisions.length}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  const results = new Array(decisions.length);
  let nextIndex = 0;

  async function worker(workerId) {
    while (true) {
      const index = nextIndex++;

      if (index >= decisions.length) return;

      results[index] = await processDecision(
        browser,
        decisions[index],
        index,
        decisions.length
      );

      // Petite pause entre les pages.
      await new Promise(resolve =>
        setTimeout(resolve, 200)
      );
    }
  }

  try {
    await Promise.all(
      Array.from(
        { length: Math.min(CONCURRENCY, decisions.length) },
        (_, index) => worker(index + 1)
      )
    );
  } finally {
    await browser.close();
  }

  const count = status =>
    results.filter(item => item.status === status).length;

  const summary = {
    generatedAt: new Date().toISOString(),
    input: INPUT,
    total: results.length,
    ok: count("OK"),
    emptyText: count("EMPTY_TEXT"),
    noDocumentLink: count("NO_DOCUMENT_LINK"),
    downloadFailed: count("DOCUMENT_DOWNLOAD_FAILED"),
    invalidPdf: count("INVALID_PDF"),
    pageErrors: count("PAGE_ERROR"),
    textReadFailed: count("TEXT_READ_FAILED"),
    pageTextAvailable: results.filter(
      item => item.pageTextLength > 0
    ).length,
    totalCharacters: results.reduce(
      (sum, item) => sum + (item.textLength || 0),
      0
    ),
    totalPageTextCharacters: results.reduce(
      (sum, item) => sum + (item.pageTextLength || 0),
      0
    )
  };

  await fs.writeFile(
    OUTPUT,
    JSON.stringify(
      { summary, decisions: results },
      null,
      2
    ),
    "utf8"
  );

  log("========================================");
  log("RÉSULTAT FINAL");
  log("========================================");
  log(JSON.stringify(summary, null, 2));
  log(`Résultat enregistré : ${OUTPUT}`);
  log("Les données de production n'ont pas été modifiées.");
}

main().catch(error => {
  console.error("ERREUR FATALE :", error);
  process.exit(1);
});
