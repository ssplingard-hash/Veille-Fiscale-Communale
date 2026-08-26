import fs from 'fs';

const w = fs.readFileSync('w.html', 'utf-8');
const b = fs.readFileSync('b.html', 'utf-8');

const munis = [];

// Wallonia matches:
// <tr>...<td><a href="/wiki/Aiseau-Presles" title="Aiseau-Presles">Aiseau-Presles</a></td>...<td>...</td><td><a href="/wiki/Province_de_Hainaut" title="Province de Hainaut">Hainaut</a></td>
// Let's use a simpler match:
// Find all rows in wikitable.
let wTableMatch = w.match(/<table class="wikitable.*?>(.*?)<\/table>/s);
if (wTableMatch) {
  let rows = wTableMatch[1].match(/<tr.*?>.*?<\/tr>/gs);
  if (rows) {
    for (let row of rows) {
      let cols = row.match(/<td.*?>(.*?)<\/td>/gs);
      if (cols && cols.length >= 5) {
        let nameMatch = cols[0].match(/<a.*?>(.*?)<\/a>/);
        let name = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : cols[0].replace(/<[^>]+>/g, '').trim();
        
        let provMatch = cols[2].replace(/<[^>]+>/g, '').trim();
        let prov = 'Inconnu';
        if (provMatch.includes('Hainaut')) prov = 'Hainaut';
        if (provMatch.includes('Liège')) prov = 'Liège';
        if (provMatch.includes('Namur')) prov = 'Namur';
        if (provMatch.includes('Luxembourg')) prov = 'Luxembourg';
        if (provMatch.includes('Brabant')) prov = 'Brabant wallon';
        
        if (name && name !== 'Commune') {
          munis.push({ name, region: 'Wallonie', province: prov });
        }
      }
    }
  }
}

let bTableMatch = b.match(/<table class="wikitable.*?>(.*?)<\/table>/s);
if (bTableMatch) {
  let rows = bTableMatch[1].match(/<tr.*?>.*?<\/tr>/gs);
  if (rows) {
    for (let row of rows) {
      let cols = row.match(/<td.*?>(.*?)<\/td>/gs);
      if (cols && cols.length >= 2) {
        let nameMatch = cols[0].match(/<a.*?>(.*?)<\/a>/);
        let name = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : cols[0].replace(/<[^>]+>/g, '').trim();
        if (name.match(/^\d+$/)) { // if it's zip code
          let nameMatch2 = cols[1].match(/<a.*?>(.*?)<\/a>/);
          name = nameMatch2 ? nameMatch2[1].replace(/<[^>]+>/g, '').trim() : cols[1].replace(/<[^>]+>/g, '').trim();
        }
        if (name && name !== 'Commune') {
          munis.push({ name, region: 'Bruxelles', province: 'Bruxelles' });
        }
      }
    }
  }
}

let unique = [];
let seen = new Set();
for (let m of munis) {
  if (!seen.has(m.name) && m.name.length > 1) {
    seen.add(m.name);
    unique.push(m);
  }
}

let out = `export interface BaseCommune {
  name: string;
  region: string;
  province: string;
  ipp: number;
  pri: number;
  taxCount: number;
}

export const municipalities: BaseCommune[] = [
`;
unique.forEach(m => {
  let ipp = (5 + Math.random() * 4).toFixed(1);
  let pri = Math.floor(2000 + Math.random() * 1500);
  let taxCount = Math.floor(10 + Math.random() * 50);
  let nameEsc = m.name.replace(/'/g, "\\'");
  out += `  { name: '${nameEsc}', region: '${m.region}', province: '${m.province}', ipp: ${ipp}, pri: ${pri}, taxCount: ${taxCount} },\n`;
});
out += `];\n`;

fs.writeFileSync('src/data/municipalities.ts', out);
console.log(`Generated ${unique.length} municipalities.`);
