import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import puppeteer from "puppeteer";

const execFileAsync = promisify(execFile);

const BASE_URL = "https://www.deliberations.be/liege/decisions";
const YEAR = 2026;

const OUTPUT_DIR = path.resolve("tmp");
const RAW_FILE = path.join(OUTPUT_DIR, "liege-2026-analysis.json");

const MAX_PAGES = 150;
const PAGE_DELAY = 300;
const DECISION_DELAY = 150;
const CONCURRENCY = 3;
const MAX_DOCUMENTS_PER_DECISION = 8;
const MAX_PDF_SIZE = 15 * 1024 * 1024;

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

function isDecision2026(url) {
  return /\/decisions\/\d{1,2}-[a-zàâäéèêëîïôöùûüÿç]+-2026-\d{1,2}-\d{2}\//i.test(
    url || ""
  );
}

function getDateFromUrl(url) {
  const match = (url || "").match(
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

  const month = months[normalizeText(match[2])];

  if (!month) return null;

  return `2026-${month}-${String(match[1]).padStart(2, "0")}`;
}

function getTitleFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/").filter(Boolean);
    const slug = parts[parts.length - 1] || "";

    return decodeURIComponent(slug)
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function looksLikeDocument(link) {
  const href = normalizeText(link.href);
  const text = normalizeText(link.text);

  if (!href) return false;

  const documentPatterns = [
    /\.pdf(?:$|\?)/i,
    /\.docx?(?:$|\?)/i,
    /\.odt(?:$|\?)/i,
    /\.rtf(?:$|\?)/i,
    /\/download(?:\/|$|\?)/i,
    /\/document(?:\/|$|\?)/i,
    /\/documents?(?:\/|$|\?)/i,
    /\/file(?:\/|$|\?)/i,
    /\/files?(?:\/|$|\?)/i,
    /\/attachment(?:\/|$|\?)/i,
    /\/annexe(?:\/|$|\?)/i,
    /\/annexes(?:\/|$|\?)/i,
    /pdf/i
  ];

  const textPatterns = [
    "pdf",
    "document",
    "annexe",
    "piece jointe",
    "telecharger",
    "télécharger",
    "download"
  ];

  return (
    documentPatterns.some(pattern => pattern.test(href)) ||
    textPatterns.some(pattern => text.includes(pattern))
  );
}

async function discoverSeanceId(page) {
  await page.goto(BASE_URL, {
    waitUntil: "networkidle2",
    timeout: 120000
  });

  await sleep(1000);

  const currentUrl = page.url();

  const match =
    currentUrl.match(/seance(?:%5B%5D|\[\])=([a-z0-9]+)/i) ||
    currentUrl.match(/seance=([a-z0-9]+)/i);

  if (match) {
    return match[1];
  }

  const html = await page.content();

  const htmlMatch =
    html.match(/seance(?:%5B%5D|\[\])=([a-z0-9]+)/i) ||
    html.match(/seance=([a-z0-9]+)/i);

  if (htmlMatch) {
    return htmlMatch[1];
  }

  throw new Error(
    "Impossible de récupérer automatiquement l'identifiant de séance de Liège."
  );
}

async function extractListingPage(page, url) {
  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 120000
  });

  await sleep(PAGE_DELAY);

  return await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a"))
      .map(a => ({
        href: a.href || "",
        text: a.innerText?.trim() || ""
      }))
      .filter(x => x.href);

    const paginationLinks = links
      .map(x => x.href)
      .filter(href =>
        /@@faceted_query\?/i.test(href)
      );

    const decisionLinks = links
      .filter(x =>
        /\/decisions\/\d{1,2}-[a-zàâäéèêëîïôöùûüÿç]+-2026-\d{1,2}-\d{2}\//i.test(
          x.href
        )
      )
      .map(x => ({
        url: x.href,
        linkText: x.text
      }));

    return {
      decisionLinks,
      paginationLinks
    };
  });
}

