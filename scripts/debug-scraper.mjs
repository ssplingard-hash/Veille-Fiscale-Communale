/**
 * Script de DIAGNOSTIC uniquement (pas le scraper de production).
 * Teste 3 communes (une qui échoue, une qui réussit, une grande ville) et affiche
 * en détail ce que le fetch reçoit réellement, pour comprendre pourquoi certaines
 * communes ne donnent aucun résultat alors qu'elles ont clairement des règlements-
 * taxes publiés.
 *
 * Usage : node scripts/debug-scraper.mjs
 * Ne modifie AUCUN fichier — affiche seulement des informations dans les logs.
 */

import * as cheerio from 'cheerio';

const USER_AGENT = 'VeilleFiscaleCommunale-bot/1.0 (+contact: voir depot GitHub)';
const TAX_KEYWORDS = /(taxe|precompte|pr%C3%A9compte|impot|imp%C3%B4t|ipp|redevance)/i;

const TEST_COMMUNES = ['aiseau-presles', 'ecaussinnes', 'liege'];

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'fr' } });
  console.log(`  [HTTP ${res.status}] ${url}`);
  return res.text();
}

async function diagnose(slug) {
  console.log(`\n========== ${slug} ==========`);

  const testUrls = [
    { label: 'page 0 (sans param)', url: `https://www.deliberations.be/${slug}/decisions` },
    { label: 'page 2 (b_start=20)', url: `https://www.deliberations.be/${slug}/decisions?b_start:int=20` },
    { label: 'avec SearchableText factice', url: `https://www.deliberations.be/${slug}/decisions?SearchableText=x` },
    { label: 'avec paramètre Année', url: `https://www.deliberations.be/${slug}/decisions?getVenteYear=2026` },
  ];

  for (const { label, url } of testUrls) {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    console.log(`  [${label}] Taille du HTML reçu : ${html.length} caractères`);

    const pointLinkRegex = new RegExp(`/${slug}/decisions/[^/]+/[^/"?#]+`, 'i');
    const allLinks = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (pointLinkRegex.test(href)) allLinks.push(href);
    });

    console.log(`  [${label}] Liens de décision trouvés : ${allLinks.length}`);
    if (allLinks.length > 0) {
      allLinks.slice(0, 2).forEach((h) => console.log(`    - ${h}`));
    }
  }
}

async function main() {
  for (const slug of TEST_COMMUNES) {
    await diagnose(slug);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
