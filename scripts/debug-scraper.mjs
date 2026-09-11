import puppeteer from 'puppeteer';

const BASE_URL = 'https://www.deliberations.be';
const START_URL = `${BASE_URL}/liege/decisions`;
const TARGET_YEAR = 2026;

function cleanText(value = '') {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractYear(url) {
  const match = url.match(
    /\/(\d{1,2})-[^/]+-(\d{4})-\d{2}-\d{2}\//
  );

  return match ? Number(match[2]) : null;
}

async function main() {
  console.log('');
  console.log('========================================');
  console.log('DIAGNOSTIC LIÈGE');
  console.log('========================================');
  console.log('');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors'
    ]
  });

  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(90000);

  await page.goto(START_URL, {
    waitUntil: 'networkidle2',
    timeout: 90000
  });

  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('URL chargée :');
  console.log(page.url());
  console.log('');

  const result = await page.evaluate((TARGET_YEAR) => {
    function clean(value) {
      return (value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const allLinks = Array.from(
      document.querySelectorAll('a[href]')
    );

    const decisionLinks = [];

    for (const link of allLinks) {
      const href = link.href || '';

      if (!href.includes('/decisions/')) {
        continue;
      }

      if (href.includes('@@faceted_query')) {
        continue;
      }

      const text = clean(
        link.innerText ||
        link.textContent ||
        ''
      );

      decisionLinks.push({
        href,
        text
      });
    }

    const yearLinks = decisionLinks.filter(item => {
      const match = item.href.match(
        /\/(\d{1,2})-[^/]+-(\d{4})-\d{2}-\d{2}\//
      );

      return (
        match &&
        Number(match[2]) === TARGET_YEAR
      );
    });

    const paginationLinks = [
      ...new Set(
        allLinks
          .map(link => link.href)
          .filter(href =>
            href.includes('@@faceted_query')
          )
      )
    ];

    return {
      totalDecisionLinks: decisionLinks.length,
      yearLinks,
      paginationLinks
    };
  }, TARGET_YEAR);

  console.log('LIENS DE DÉCISIONS :');
  console.log(
    `Total : ${result.totalDecisionLinks}`
  );
  console.log('');

  console.log(
    `DÉCISIONS ${TARGET_YEAR} : ${result.yearLinks.length}`
  );
  console.log('');

  for (const item of result.yearLinks) {
    console.log('----------------------------------------');
    console.log(
      cleanText(item.text).substring(0, 250)
    );
    console.log(item.href);
  }

  console.log('');
  console.log('========================================');
  console.log('PAGINATION');
  console.log('========================================');
  console.log('');

  console.log(
    `Nombre de liens : ${result.paginationLinks.length}`
  );

  for (const url of result.paginationLinks) {
    console.log(url);
  }

  console.log('');
  console.log('========================================');
  console.log('FIN DU DIAGNOSTIC');
  console.log('========================================');

  await page.close();
  await browser.close();
}

main().catch(error => {
  console.error('');
  console.error('❌ ERREUR');
  console.error(error);
  process.exit(1);
});