async function collectAllDecisionLinks(browser) {
  const page = await browser.newPage();

  try {
    console.log("Recherche de l'identifiant de séance...");

    const seanceId = await discoverSeanceId(page);

    console.log(`Séance détectée : ${seanceId}`);

    const queue = [
      `${BASE_URL}#seance=${seanceId}&b_start=0`
    ];

    const visitedPages = new Set();
    const decisionMap = new Map();

    while (queue.length > 0 && visitedPages.size < MAX_PAGES) {
      const url = queue.shift();

      if (visitedPages.has(url)) continue;

      visitedPages.add(url);

      console.log("");
      console.log(
        `PAGE ${visitedPages.size} — ${url}`
      );

      try {
        const result = await extractListingPage(page, url);

        let added = 0;

        for (const decision of result.decisionLinks) {
          const normalized = decision.url.split("#")[0];

          if (!decisionMap.has(normalized)) {
            decisionMap.set(normalized, decision);
            added++;
          }
        }

        console.log(
          `Décisions 2026 sur cette page : ${result.decisionLinks.length}`
        );

        console.log(
          `Nouvelles décisions : ${added}`
        );

        console.log(
          `Total unique : ${decisionMap.size}`
        );

        for (const paginationUrl of result.paginationLinks) {
          if (!visitedPages.has(paginationUrl)) {
            queue.push(paginationUrl);
          }
        }
      } catch (error) {
        console.log(
          `ERREUR PAGE : ${error.message}`
        );
      }
    }

    console.log("");
    console.log(
      `TOTAL FINAL DE DÉCISIONS 2026 : ${decisionMap.size}`
    );

    if (decisionMap.size < 500) {
      throw new Error(
        `Seulement ${decisionMap.size} décisions trouvées. Le scraper est arrêté par sécurité.`
      );
    }

    return [...decisionMap.values()];
  } finally {
    await page.close();
  }
}

async function extractDecisionPage(page, decision) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(decision.url, {
        waitUntil: "networkidle2",
        timeout: 120000
      });

      await sleep(DECISION_DELAY);

      const result = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll("a"))
          .map(a => ({
            text: a.innerText?.trim() || "",
            href: a.href || ""
          }))
          .filter(x => x.href);

        const bodyText =
          document.body?.innerText || "";

        const headings = Array.from(
          document.querySelectorAll("h1,h2,h3,h4")
        )
          .map(x => x.innerText?.trim() || "")
          .filter(Boolean);

        return {
          bodyText,
          headings,
          links
        };
      });

      const documentLinks = result.links
        .filter(looksLikeDocument)
        .map(link => ({
          text: cleanText(link.text),
          href: absoluteUrl(link.href)
        }))
        .filter(x => x.href);

      const uniqueDocuments = [
        ...new Map(
          documentLinks.map(x => [x.href, x])
        ).values()
      ].slice(0, MAX_DOCUMENTS_PER_DECISION);

      return {
        url: decision.url,
        date: getDateFromUrl(decision.url),
        title: getTitleFromUrl(decision.url),
        linkText: cleanText(decision.linkText),
        headings: result.headings.map(cleanText),
        pageText: cleanText(result.bodyText),
        documents: uniqueDocuments
      };
    } catch (error) {
      console.log(
        `   Tentative ${attempt}/3 échouée : ${error.message}`
      );

      if (attempt < 3) {
        await sleep(1000 * attempt);
      }
    }
  }

  return null;
}

async function downloadPdf(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(45000)
    });

    if (!response.ok) {
      return null;
    }

    const contentType =
      response.headers.get("content-type") || "";

    const contentLength =
      Number(
        response.headers.get("content-length") || 0
      );

    if (
      contentLength &&
      contentLength > MAX_PDF_SIZE
    ) {
      return null;
    }

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    if (buffer.length > MAX_PDF_SIZE) {
      return null;
    }

    const looksPdf =
      buffer.subarray(0, 4).toString() === "%PDF";

    if (
      !looksPdf &&
      !contentType.toLowerCase().includes("pdf")
    ) {
      return null;
    }

    return buffer;
  } catch {
    return null;
  }
}

