import fs from 'fs';

let code = fs.readFileSync('src/pages/Dashboard.tsx', 'utf8');

// Add "Voir tout" button for Discussions
code = code.replace(
  '<h2 className="text-lg font-semibold text-white">Nouvelles taxes en discussion</h2>',
  '<h2 className="text-lg font-semibold text-white flex-1">Nouvelles taxes en discussion</h2><button onClick={() => navigate("/discussions")} className="text-sm font-medium text-amber-500 hover:text-amber-400 transition-colors">Voir tout</button>'
);

// Add "Voir tout" button for Adoptions
code = code.replace(
  '<h2 className="text-lg font-semibold text-white">Règlements récemment adoptés</h2>',
  '<h2 className="text-lg font-semibold text-white flex-1">Règlements récemment adoptés</h2><button onClick={() => navigate("/adoptions")} className="text-sm font-medium text-emerald-500 hover:text-emerald-400 transition-colors">Voir tout</button>'
);

fs.writeFileSync('src/pages/Dashboard.tsx', code);
