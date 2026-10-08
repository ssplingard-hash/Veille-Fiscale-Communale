import fs from "node:fs";

const INPUT_FILE = "tmp/liege-2026-texts.json";
const OUTPUT_FILE = "tmp/liege-2026-classification.json";

const data = JSON.parse(fs.readFileSync(INPUT_FILE, "utf8"));

const decisions =
  Array.isArray(data)
    ? data
    : data.decisions ||
      data.items ||
      data.results ||
      [];

console.log(`Décisions reçues : ${decisions.length}`);

if (decisions.length < 800) {
  throw new Error(
    `ERREUR : seulement ${decisions.length} décisions trouvées dans ${INPUT_FILE}`
  );
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function getTitle(d) {
  return (
    d.title ||
    d.titre ||
    d.name ||
    d.nom ||
    d.decisionTitle ||
    d.decision_title ||
    ""
  );
}

function getUrl(d) {
  return d.url || d.link || d.href || "";
}

function getText(d) {
  const fields = [
    d.text,
    d.texte,
    d.pageText,
    d.page_text,
    d.content,
    d.contenu,
    d.documentText,
    d.document_text,
    d.pdfText,
    d.pdf_text,
  ];

  return fields
    .filter(Boolean)
    .map(String)
    .join("\n");
}

function classify(decision) {
  const title = getTitle(decision);
  const text = getText(decision);

  const t = normalize(title);
  const x = normalize(`${title}\n${text}`);

  /*
   * ============================================================
   * 1. EXCLUSIONS CLAIRES
   * ============================================================
   */

  const exclusions = [
    {
      pattern:
        /\bparking\b|\bstationnement\b|\bzone payante\b|\bhorodateur\b|\bzone bleue\b/,
      reason: "Parking / stationnement",
    },
    {
      pattern:
        /\bbail\b|\bbaux\b|\blocation\b|\bpreneur\b|\bpreneur locataire\b/,
      reason: "Bail / location",
    },
    {
      pattern:
        /\bmarche public\b|\bcommande\b|\bcentrale d'achat\b|\bcentrale achat\b|\bprocurement\b/,
      reason: "Marché public / commande",
    },
    {
      pattern:
        /\bsubvention\b|\bsubside\b|\baide financiere\b|\bassociation\b|\bfestival\b/,
      reason: "Subvention / aide / association",
    },
    {
      pattern:
        /\bpermis d'urbanisme\b|\burbanisme\b|\btravaux\b|\bchantier\b|\bconstruction\b/,
      reason: "Urbanisme / travaux",
    },
    {
      pattern:
        /\bpolice\b|\bcirculation\b|\b30 km\/h\b|\bzone 30\b|\brèglement de police\b/,
      reason: "Police / circulation",
    },
    {
      pattern:
        /\bterrasse\b|\boccupation du domaine public\b|\boccupation temporaire\b/,
      reason: "Occupation du domaine public",
    },
  ];

  for (const exclusion of exclusions) {
    if (exclusion.pattern.test(t)) {
      return {
        classification: "EXCLU",
        reason: exclusion.reason,
      };
    }
  }

  /*
   * ============================================================
   * 2. SIGNAUX FISCAUX FORTS DANS LE TITRE
   * ============================================================
   */

  const strongTitleSignals = [
    {
      pattern: /\breglement[- ]taxe\b|\breglement[- ]taxes\b/,
      reason: "Règlement-taxe",
    },
    {
      pattern: /\btaxe communale\b/,
      reason: "Taxe communale",
    },
    {
      pattern: /\bcentimes additionnels\b/,
      reason: "Centimes additionnels",
    },
    {
      pattern: /\bprecompte immobilier\b/,
      reason: "Précompte immobilier",
    },
    {
      pattern: /\bforce motrice\b/,
      reason: "Force motrice",
    },
    {
      pattern: /\bipp\b/,
      reason: "IPP",
    },
    {
      pattern: /\bimpot des personnes physiques\b/,
      reason: "Impôt des personnes physiques",
    },
    {
      pattern: /\btaxe sur\b/,
      reason: "Taxe sur...",
    },
    {
      pattern: /\btaxe communale sur\b/,
      reason: "Taxe communale sur...",
    },
  ];

  for (const signal of strongTitleSignals) {
    if (signal.pattern.test(t)) {
      return {
        classification: "FISCAL_FORT",
        reason: signal.reason,
      };
    }
  }

  /*
   * ============================================================
   * 3. SIGNAUX FISCAUX FORTS DANS LE TEXTE
   * ============================================================
   */

  const strongTextSignals = [
    {
      pattern: /\breglement[- ]taxe\b|\breglement[- ]taxes\b/,
      reason: "Règlement-taxe dans le document",
    },
    {
      pattern: /\bcentimes additionnels\b/,
      reason: "Centimes additionnels dans le document",
    },
    {
      pattern: /\bprecompte immobilier\b/,
      reason: "Précompte immobilier dans le document",
    },
    {
      pattern: /\bforce motrice\b/,
      reason: "Force motrice dans le document",
    },
    {
      pattern: /\btaxe communale\b/,
      reason: "Taxe communale dans le document",
    },
  ];

  for (const signal of strongTextSignals) {
    if (signal.pattern.test(x)) {
      return {
        classification: "FISCAL_FORT",
        reason: signal.reason,
      };
    }
  }

  /*
   * ============================================================
   * 4. TAXE + ELEMENT FISCAL = A VERIFIER
   * ============================================================
   */

  const hasTax = /\btaxe\b|\btaxes\b/.test(x);

  const hasFiscalContext =
    /\btaux\b|\bexercice\b|\bimposition\b|\bimposable\b|\bassiette\b|\brecette fiscale\b|\bcontribuable\b|\bexoneration\b|\bexemption\b|\bmajoration\b|\bcoefficient\b|\bcentime\b|\bimpot\b|\bprecompte\b/.test(
      x
    );

  if (hasTax && hasFiscalContext) {
    return {
      classification: "A_VERIFIER",
      reason: "Taxe + contexte fiscal",
    };
  }

  /*
   * ============================================================
   * 5. REDEVANCE SEULE = PAS UNE TAXE
   * ============================================================
   */

  if (/\bredevance\b/.test(x)) {
    return {
      classification: "EXCLU",
      reason: "Redevance sans signal fiscal suffisant",
    };
  }

  return {
    classification: "NON_FISCAL",
    reason: "",
  };
}

const results = [];

for (const decision of decisions) {
  const title = getTitle(decision);
  const url = getUrl(decision);

  const classification = classify(decision);

  results.push({
    title,
    url,
    classification: classification.classification,
    reason: classification.reason,
  });
}

const fiscaux = results.filter(
  (r) => r.classification === "FISCAL_FORT"
);

const aVerifier = results.filter(
  (r) => r.classification === "A_VERIFIER"
);

const exclus = results.filter(
  (r) => r.classification === "EXCLU"
);

const nonFiscaux = results.filter(
  (r) => r.classification === "NON_FISCAL"
);

const output = {
  generatedAt: new Date().toISOString(),
  total: results.length,
  fiscalFort: fiscaux.length,
  aVerifier: aVerifier.length,
  exclus: exclus.length,
  nonFiscal: nonFiscaux.length,
  results,
};

fs.writeFileSync(
  OUTPUT_FILE,
  JSON.stringify(output, null, 2),
  "utf8"
);

console.log("");
console.log("==============================================");
console.log("CLASSIFICATION FISCALE LIÈGE 2026");
console.log("==============================================");
console.log(`Total décisions : ${results.length}`);
console.log(`FISCAL_FORT     : ${fiscaux.length}`);
console.log(`A_VERIFIER      : ${aVerifier.length}`);
console.log(`EXCLU           : ${exclus.length}`);
console.log(`NON_FISCAL      : ${nonFiscaux.length}`);
console.log("==============================================");
console.log("");

console.log("======== FISCAUX FORTS ========");

for (const r of fiscaux) {
  console.log("");
  console.log(`TITRE : ${r.title}`);
  console.log(`RAISON: ${r.reason}`);
  console.log(`URL   : ${r.url}`);
}

console.log("");
console.log("======== À VÉRIFIER ========");

for (const r of aVerifier) {
  console.log("");
  console.log(`TITRE : ${r.title}`);
  console.log(`RAISON: ${r.reason}`);
  console.log(`URL   : ${r.url}`);
}

console.log("");
console.log(`Résultat sauvegardé dans : ${OUTPUT_FILE}`);
console.log("");
