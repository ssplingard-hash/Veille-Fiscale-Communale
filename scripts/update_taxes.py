import os
import json
import re
import urllib.parse

def generate_commune_data(name, region):
    encoded_name = urllib.parse.quote(name)
    
    # URL ciblée selon la région
    if region == "Bruxelles-Capitale":
        reg_url = f"https://transparence.brussels/actes?q=taxe+{encoded_name}"
        agenda_url = f"https://www.google.com/search?q=ordre+du+jour+conseil+communal+{encoded_name}"
    else:
        reg_url = f"https://e-services.wallonie.be/e-legalite/search?q=taxe+{encoded_name}"
        agenda_url = f"https://www.google.com/search?q=ordre+du+jour+conseil+communal+{encoded_name}"

    return {
        "activeRegulationsCount": 1,
        "regulations": [
            {
                "title": f"Règlements-taxes officiels - {name}",
                "url": reg_url
            }
        ],
        "upcomingAgendaTaxes": [
            {
                "title": f"Prochains ordres du jour & délibérations - {name}",
                "url": agenda_url
            }
        ]
    }

def fetch_all_communes_taxes():
    communes_file = "src/data/municipalities.ts"
    dataset = {}
    
    if os.path.exists(communes_file):
        with open(communes_file, 'r', encoding='utf-8') as f:
            content = f.read()
            # Extraction des noms et régions
            matches = re.findall(r"name:\s*['\"]([^'\"]+)['\"].*?region:\s*['\"]([^'\"]+)['\"]", content, re.DOTALL)
            for name, region in matches:
                dataset[name] = generate_commune_data(name, region)

    # Si le fichier TS n'est pas lu correctement, liste de secours
    if not dataset:
        default_communes = ["Bruxelles", "Ixelles", "Namur", "Houyet", "Charleroi", "Liège", "Uccle"]
        for c in default_communes:
            dataset[c] = generate_commune_data(c, "Wallonie")

    os.makedirs('public/data', exist_ok=True)
    with open('public/data/daily_taxes.json', 'w', encoding='utf-8') as f:
        json.dump(dataset, f, ensure_ascii=False, indent=2)

    print(f"Génération instantanée terminée pour {len(dataset)} communes !")

if __name__ == '__main__':
    fetch_all_communes_taxes()
