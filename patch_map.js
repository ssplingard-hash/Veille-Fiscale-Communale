import fs from 'fs';

let code = fs.readFileSync('src/components/MapComponent.tsx', 'utf8');

if (!code.includes('ZoomableGroup')) {
  code = code.replace(
    'import { ComposableMap, Geographies, Geography } from "react-simple-maps";',
    'import { ComposableMap, Geographies, Geography, ZoomableGroup } from "react-simple-maps";\nimport { useState } from "react";\nimport { Plus, Minus } from "lucide-react";'
  );
  
  // Add state to MapComponent
  code = code.replace(
    'const navigate = useNavigate();',
    'const navigate = useNavigate();\n  const [position, setPosition] = useState({ coordinates: [4.8, 50.5] as [number, number], zoom: 1 });\n\n  const handleZoomIn = () => {\n    if (position.zoom >= 4) return;\n    setPosition(pos => ({ ...pos, zoom: pos.zoom * 1.5 }));\n  };\n\n  const handleZoomOut = () => {\n    if (position.zoom <= 1) return;\n    setPosition(pos => ({ ...pos, zoom: pos.zoom / 1.5 }));\n  };\n\n  const handleMoveEnd = (position: any) => {\n    setPosition(position);\n  };'
  );
  
  // Wrap Geographies in ZoomableGroup
  code = code.replace(
    '<Geographies geography={geoUrl}>',
    '<ZoomableGroup\n          zoom={position.zoom}\n          center={position.coordinates}\n          onMoveEnd={handleMoveEnd}\n        >\n          <Geographies geography={geoUrl}>'
  );
  
  code = code.replace(
    '</Geographies>',
    '</Geographies>\n        </ZoomableGroup>'
  );
  
  // Add controls on top of map
  code = code.replace(
    '<div className="w-full h-[500px] overflow-hidden rounded-xl border border-slate-700 bg-slate-900/50">',
    '<div className="relative w-full h-[500px] overflow-hidden rounded-xl border border-slate-700 bg-slate-900/50">\n      <div className="absolute top-4 right-4 flex flex-col gap-2 z-10">\n        <button onClick={handleZoomIn} className="p-2 bg-slate-800 border border-slate-600 rounded-lg hover:bg-slate-700 text-slate-300 transition-colors">\n          <Plus size={20} />\n        </button>\n        <button onClick={handleZoomOut} className="p-2 bg-slate-800 border border-slate-600 rounded-lg hover:bg-slate-700 text-slate-300 transition-colors">\n          <Minus size={20} />\n        </button>\n      </div>'
  );
  
  fs.writeFileSync('src/components/MapComponent.tsx', code);
}
