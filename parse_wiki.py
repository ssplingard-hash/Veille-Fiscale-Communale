import re
import json
import random

with open('w.html', 'r', encoding='utf-8') as f:
    w_html = f.read()
    
with open('b.html', 'r', encoding='utf-8') as f:
    b_html = f.read()

munis = []

# Wallonia table usually has: <td><a href="..." title="CommuneA">CommuneA</a></td> ... <td><a href="..." title="Province de X">X</a></td>
# Let's be simpler: we can just find the large table in w.html
# Let's try to parse with bs4
from bs4 import BeautifulSoup

soup_w = BeautifulSoup(w_html, 'html.parser')
tables = soup_w.find_all('table', class_='wikitable')
for table in tables:
    for row in table.find_all('tr')[1:]:
        cols = row.find_all('td')
        if len(cols) >= 5:
            # col 0: Name (with a link)
            a_name = cols[0].find('a')
            if a_name:
                name = a_name.text.strip()
                # col 4 or something is province
                # Col 0: Commune, Col 1: Titre, Col 2: Province, Col 3: Arrondissement
                prov = cols[2].text.strip()
                # fix province string if it has "Province de" or similar
                if "Hainaut" in prov: prov = "Hainaut"
                elif "Liège" in prov: prov = "Liège"
                elif "Luxembourg" in prov: prov = "Luxembourg"
                elif "Namur" in prov: prov = "Namur"
                elif "Brabant" in prov: prov = "Brabant wallon"
                
                if name:
                    munis.append({
                        'name': name,
                        'region': 'Wallonie',
                        'province': prov
                    })
                    
soup_b = BeautifulSoup(b_html, 'html.parser')
tables_b = soup_b.find_all('table', class_='wikitable')
if tables_b:
    for row in tables_b[0].find_all('tr')[1:]:
        cols = row.find_all('td')
        if len(cols) >= 3:
            # col 1 or 2 is usually French name
            # For Brussels, column 0 is Francophone name, col 1 is NL name, or col 0 is ZIP, etc.
            # let's find the first valid string
            a_name = cols[0].find('a')
            if a_name:
                name = a_name.text.strip()
                # filter some numbers if it's zip
                if name.isdigit():
                    a_name = cols[1].find('a')
                    name = a_name.text.strip() if a_name else cols[1].text.strip()
                    
                munis.append({
                    'name': name,
                    'region': 'Bruxelles',
                    'province': 'Bruxelles'
                })

# Remove duplicates
seen = set()
unique_munis = []
for m in munis:
    if m['name'] not in seen and len(m['name']) > 1:
        seen.add(m['name'])
        unique_munis.append(m)

with open('src/data/municipalities.ts', 'w', encoding='utf-8') as f:
    f.write("export interface BaseCommune {\n")
    f.write("  name: string;\n")
    f.write("  region: string;\n")
    f.write("  province: string;\n")
    f.write("  ipp: number;\n")
    f.write("  pri: number;\n")
    f.write("  taxCount: number;\n")
    f.write("}\n\n")
    f.write("export const municipalities: BaseCommune[] = [\n")
    for m in unique_munis:
        ipp = round(5 + random.random() * 4, 1)
        pri = int(2000 + random.random() * 1500)
        taxCount = int(10 + random.random() * 50)
        name_escaped = m['name'].replace("'", "\\'")
        f.write(f"  {{ name: '{name_escaped}', region: '{m['region']}', province: '{m['province']}', ipp: {ipp}, pri: {pri}, taxCount: {taxCount} }},\n")
    f.write("];\n")

print(f"Parsed {len(unique_munis)} municipalities.")
