import fs from 'fs';

let code = fs.readFileSync('src/pages/Dashboard.tsx', 'utf8');

code = code.replace(
  '<p className="text-slate-400 mt-0.5">{item.date}</p>',
  '<div className="flex items-center gap-2 mt-0.5"><span className="text-[10px] uppercase font-bold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">{item.domaine}</span><p className="text-slate-400 text-xs">{item.date}</p></div>'
);

code = code.replace(
  '<p className="text-slate-400 mt-0.5">{item.date}</p>',
  '<div className="flex items-center gap-2 mt-0.5"><span className="text-[10px] uppercase font-bold text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded">{item.domaine}</span><p className="text-slate-400 text-xs">{item.date}</p></div>'
);

// We also need to add import for mockDiscussions and mockAdoptions and remove the local array definition.
code = code.replace(
  "import { municipalities } from '../data/municipalities';",
  "import { municipalities } from '../data/municipalities';\nimport { mockDiscussions, mockAdoptions } from '../data/news';"
);

// Remove the local mockDiscussions
code = code.replace(/const mockDiscussions = \[[\s\S]*?\];/m, '');
// Remove the local mockAdoptions
code = code.replace(/const mockAdoptions = \[[\s\S]*?\];/m, '');

fs.writeFileSync('src/pages/Dashboard.tsx', code);
