import puppeteer from "puppeteer";

const BASE_URL =
  "https://www.deliberations.be/liege/decisions";

const SEARCH_TERM = "taxe";
const YEAR = "2026";

const NAVIGATION_TIMEOUT = 60000;
const WAIT_AFTER_ACTION = 2000;

function clean(text = "") {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function waitForPage(page) {
  await new Promise((resolve) =>
    setTimeout(resolve, WAIT_AFTER_ACTION)
  );
}

async function getPageInformation(page) {
  return await page.evaluate(() => {
    const textInput =
      document.querySelector('input[name="text"]');

    const yearSelect =
      document.querySelector('select[name="annee"]');

    const resultLinks = Array.from(
      document.querySelectorAll("a[href]")
    )
      .map((a) => ({
        text: cleanText(
          a.innerText || a.textContent || ""
        ),
        href: a.href || "",
      }))
      .filter((item) => {
        return (
          item.href.includes("/decisions/") &&
          !item.href.includes("@@faceted_query")
        );
      });

    function cleanText(text = "") {
      return text
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    const bodyText = cleanText(
      document.body?.innerText || ""
    );

    return {
      url: window.location.href,
      title: document.title || "",
      searchValue: textInput?.value || "",
      yearValue: yearSelect?.value || "",
      yearOptions: yearSelect
        ? Array.from(yearSelect.options).map(
            (option) => ({
              value: option.value || "",
              text:
                option.textContent?.trim() || "",
              selected: option.selected,
            })
          )
        : [],
      resultLinks,
      bodyText,
    };
  });
}

async function submitSearch(page, searchTerm) {
  console.log("");
  console.log("==============================================");
  console.log("TEST 1 — RECHERCHE TEXTE");
  console.log("==============================================");
  console.log("");

  console.log(
    `Recherche envoyée : "${searchTerm}"`
  );

  await page.evaluate((term) => {
    const input =
      document.querySelector('input[name="text"]');

    if (!input) {
      throw new Error(
        'Champ input[name="text"] introuvable.'
      );
    }

    input.value = term;

    input.dispatchEvent(
      new Event("input", {
        bubbles: true,
      })
    );

    input.dispatchEvent(
      new Event("change", {
        bubbles: true,
      })
    );
  }, searchTerm);

  const formResult = await page.evaluate(() => {
    const input =
      document.querySelector('input[name="text"]');

    if (!input) {
      throw new Error(
        'Champ input[name="text"] introuvable.'
      );
    }

    const form = input.closest("form");

    if (!form) {
      throw new Error(
        "Formulaire de recherche introuvable."
      );
    }

    return {
      action: form.action,
      method: form.method,
    };
  });

  console.log(
    `Formulaire : ${formResult.method.toUpperCase()} ${formResult.action}`
  );

  console.log("");

  await page.evaluate(() => {
    const button =
      document.querySelector(
        'button[name="text_button"]'
      );

    if (!button) {
      throw new Error(
        'Bouton button[name="text_button"] introuvable.'
      );
    }

    button.click();
  });

  await page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT,
  }).catch(() => {});

  await waitForPage(page);

  const result = await getPageInformation(page);

  console.log("");
  console.log("URL APRÈS RECHERCHE :");
  console.log(result.url);

  console.log("");

  console.log(
    `Champ de recherche après recherche : "${result.searchValue}"`
  );

  console.log("");

  console.log(
    `Nombre de liens de décisions détectés : ${result.resultLinks.length}`
  );

  console.log("");

  console.log("PREMIERS RÉSULTATS :");

  result.resultLinks
    .slice(0, 20)
    .forEach((item, index) => {
      console.log("");
      console.log(
        `${index + 1}. ${item.text}`
      );
      console.log(
        `   ${item.href}`
      );
    });

  return result;
}

async function applyYearFilter(page, year) {
  console.log("");
  console.log("==============================================");
  console.log("TEST 2 — FILTRE ANNÉE");
  console.log("==============================================");
  console.log("");

  console.log(
    `Année sélectionnée : ${year}`
  );

  const before = await getPageInformation(page);

  console.log("");
  console.log(
    `URL avant sélection de l'année : ${before.url}`
  );

  await page.evaluate((yearValue) => {
    const select =
      document.querySelector('select[name="annee"]');

    if (!select) {
      throw new Error(
        'Sélecteur select[name="annee"] introuvable.'
      );
    }

    const option = Array.from(
      select.options
    ).find(
      (item) => item.value === yearValue
    );

    if (!option) {
      throw new Error(
        `Option année ${yearValue} introuvable.`
      );
    }

    select.value = yearValue;

    select.dispatchEvent(
      new Event("change", {
        bubbles: true,
      })
    );
  }, year);

  await waitForPage(page);

  const after = await getPageInformation(page);

  console.log("");
  console.log(
    `URL après sélection de l'année : ${after.url}`
  );

  console.log("");

  console.log(
    `Valeur année après sélection : ${after.yearValue}`
  );

  console.log("");

  console.log(
    `Nombre de liens de décisions détectés : ${after.resultLinks.length}`
  );

  console.log("");

  console.log("PREMIERS RÉSULTATS :");

  after.resultLinks
    .slice(0, 20)
    .forEach((item, index) => {
      console.log("");
      console.log(
        `${index + 1}. ${item.text}`
      );
      console.log(
        `   ${item.href}`
      );
    });

  return after;
}

async function main() {
  console.log("");
  console.log("==============================================");
  console.log(" DIAGNOSTIC RECHERCHE TAXE — LIÈGE");
  console.log("==============================================");
  console.log("");

  console.log(
    "Ce script ne modifie aucune donnée de production."
  );

  console.log("");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(
    NAVIGATION_TIMEOUT
  );

  try {
    console.log(
      `Ouverture : ${BASE_URL}`
    );

    await page.goto(BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT,
    });

    await waitForPage(page);

    console.log(
      "Page initiale chargée."
    );

    await submitSearch(
      page,
      SEARCH_TERM
    );

    await applyYearFilter(
      page,
      YEAR
    );

    console.log("");
    console.log("==============================================");
    console.log("FIN DU DIAGNOSTIC");
    console.log("==============================================");
    console.log("");

    console.log(
      "Les données de production n'ont pas été modifiées."
    );
  } finally {
    await page.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error("");
  console.error("==============================================");
  console.error("ERREUR FATALE");
  console.error("==============================================");
  console.error("");

  console.error(error);

  process.exit(1);
});
