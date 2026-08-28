import os
import json
import urllib.request
from bs4 import BeautifulSoup

COMMUNAL_PORTALS = {
    "Bruxelles": {
        "regulations_search": "https://transparence.brussels/actes?commune=bruxelles&type=taxe",
        "agenda_url": "https://www.brussels.be/conseil-communal"
    },
    "Ixelles": {
        "regulations_search": "https://www.ixelles.be/site/75-Reglements-taxes-et-redevances",
        "agenda_url": "https://www.ixelles.be/site/83-Ordres-du-jour"
    },
    "Namur": {
        "regulations_search": "https://www.namur.be/fr/ma-commune/finances/reglements-taxes",
        "agenda_url": "https://www.namur.be/fr/ma-commune/vie-politique/conseil-communal"
    }
}

def fetch_commune_tax_details():
    dataset = {}
    
    for commune, urls in COMMUNAL_PORTALS.items():
        dataset[commune] = {
            "activeRegulationsCount": 0,
            "regulations": [],
            "upcomingAgendaTaxes": []
        }
        
        try:
            req = urllib.request.Request(urls["regulations_search"], headers={'User-Agent': 'Mozilla/5.0'})
            html = urllib.request.urlopen(req, timeout=10).read()
            soup = BeautifulSoup(html, 'html.parser')
            
            for link in soup.find_all('a', href=True):
                href = link['href']
                text = link.get_text().strip()
                if text and ('taxe' in text.lower() or 'reglement' in text.lower()):
                    full_url = href if href.startswith('http') else urls["regulations_search"] + href
                    dataset[commune]["regulations"].append({
                        "title": text,
                        "url": full_url
                    })
            
            dataset[commune]["activeRegulationsCount"] = len(dataset[commune]["regulations"])
        except Exception as e:
            print(f"Erreur d'extraction pour {commune}: {e}")

    # S'assurer que le dossier public/data existe
    os.makedirs('public/data', exist_ok=True)
            
    with open('public/data/daily_taxes.json', 'w', encoding='utf-8') as f:
        json.dump(dataset, f, ensure_ascii=False, indent=2)

    print("Extraction terminee avec succes !")

if __name__ == '__main__':
    fetch_commune_tax_details()
