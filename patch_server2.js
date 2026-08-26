import fs from 'fs';

let serverCode = fs.readFileSync('server.ts', 'utf8');

serverCode = serverCode.replace(
  "console.warn('API Failed, using fallback data for:', municipality, error.message);",
  "console.warn('API Failed, using fallback data for:', req.body.municipality, error.message);"
);

serverCode = serverCode.replace(
  "commune: municipality,",
  "commune: req.body.municipality,"
);

fs.writeFileSync('server.ts', serverCode);
