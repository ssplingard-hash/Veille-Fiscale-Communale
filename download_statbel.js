import https from 'https';

https.get('https://raw.githubusercontent.com/jief/zipcode-belgium/master/zipcode-belgium.json', (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const list = JSON.parse(data);
    const munis = {};
    list.forEach(item => {
      const zip = parseInt(item.zip);
      let prov = '';
      let reg = '';
      if (zip >= 1000 && zip <= 1299) { reg = 'Bruxelles'; prov = 'Bruxelles'; }
      else if (zip >= 1300 && zip <= 1499) { reg = 'Wallonie'; prov = 'Brabant wallon'; }
      else if (zip >= 4000 && zip <= 4999) { reg = 'Wallonie'; prov = 'Liège'; }
      else if (zip >= 5000 && zip <= 5999) { reg = 'Wallonie'; prov = 'Namur'; }
      else if (zip >= 6000 && zip <= 6599) { reg = 'Wallonie'; prov = 'Hainaut'; }
      else if (zip >= 6600 && zip <= 6999) { reg = 'Wallonie'; prov = 'Luxembourg'; }
      else if (zip >= 7000 && zip <= 7999) { reg = 'Wallonie'; prov = 'Hainaut'; }
      
      if (reg) {
        if (!munis[item.city]) {
          munis[item.city] = { name: item.city, region: reg, province: prov };
        }
      }
    });
    console.log(`Found ${Object.keys(munis).length} entities.`);
  })
});
