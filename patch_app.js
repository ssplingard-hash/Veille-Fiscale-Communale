import fs from 'fs';

let appCode = fs.readFileSync('src/App.tsx', 'utf8');

if (!appCode.includes('import Discussions')) {
  appCode = appCode.replace("import Directory from './pages/Directory';", "import Directory from './pages/Directory';\nimport Discussions from './pages/Discussions';\nimport Adoptions from './pages/Adoptions';");
  
  appCode = appCode.replace('<Route path="annuaire" element={<Directory />} />', '<Route path="annuaire" element={<Directory />} />\n          <Route path="discussions" element={<Discussions />} />\n          <Route path="adoptions" element={<Adoptions />} />');
  
  fs.writeFileSync('src/App.tsx', appCode);
}
