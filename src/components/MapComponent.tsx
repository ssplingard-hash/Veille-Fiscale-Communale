import { ComposableMap, Geographies, Geography, ZoomableGroup } from "react-simple-maps";
import { useState } from "react";
import { Plus, Minus } from "lucide-react";
import { municipalities } from '../data/municipalities';
import { useNavigate } from 'react-router-dom';

const geoUrl = `${import.meta.env.BASE_URL}map.json`;

interface MapProps {
  mapType: 'IPP' | 'PRI' | 'TAXES';
  selectedProvince: string | null;
}

export default function MapComponent({ mapType, selectedProvince }: MapProps) {
  const navigate = useNavigate();
  const [position, setPosition] = useState({ coordinates: [4.8, 50.5] as [number, number], zoom: 1 });

  const handleZoomIn = () => {
    if (position.zoom >= 4) return;
    setPosition(pos => ({ ...pos, zoom: pos.zoom * 1.5 }));
  };

  const handleZoomOut = () => {
    if (position.zoom <= 1) return;
    setPosition(pos => ({ ...pos, zoom: pos.zoom / 1.5 }));
  };

  const handleMoveEnd = (position: any) => {
    setPosition(position);
  };

  // Helper to color the communes
  const getColor = (muniName: string) => {
    const data = municipalities.find(m => m.name === muniName || m.name.includes(muniName) || muniName.includes(m.name));
    if (!data) return "#334155"; // slate-700
    
    // Sort array to get rank
    const sorted = [...municipalities].sort((a, b) => {
      if (mapType === 'IPP') return b.ipp - a.ipp;
      if (mapType === 'PRI') return b.pri - a.pri;
      return b.taxCount - a.taxCount;
    });
    const idx = sorted.findIndex(m => m.name === data.name);
    const ratio = idx / (sorted.length - 1 || 1);
    const hue = ratio * 120; // 0=Red, 120=Green
    return `hsl(${hue}, 70%, 50%)`;
  };

  return (
    <div className="relative w-full h-[500px] overflow-hidden rounded-xl border border-slate-700 bg-slate-900/50">
      <div className="absolute top-4 right-4 flex flex-col gap-2 z-10">
        <button onClick={handleZoomIn} className="p-2 bg-slate-800 border border-slate-600 rounded-lg hover:bg-slate-700 text-slate-300 transition-colors">
          <Plus size={20} />
        </button>
        <button onClick={handleZoomOut} className="p-2 bg-slate-800 border border-slate-600 rounded-lg hover:bg-slate-700 text-slate-300 transition-colors">
          <Minus size={20} />
        </button>
      </div>
      <ComposableMap 
        projection="geoMercator"
        projectionConfig={{
          scale: 10000,
          center: [4.8, 50.5] // Center over Wallonia
        }}
        width={800}
        height={500}
        style={{ width: "100%", height: "100%" }}
      >
        <ZoomableGroup
          zoom={position.zoom}
          center={position.coordinates}
          onMoveEnd={handleMoveEnd}
        >
          <Geographies geography={geoUrl}>
          {({ geographies }) =>
            geographies.map((geo) => {
              // Only render Wallonia and Brussels
              if (geo.properties.reg_nis === '02000') return null; // Filter out Flanders
              
              const isBrussels = geo.properties.reg_nis === '04000';
              let normProv = 'Inconnu';
              if (isBrussels) {
                normProv = 'Bruxelles';
              } else {
                const provFr = geo.properties.prov_fr || '';
                if (provFr.includes('Hainaut')) normProv = 'Hainaut';
                else if (provFr.includes('Liège')) normProv = 'Liège';
                else if (provFr.includes('Namur')) normProv = 'Namur';
                else if (provFr.includes('Luxembourg')) normProv = 'Luxembourg';
                else if (provFr.includes('Brabant wallon')) normProv = 'Brabant wallon';
              }

              if (selectedProvince && selectedProvince !== 'Toutes' && selectedProvince !== normProv) {
                return null; // hide if not selected province
              }

              const fill = getColor(geo.properties.name_fr);

              return (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  onClick={() => {
                    const match = municipalities.find(m => m.name === geo.properties.name_fr || m.name.includes(geo.properties.name_fr) || geo.properties.name_fr.includes(m.name));
                    if (match) navigate(`/commune/${encodeURIComponent(match.name)}`);
                  }}
                  style={{
                    default: {
                      fill: fill,
                      outline: "none",
                      stroke: "#1e293b",
                      strokeWidth: 0.5,
                      transition: "all 250ms"
                    },
                    hover: {
                      fill: "#818cf8", // indigo-400
                      outline: "none",
                      stroke: "#f8fafc",
                      strokeWidth: 1,
                      cursor: "pointer"
                    },
                    pressed: {
                      fill: "#6366f1",
                      outline: "none",
                    },
                  }}
                />
              );
            })
          }
        </Geographies>
        </ZoomableGroup>
      </ComposableMap>
    </div>
  );
}
