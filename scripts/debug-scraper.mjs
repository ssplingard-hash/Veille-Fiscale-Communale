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

  for (const bStart of [0, 20]) {
    const url = `https://www.deliberations.be/${slug}/decisions${bStart ? `?b_start:int=${bStart}` : ''}`;
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    console.log(`  Taille du HTML reçu : ${html.length} caractères`);

    const pointLinkRegex = new RegExp(`/${slug}/decisions/[^/]+/[^/"?#]+`, 'i');
    const allLinks = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (pointLinkRegex.test(href)) allLinks.push(href);
    });

    console.log(`  Liens de décision trouvés (regex pointLinkRegex) : ${allLinks.length}`);
    if (allLinks.length > 0) {
      console.log(`  3 premiers exemples :`);
      allLinks.slice(0, 3).forEach((h) => console.log(`    - ${h}`));
      const taxMatches = allLinks.filter((h) => TAX_KEYWORDS.test(h));
      console.log(`  Dont correspondant au mot-clé "taxe" etc. : ${taxMatches.length}`);
    } else {
      // Aucun lien trouvé : on regarde s'il y a des indices de rendu JS (balises <script> volumineuses,
      // ou une structure "form"/"filtre" comme celle vue manuellement) pour confirmer l'hypothèse.
      const hasForm = $('form').length > 0;
      const scriptTags = $('script').length;
      console.log(`  Aucun lien de décision trouvé sur cette page.`);
      console.log(`  Présence d'un <form> : ${hasForm} | Nombre de balises <script> : ${scriptTags}`);
      console.log(`  Aperçu des 500 premiers caractères du HTML :`);
      console.log('  ---');
      console.log('  ' + html.slice(0, 500).replace(/\n/g, '\n  '));
      console.log('  ---');
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
