import fs from 'fs';
import https from 'https';

const getJSON = (url) => new Promise((resolve, reject) => {
  https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => resolve(JSON.parse(data)));
  }).on('error', reject);
});

async function run() {
  try {
    const geojson = await getJSON('https://raw.githubusercontent.com/mathiasleroy/belgium-geographic-data/master/municipalities/municipalities.geojson');
    console.log(`Loaded ${geojson.features.length} features.`);
    // Save locally
    fs.writeFileSync('src/data/municipalities_geo.json', JSON.stringify(geojson));
  } catch(e) {
    console.error(e);
  }
}
run();
