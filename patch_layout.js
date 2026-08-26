import fs from 'fs';

let layoutCode = fs.readFileSync('src/components/Layout.tsx', 'utf8');

if (!layoutCode.includes('path: \'/discussions\'')) {
  layoutCode = layoutCode.replace(
    "import { LayoutDashboard, Users, Search, Bell } from 'lucide-react';",
    "import { LayoutDashboard, Users, Search, Bell, Activity, FileCheck } from 'lucide-react';"
  );
  
  layoutCode = layoutCode.replace(
    "{ path: '/annuaire', icon: Users, label: 'Annuaire' },",
    "{ path: '/discussions', icon: Activity, label: 'Taxes en discussion' },\n    { path: '/adoptions', icon: FileCheck, label: 'Règlements adoptés' },\n    { path: '/annuaire', icon: Users, label: 'Annuaire' },"
  );
  
  fs.writeFileSync('src/components/Layout.tsx', layoutCode);
}
