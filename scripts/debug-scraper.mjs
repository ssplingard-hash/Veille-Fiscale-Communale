import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';

const USER_AGENT =
  'VeilleFiscaleCommunale-bot/1.0 (+contact: voir depot GitHub)';

const TEST_COMMUNES = [
  'aiseau-presles',
  'ecaussinnes',
  'liege',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function diagnose(browser, slug) {
  console.log(`\n========== ${slug} ==========`);

  const page = await browser.newPage();

  await page.setUserAgent(USER_AGENT);

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'fr',
  });

  try {
    const url = `https://www.deliberations.be/${slug}/decisions`;

    console.log(`Ouverture : ${url}`);

    const response = await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    console.log(
      `HTTP : ${response ? response.status() : 'inconnu'}`
    );

    console.log('Attente du chargement JavaScript...');

    await sleep(5000);

    const html = await page.content();

    console.log(
      `HTML après JavaScript : ${html.length} caractères`
    );

    const $ = cheerio.load(html);

    const links = [];

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';

      if (
        href.includes(`/${slug}/decisions/`)
      ) {
        const title = $(el).text().trim();

        links.push({
          href,
          title,
        });
      }
    });

    console.log(
      `Liens de décisions trouvés après JavaScript : ${links.length}`
    );

    links.slice(0, 10).forEach((link, index) => {
      console.log(
        `  ${index + 1}. ${link.title || '(sans titre)'}`
      );
      console.log(`     ${link.href}`);
    });

    const bodyText = await page.evaluate(() => document.body.innerText);

    console.log(
      `\nTexte visible dans la page : ${bodyText.length} caractères`
    );

    console.log(
      bodyText.substring(0, 3000)
    );
  } catch (error) {
    console.error(
      `ERREUR pour ${slug} :`,
      error.message
    );
  } finally {
    await page.close();
  }
}

async function main() {
  console.log('Lancement de Chromium...');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  try {
    for (const slug of TEST_COMMUNES) {
      await diagnose(browser, slug);
    }
  } finally {
    await browser.close();
  }

  console.log('\nDiagnostic terminé.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
