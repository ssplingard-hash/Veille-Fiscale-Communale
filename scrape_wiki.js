import https from 'https';

function fetchPage(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
  });
}

async function run() {
  const walloniaHtml = await fetchPage('https://fr.wikipedia.org/wiki/Liste_des_communes_de_la_R%C3%A9gion_wallonne');
  // It has a table with 262 communes
  // We can regex it or use cheerio, let's just use regex for now or save to parse
  const bruxellesHtml = await fetchPage('https://fr.wikipedia.org/wiki/Liste_des_communes_de_la_R%C3%A9gion_de_Bruxelles-Capitale');
  
  import('fs').then(fs => {
    fs.writeFileSync('w.html', walloniaHtml);
    fs.writeFileSync('b.html', bruxellesHtml);
  });
}
run();
