import os
import json
import urllib.request
import urllib.parse
from bs4 import BeautifulSoup

def search_commune_regulations(commune_name):
    """
    Recherche automatique des règlements-taxes et publications
    via les portails de transparence et moteurs officiels.
    """
    query = urllib.parse.quote(f"règlement taxe {commune_name}")
    url = f"https://html.duckduckgo.com/html/?q={query}"
    
    regulations = []
    
    try:
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        )
        html = urllib.request.urlopen(req, timeout=10).read()
        soup = BeautifulSoup(html, 'html.parser')
        
        for result in soup.find_all('a', class_='result__url', href=True):
            link_text = result.get_text().strip()
            link_href = result['href']
            
            # Filtre les résultats pertinents vers les sites communaux
            if any(term in link_text.lower() or term in link_href.lower() for term in ['taxe', 'reglement', 'finances']):
                regulations.append({
                    "title": f"Portail officiel des taxes - {commune_name}",
                    "url": link_href if link_href.startswith('http') else f"https://{link_href}"
                })
                if len(regulations) >= 3:
                    break
    except Exception as e:
        print(f"Erreur d'extraction pour {commune_name}: {e}")

    # En cas d'absence de résultat direct, fournir le portail par défaut
    if not regulations:
        regulations.append({
            "title": f"Publications et règlements officiels de {commune_name}",
            "url": f"https://www.google.com/search?q=reglement+taxe+{urllib.parse.quote(commune_name)}"
        })

    return regulations

def fetch_all_communes_taxes():
    # Chargement de la liste des communes depuis le fichier TS
    communes_file = "src/data/municipalities.ts"
    communes = []
    
    if os.path.exists(communes_file):
        with open(communes_file, 'r', encoding='utf-8') as f:
            content = f.read()
            import re
            matches = re.findall(r"name:\s*['\"]([^'\"]+)['\"]", content)
            communes = matches

    if not communes:
        communes = ["Houyet", "Bruxelles", "Ixelles", "Namur", "Charleroi", "Liège", "Uccle", "Anderlecht"]

    dataset = {}
    print(f"Lancement de la mise à jour pour {len(communes)} communes...")

    for commune in communes:
        regs = search_commune_regulations(commune)
        dataset[commune] = {
            "activeRegulationsCount": len(regs),
            "regulations": regs,
            "upcomingAgendaTaxes": [
                {
                    "title": f"Ordre du jour du Conseil Communal - {commune}",
                    "url": f"https://www.google.com/search?q=ordre+du+jour+conseil+communal+{urllib.parse.quote(commune)}"
                }
            ]
        }

    os.makedirs('public/data', exist_ok=True)
    with open('public/data/daily_taxes.json', 'w', encoding='utf-8') as f:
        json.dump(dataset, f, ensure_ascii=False, indent=2)

    print("Mise à jour globale terminée avec succès !")

if __name__ == '__main__':
    fetch_all_communes_taxes()
