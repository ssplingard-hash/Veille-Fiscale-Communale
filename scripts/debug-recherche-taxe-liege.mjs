import puppeteer from "puppeteer";

const BASE_URL =
  "https://www.deliberations.be/liege/decisions";

const SEARCH_TERM = "taxe";
const YEAR = "2026";

const NAVIGATION_TIMEOUT = 60000;
const WAIT_AFTER_LOAD = 1500;

function clean(text = "") {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  console.log("");
  console.log("==============================================");
  console.log(" DIAGNOSTIC RECHERCHE TAXE - LIÈGE");
  console.log("==============================================");
  console.log("");

  console.log(`URL de départ : ${BASE_URL}`);
  console.log(`Recherche     : ${SEARCH_TERM}`);
  console.log(`Année         : ${YEAR}`);
  console.log("");

  console.log(
    "IMPORTANT : ce script ne modifie aucun fichier de production."
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
    console.log("1. Ouverture de la page Liège...");

    await page.goto(BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT,
    });

    await new Promise((resolve) =>
      setTimeout(resolve, WAIT_AFTER_LOAD)
    );

    console.log("Page chargée.");
    console.log("");

    const diagnostic = await page.evaluate(() => {
      const forms = [];

      document
        .querySelectorAll("form")
        .forEach((form, formIndex) => {
          const formData = {
            index: formIndex,
            action: form.action || "",
            method: form.method || "",
            id: form.id || "",
            name: form.getAttribute("name") || "",
            classes: form.className || "",
            inputs: [],
            selects: [],
            buttons: [],
          };

          form
            .querySelectorAll("input")
            .forEach((input) => {
              formData.inputs.push({
                type: input.type || "",
                name: input.name || "",
                id: input.id || "",
                value: input.value || "",
                placeholder:
                  input.getAttribute("placeholder") || "",
                ariaLabel:
                  input.getAttribute("aria-label") || "",
                title:
                  input.getAttribute("title") || "",
              });
            });

          form
            .querySelectorAll("select")
            .forEach((select) => {
              formData.selects.push({
                name: select.name || "",
                id: select.id || "",
                value: select.value || "",
                ariaLabel:
                  select.getAttribute("aria-label") || "",
                options: Array.from(select.options).map(
                  (option) => ({
                    value: option.value || "",
                    text:
                      option.textContent?.trim() || "",
                    selected:
                      option.selected,
                  })
                ),
              });
            });

          form
            .querySelectorAll(
              'button, input[type="submit"]'
            )
            .forEach((button) => {
              formData.buttons.push({
                tag:
                  button.tagName || "",
                type:
                  button.getAttribute("type") || "",
                name:
                  button.getAttribute("name") || "",
                value:
                  button.getAttribute("value") || "",
                id:
                  button.id || "",
                text:
                  button.textContent?.trim() ||
                  button.value ||
                  "",
              });
            });

          forms.push(formData);
        });

      const links = Array.from(
        document.querySelectorAll("a[href]")
      )
        .map((a) => ({
          text:
            a.innerText ||
            a.textContent ||
            "",
          href: a.href || "",
        }))
        .filter(
          (item) =>
            item.href.includes("@@faceted_query") ||
            item.href.includes("taxe") ||
            item.href.includes("2026") ||
            item.text.toLowerCase().includes("taxe") ||
            item.text.includes("2026")
        );

      const allInputs = Array.from(
        document.querySelectorAll("input")
      ).map((input) => ({
        type: input.type || "",
        name: input.name || "",
        id: input.id || "",
        value: input.value || "",
        placeholder:
          input.getAttribute("placeholder") || "",
        ariaLabel:
          input.getAttribute("aria-label") || "",
      }));

      const allSelects = Array.from(
        document.querySelectorAll("select")
      ).map((select) => ({
        name: select.name || "",
        id: select.id || "",
        value: select.value || "",
        options: Array.from(select.options).map(
          (option) => ({
            value: option.value || "",
            text:
              option.textContent?.trim() || "",
            selected:
              option.selected,
          })
        ),
      }));

      return {
        currentUrl: window.location.href,
        title: document.title || "",
        forms,
        allInputs,
        allSelects,
        links,
      };
    });

    console.log("==============================================");
    console.log("URL ACTUELLE");
    console.log("==============================================");
    console.log("");

    console.log(
      diagnostic.currentUrl
    );

    console.log("");

    console.log("==============================================");
    console.log("TITRE");
    console.log("==============================================");
    console.log("");

    console.log(
      diagnostic.title
    );

    console.log("");

    console.log("==============================================");
    console.log("FORMULAIRES");
    console.log("==============================================");
    console.log("");

    if (diagnostic.forms.length === 0) {
      console.log(
        "Aucun formulaire HTML classique détecté."
      );
    }

    diagnostic.forms.forEach((form) => {
      console.log("");
      console.log(
        `FORMULAIRE ${form.index}`
      );

      console.log(
        `  action : ${form.action}`
      );

      console.log(
        `  method : ${form.method}`
      );

      console.log(
        `  id     : ${form.id}`
      );

      console.log(
        `  name   : ${form.name}`
      );

      console.log("");

      console.log("  INPUTS :");

      form.inputs.forEach((input) => {
        console.log(
          `    type=${input.type} | name=${input.name} | id=${input.id} | value=${input.value} | placeholder=${input.placeholder} | aria=${input.ariaLabel}`
        );
      });

      console.log("");

      console.log("  SELECTS :");

      form.selects.forEach((select) => {
        console.log(
          `    name=${select.name} | id=${select.id} | value=${select.value}`
        );

        select.options.forEach((option) => {
          console.log(
            `      option value="${option.value}" text="${option.text}" selected=${option.selected}`
          );
        });
      });

      console.log("");

      console.log("  BOUTONS :");

      form.buttons.forEach((button) => {
        console.log(
          `    tag=${button.tag} | type=${button.type} | name=${button.name} | value=${button.value} | id=${button.id} | text=${button.text}`
        );
      });
    });

    console.log("");

    console.log("==============================================");
    console.log("TOUS LES INPUTS");
    console.log("==============================================");
    console.log("");

    diagnostic.allInputs.forEach((input) => {
      console.log(
        `type=${input.type} | name=${input.name} | id=${input.id} | value=${input.value} | placeholder=${input.placeholder} | aria=${input.ariaLabel}`
      );
    });

    console.log("");

    console.log("==============================================");
    console.log("TOUS LES SELECTS");
    console.log("==============================================");
    console.log("");

    diagnostic.allSelects.forEach((select) => {
      console.log(
        `name=${select.name} | id=${select.id} | value=${select.value}`
      );

      select.options.forEach((option) => {
        console.log(
          `  value="${option.value}" | text="${option.text}" | selected=${option.selected}`
        );
      });
    });

    console.log("");

    console.log("==============================================");
    console.log("LIENS INTÉRESSANTS");
    console.log("==============================================");
    console.log("");

    if (diagnostic.links.length === 0) {
      console.log(
        "Aucun lien correspondant détecté."
      );
    }

    diagnostic.links.forEach((link) => {
      console.log(
        `TEXTE : ${clean(link.text)}`
      );

      console.log(
        `URL   : ${link.href}`
      );

      console.log("");
    });

    console.log("");

    console.log("==============================================");
    console.log("FIN DU DIAGNOSTIC");
    console.log("==============================================");
    console.log("");

    console.log(
      "Aucun fichier de production n'a été modifié."
    );

    console.log("");
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
