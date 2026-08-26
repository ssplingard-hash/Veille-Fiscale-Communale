import fs from 'fs';

let code = fs.readFileSync('src/pages/Discussions.tsx', 'utf8');

const selectHtml = `        <div className="flex gap-3">
          <select
            value={selectedProvince}
            onChange={(e) => setSelectedProvince(e.target.value)}
            className="px-4 py-2 bg-slate-800 border border-slate-700 text-sm font-medium text-white rounded-lg outline-none focus:ring-2 focus:ring-amber-500"
          >
            {provinces.map(p => (
              <option key={p} value={p}>{p === 'Toutes' ? 'Toutes provinces' : p}</option>
            ))}
          </select>

          <select
            value={selectedDomaine}
            onChange={(e) => setSelectedDomaine(e.target.value)}
            className="px-4 py-2 bg-slate-800 border border-slate-700 text-sm font-medium text-white rounded-lg outline-none focus:ring-2 focus:ring-amber-500"
          >
            {domaines.map(d => (
              <option key={d} value={d}>{d === 'Tous' ? 'Toutes matières' : d}</option>
            ))}
          </select>
        </div>`;

code = code.replace(
  "const provinces = ['Toutes', 'Bruxelles', 'Brabant wallon', 'Hainaut', 'Liège', 'Luxembourg', 'Namur'];",
  "const provinces = ['Toutes', 'Bruxelles', 'Brabant wallon', 'Hainaut', 'Liège', 'Luxembourg', 'Namur'];\n  const [selectedDomaine, setSelectedDomaine] = useState<string>('Tous');\n  const domaines = ['Tous', 'Environnement', 'Economie', 'Commerce', 'PME', 'Indépendants', 'Mobilité', 'Professions libérales'];"
);

code = code.replace(
  "const filtered = selectedProvince === 'Toutes' ? mockDiscussions : mockDiscussions.filter(d => d.province === selectedProvince);",
  "const filtered = mockDiscussions.filter(d => (selectedProvince === 'Toutes' || d.province === selectedProvince) && (selectedDomaine === 'Tous' || d.domaine === selectedDomaine));"
);

code = code.replace(
  /<select[\s\S]*?<\/select>/,
  selectHtml
);

code = code.replace(
  '<span className="px-3 py-1 bg-slate-900 border border-slate-700 rounded-full text-xs font-medium text-slate-300 flex items-center gap-1.5">',
  '<span className="px-3 py-1 bg-slate-900 border border-slate-700 rounded-full text-xs font-medium text-slate-300 flex items-center gap-1.5">\n                  <span className="px-2 py-0.5 bg-slate-800 rounded text-[10px] uppercase font-bold text-slate-400 mr-2">{item.domaine}</span>'
);

fs.writeFileSync('src/pages/Discussions.tsx', code);
