import fs from 'fs';

async function fetchCommunes() {
  try {
    // Wikidata query to get municipalities of Wallonia and Brussels
    // Q240 = Brussels
    // Q3392 = Wallonia
    // Q493522 = municipality of Belgium
    const query = `
      SELECT ?muniLabel ?regionLabel WHERE {
        ?muni wdt:P31/wdt:P279* wd:Q493522.
        ?muni wdt:P17 wd:Q31.
        ?muni wdt:P131* ?region.
        FILTER(?region IN (wd:Q240, wd:Q3392))
        SERVICE wikibase:label { bd:serviceParam wikibase:language "fr". }
      }
    `;
    const url = 'https://query.wikidata.org/sparql?query=' + encodeURIComponent(query) + '&format=json';
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Node.js)' }});
    const data = await response.json();
    
    const results = data.results.bindings;
    let munis = new Map();
    
    for (let row of results) {
       const name = row.muniLabel.value;
       const region = row.regionLabel.value;
       if (!name.startsWith('Q')) {
          munis.set(name, region.includes('Bruxelles') ? 'Bruxelles' : 'Wallonie');
       }
    }
    
    const array = Array.from(munis.entries()).map(([name, region]) => {
      // random values for mock data
      const ipp = (5 + Math.random() * 4).toFixed(1);
      const pri = Math.floor(2000 + Math.random() * 1500);
      const taxCount = Math.floor(10 + Math.random() * 50);
      return `  { name: "${name.replace(/"/g, '\\"')}", region: '${region}', ipp: ${ipp}, pri: ${pri}, taxCount: ${taxCount} }`;
    });
    
    const output = `import { BaseCommune } from '../types';

export const municipalities: BaseCommune[] = [
${array.join(',\n')}
];
`;
    fs.writeFileSync('src/data/municipalities.ts', output);
    console.log(`Generated ${array.length} municipalities.`);
  } catch (e) {
    console.error(e);
  }
}
fetchCommunes();