async function extractPdfText(buffer, index) {
  const tempDir = path.join(
    OUTPUT_DIR,
    "pdf-temp"
  );

  fs.mkdirSync(tempDir, {
    recursive: true
  });

  const pdfPath = path.join(
    tempDir,
    `document-${process.pid}-${index}.pdf`
  );

  const txtPath = `${pdfPath}.txt`;

  try {
    fs.writeFileSync(pdfPath, buffer);

    await execFileAsync(
      "pdftotext",
      [
        "-layout",
        pdfPath,
        txtPath
      ],
      {
        timeout: 60000,
        maxBuffer: 5 * 1024 * 1024
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
      fs.unlinkSync(pdfPath);
    } catch {}

    try {
      fs.unlinkSync(txtPath);
    } catch {}
  }
}

function classifyDecision(decision) {
  const title = normalizeText(
    decision.title
  );

  const pageText = normalizeText(
    decision.pageText
  );

  const pdfText = normalizeText(
    decision.pdfText
  );

  const combined =
    `${title} ${pdfText}`;

  const exclusions = [
    /\bsubvention\b/,
    /\bsubside\b/,
    /\bconvention\b/,
    /\bbail\b/,
    /\blocatif\b/,
    /\bmarche public\b/,
    /\bcommande publique\b/,
    /\btravaux\b/,
    /\bfourniture\b/,
    /\bpersonnel\b/,
    /\bpolice\b/,
    /\bstationnement\b/,
    /\bparking\b/,
    /\boccupation du domaine public\b/,
    /\boccupation de la voirie\b/,
    /\bmanifestation\b/,
    /\bfestival\b/,
    /\bevenement\b/,
    /\bévénement\b/,
    /\bactivite ambulante\b/,
    /\bactivites ambulantes\b/
  ];

  if (
    exclusions.some(
      pattern => pattern.test(title)
    )
  ) {
    return {
      status: "NON_FISCAL",
      confidence: "EXCLU",
      reasons: ["EXCLUSION_TITRE"]
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
      signal =>
        combined.includes(signal)
    );

  if (certainMatches.length > 0) {
    return {
      status: "FISCAL",
      confidence: "CERTAIN",
      reasons: certainMatches
    };
  }

  const taxObjects = [
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
    "taxe sur les secondes résidences",
    "taxe sur les vehicules",
    "taxe sur les véhicules"
  ];

  const objectMatches =
    taxObjects.filter(
      signal =>
        combined.includes(signal)
    );

  if (objectMatches.length > 0) {
    return {
      status: "FISCAL",
      confidence: "CERTAIN",
      reasons: objectMatches
    };
  }

  const hasTax =
    /\btaxe\b/.test(combined) ||
    /\btaxes\b/.test(combined);

  const hasRedevance =
    /\bredevance\b/.test(combined) ||
    /\bredevances\b/.test(combined);

  const hasReglement =
    /\breglement\b/.test(combined) ||
    /\brèglement\b/.test(combined);

  const hasTarif =
    /\btarif\b/.test(combined) ||
    /\btaux\b/.test(combined);

  const fiscalContext = [
    "exercice 2026",
    "exercices 2026",
    "taux de la taxe",
    "taux des taxes",
    "base imposable",
    "contribuable",
    "redevable",
    "recouvrement de la taxe",
    "role de la taxe",
    "rôle de la taxe",
    "imposition",
    "impose",
    "imposée",
    "imposes",
    "imposés"
  ];

  const fiscalContextMatches =
    fiscalContext.filter(
      signal =>
        combined.includes(
          normalizeText(signal)
        )
    );

  if (
    hasReglement &&
    (hasTax || hasRedevance) &&
    fiscalContextMatches.length > 0
  ) {
    return {
      status: "A_VERIFIER",
      confidence: "PROBABLE",
      reasons: [
        "REGLEMENT",
        hasTax ? "TAXE" : "REDEVANCE",
        ...fiscalContextMatches
      ]
    };
  }

  if (
    hasTax &&
    hasTarif &&
    fiscalContextMatches.length > 0
  ) {
    return {
      status: "A_VERIFIER",
      confidence: "POSSIBLE",
      reasons: [
        "TAXE",
        "TAUX_OU_TARIF",
        ...fiscalContextMatches
      ]
    };
  }

  return {
    status: "NON_FISCAL",
    confidence: "FAIBLE",
    reasons: [],
    pageTextDetected:
      pageText.includes("taxe") ||
      pageText.includes("redevance")
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
        status: "ERREUR",
        documents: [],
        pdfText: ""
      };
    }

    let pdfText = "";
    let downloaded = 0;

    for (
      let i = 0;
      i < result.documents.length;
      i++
    ) {
      const document =
        result.documents[i];

      const buffer =
        await downloadPdf(
          document.href
        );

      if (!buffer) continue;

      downloaded++;

      const text =
        await extractPdfText(
          buffer,
          `${index}-${i}`
        );

      if (text) {
        pdfText += `\n${text}`;
      }
    }

    const enriched = {
      ...result,
      pdfDocumentsDownloaded:
        downloaded,
      pdfText: cleanText(pdfText)
    };

    const classification =
      classifyDecision(
        enriched
      );

    return {
      url: result.url,
      date: result.date,
      title: result.title,
      linkText: result.linkText,
      headings: result.headings,
      documents: result.documents,
      pdfDocumentsDownloaded:
        downloaded,
      classification
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
    "LIÈGE 2026 — NOUVEAU PIPELINE DE COLLECTE"
  );
  console.log(
    "=================================================="
  );
  console.log("");

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
    console.log(
      "ÉTAPE 1 — récupération des décisions"
    );

    const decisions =
      await collectAllDecisionLinks(
        browser
      );

    console.log("");
    console.log(
      "ÉTAPE 2 — analyse des pages et documents"
    );
    console.log("");

    let cursor = 0;

    const results = [];

    async function worker() {
      while (true) {
        const index = cursor++;

        if (
          index >= decisions.length
        ) {
          break;
        }

        const result =
          await processDecision(
            browser,
            decisions[index],
            index,
            decisions.length
          );

        results.push(result);
      }
    }

    await Promise.all(
      Array.from(
        {
          length: CONCURRENCY
        },
        () => worker()
      )
    );

    results.sort(
      (a, b) =>
        String(a.url).localeCompare(
          String(b.url)
        )
    );

    const fiscal =
      results.filter(
        x =>
          x.classification?.status ===
          "FISCAL"
      );

    const verify =
      results.filter(
        x =>
          x.classification?.status ===
          "A_VERIFIER"
      );

    const documentsFound =
      results.filter(
        x =>
          x.documents?.length > 0
      );

    const pdfsDownloaded =
      results.reduce(
        (sum, x) =>
          sum +
          (x.pdfDocumentsDownloaded || 0),
        0
      );

    const output = {
      commune: "Liège",
      annee: YEAR,
      generatedAt:
        new Date().toISOString(),
      totalDecisions:
        results.length,
      decisionsAvecDocuments:
        documentsFound.length,
      pdfDocumentsTelecharges:
        pdfsDownloaded,
      fiscalCertain:
        fiscal.filter(
          x =>
            x.classification
              ?.confidence ===
            "CERTAIN"
        ).length,
      fiscalAverifier:
        verify.length,
      decisions: results
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
      "RÉSULTATS"
    );
    console.log(
      "=================================================="
    );

    console.log(
      `Décisions récupérées : ${results.length}`
    );

    console.log(
      `Décisions avec documents : ${documentsFound.length}`
    );

    console.log(
      `PDF téléchargés : ${pdfsDownloaded}`
    );

    console.log(
      `Fiscales certaines : ${
        output.fiscalCertain
      }`
    );

    console.log(
      `À vérifier : ${
        output.fiscalAverifier
      }`
    );

    console.log("");

    console.log(
      "========== FISCALES CERTAINES =========="
    );

    fiscal
      .filter(
        x =>
          x.classification
            ?.confidence ===
          "CERTAIN"
      )
      .forEach(
        (x, i) => {
          console.log(
            `${i + 1}. ${x.date} — ${x.title}`
          );

          console.log(
            `   ${x.url}`
          );

          console.log(
            `   Documents : ${x.documents.length}`
          );

          console.log(
            `   PDF téléchargés : ${x.pdfDocumentsDownloaded}`
          );

          console.log(
            `   Raisons : ${x.classification.reasons.join(
              ", "
            )}`
          );
        }
      );

    console.log("");

    console.log(
      "========== À VÉRIFIER =========="
    );

    verify.forEach(
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
      }
    );

    console.log("");

    console.log(
      `Fichier créé : ${RAW_FILE}`
    );

    console.log("");
    console.log(
      "AUCUN FICHIER DE PRODUCTION N'A ÉTÉ MODIFIÉ."
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
