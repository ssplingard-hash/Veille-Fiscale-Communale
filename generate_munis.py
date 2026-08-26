import urllib.request
import urllib.parse
import json
import random

def get_category_members(category):
    category_encoded = urllib.parse.quote(category)
    url = f"https://fr.wikipedia.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:{category_encoded}&cmlimit=500&format=json"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read().decode('utf-8'))
    return [m['title'] for m in data['query']['categorymembers'] if not m['title'].startswith('Catégorie:')]

bruxelles = get_category_members("Commune_dans_la_région_de_Bruxelles-Capitale")

# We want filter by province too!
provinces = {
    "Brabant wallon": "Commune_dans_la_province_du_Brabant_wallon",
    "Hainaut": "Commune_dans_la_province_de_Hainaut",
    "Liège": "Commune_dans_la_province_de_Liège",
    "Luxembourg": "Commune_dans_la_province_de_Luxembourg",
    "Namur": "Commune_dans_la_province_de_Namur"
}

munis = []

for name in bruxelles:
    name = name.split(" (")[0]
    munis.append({'name': name, 'region': 'Bruxelles', 'province': 'Bruxelles'})

for prov_name, category in provinces.items():
    members = get_category_members(category)
    for name in members:
        name = name.split(" (")[0]
        munis.append({'name': name, 'region': 'Wallonie', 'province': prov_name})

# Clean duplicates if any
seen = set()
unique_munis = []
for m in munis:
    if m['name'] not in seen:
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

print(f"Generated {len(unique_munis)} municipalities.")
