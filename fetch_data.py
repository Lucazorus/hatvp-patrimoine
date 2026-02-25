#!/usr/bin/env python3
"""
Télécharge les données HATVP (DIA deputés) + groupes Assemblée Nationale
et génère un data.json utilisable par le site statique.
"""

import csv
import json
import re
import html as htmlmod
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import StringIO

CSV_URL = "https://www.hatvp.fr/livraison/opendata/liste.csv"
AN_HEMICYCLE_URL = "https://www.assemblee-nationale.fr/dyn/vos-deputes/hemicycle"
AN_EMBED_BASE = "https://www.assemblee-nationale.fr/dyn/embed/acteur-presentation/"
DOSSIERS_BASE = "https://www.hatvp.fr/livraison/dossiers/"

# ── Helpers ────────────────────────────────────────────────────────────────

def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")

def progress(msg, pct=None):
    if pct is not None:
        bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
        print(f"\r[{bar}] {pct:3d}%  {msg}", end="", flush=True)
    else:
        print(f"\n{msg}", flush=True)

# ── Groupes parlementaires depuis l'Assemblée Nationale ───────────────────

def fetch_pa_presentation(pa_id):
    """Fetches the embed page for a deputy and returns (nom, groupe, couleur)."""
    try:
        html = fetch(AN_EMBED_BASE + pa_id, timeout=10)
        # Extract name from <a href="/dyn/deputes/PA...">Name</a>
        nom_match = re.search(r'href="/dyn/deputes/PA\d+"[^>]*>([^<]+)</a>', html)
        nom = nom_match.group(1).strip() if nom_match else ""
        # Extract groupe from background-color span
        groupe_match = re.search(r'background-color:[^;]+;\s*color:[^"]+">.*?<span>([^<]+)</span>', html, re.DOTALL)
        groupe = groupe_match.group(1).strip() if groupe_match else ""
        # Extract color
        color_match = re.search(r'background-color:\s*(#[0-9a-fA-F]{6})', html)
        couleur = color_match.group(1) if color_match else ""
        return pa_id, nom, groupe, couleur
    except Exception:
        return pa_id, "", "", ""

def load_groupes():
    progress("Extraction des PA IDs depuis l'hémicycle AN...")
    try:
        html = fetch(AN_HEMICYCLE_URL, timeout=15)
        # Extract JSON blobs: {"couleur":"#...","tooltipUrl":"/dyn/embed/acteur-presentation/PA..."}
        raw_blocks = re.findall(r'\{&quot;couleur&quot;[^}]+\}', html)
        pa_ids = []
        for b in raw_blocks:
            decoded = htmlmod.unescape(b)
            try:
                obj = json.loads(decoded)
                pa_match = re.search(r'PA(\d+)', obj.get('tooltipUrl', ''))
                if pa_match:
                    pa_ids.append('PA' + pa_match.group(1))
            except Exception:
                pass
        pa_ids = list(dict.fromkeys(pa_ids))  # deduplicate preserving order
        progress(f"  → {len(pa_ids)} PA IDs extraits")
    except Exception as e:
        progress(f"  ⚠ Impossible d'accéder à l'hémicycle: {e}")
        return {}

    progress(f"\nRécupération des groupes ({len(pa_ids)} requêtes AN)...")
    groupes_by_nom = {}   # key: nom normalisé → {groupe, couleur, groupe_complet}
    done = 0

    with ThreadPoolExecutor(max_workers=20) as pool:
        futures = {pool.submit(fetch_pa_presentation, pid): pid for pid in pa_ids}
        for fut in as_completed(futures):
            pa_id, nom, groupe, couleur = fut.result()
            if nom:
                # Normalize: "M. Gérault Verny" or "Mme Yaël Braun-Pivet"
                clean = re.sub(r'^(M\.|Mme\.?)\s*', '', nom).strip()
                parts = clean.split()
                entry = {"groupe": groupe, "couleur": couleur, "groupe_complet": groupe}
                # Key: last word as nom, rest as prenom (French convention: Prénom NOM)
                # But since casing is mixed, index many variants
                if len(parts) >= 2:
                    # "Gérault Verny" → nom=Verny, prenom=Gérault
                    nom_an = parts[-1].upper()
                    prenom_an = ' '.join(parts[:-1])
                    groupes_by_nom[f"{nom_an}_{prenom_an}".lower()] = entry
                    groupes_by_nom[nom_an.lower()] = entry
                    # Also try multi-word last names: "Braun-Pivet" → BRAUN-PIVET
                    # "Agnès Firmin Le Bodo" → nom=FIRMIN LE BODO
                    for split_idx in range(1, len(parts)):
                        nom_part = ' '.join(parts[split_idx:]).upper()
                        prenom_part = ' '.join(parts[:split_idx])
                        groupes_by_nom[f"{nom_part}_{prenom_part}".lower()] = entry
                        groupes_by_nom[nom_part.lower()] = entry
                groupes_by_nom[clean.lower()] = entry
            done += 1
            pct = int(done / len(pa_ids) * 100)
            progress(f"{done}/{len(pa_ids)} – {nom or pa_id} → {groupe}", pct)

    progress(f"\n  → {len(pa_ids)} députés, groupes récupérés depuis AN")
    return groupes_by_nom

# ── CSV HATVP ─────────────────────────────────────────────────────────────

def load_csv():
    progress("Chargement CSV HATVP...")
    text = fetch(CSV_URL)
    reader = csv.DictReader(StringIO(text), delimiter=";")
    entries = {}
    for row in reader:
        if (row.get("type_mandat") == "depute"
                and row.get("type_document") == "dia"
                and row.get("open_data", "").endswith(".xml")
                and row.get("statut_publication") == "Livrée"):
            key = f"{row['nom']}_{row['prenom']}".lower()
            # Garder une seule entrée par député (la plus récente = la première vue)
            if key not in entries:
                entries[key] = {
                    "prenom": row["prenom"],
                    "nom": row["nom"],
                    "qualite": row["qualite"],
                    "departement": row["departement"],
                    "xml": row["open_data"],
                    "url": row["url_dossier"],
                    "date": row.get("date_publication", ""),
                }
    progress(f"  → {len(entries)} députés avec DIA publiée")
    return list(entries.values())

# ── Parse XML ─────────────────────────────────────────────────────────────

def parse_xml(xml_text):
    participations = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return participations

    for node in root.iter("participationFinanciereDto"):
        neant = node.find("neant")
        if neant is not None and neant.text and neant.text.strip() == "true":
            continue
        # Structure: participationFinanciereDto > items (wrapper) > items (each entry)
        items_wrapper = node.find("items")
        if items_wrapper is None:
            continue
        for item in items_wrapper.findall("items"):
            societe = (item.findtext("nomSociete") or "").strip()
            if not societe:
                continue
            evaluation = 0.0
            try:
                evaluation = float(item.findtext("evaluation") or 0)
            except ValueError:
                pass
            nb_parts = 0.0
            try:
                nb_parts = float(item.findtext("nombreParts") or 0)
            except ValueError:
                pass
            remun = 0.0
            try:
                remun = float(item.findtext("remuneration") or 0)
            except ValueError:
                pass
            participations.append({
                "societe": societe,
                "evaluation": evaluation,
                "nbParts": nb_parts,
                "remuneration": remun,
            })

    return participations

# ── Fetch XML d'un député ─────────────────────────────────────────────────

def fetch_deputy_xml(entry):
    url = DOSSIERS_BASE + entry["xml"]
    try:
        text = fetch(url, timeout=20)
        return parse_xml(text)
    except Exception:
        return []

# ── Main ───────────────────────────────────────────────────────────────────

def main():
    groupes = load_groupes()
    deputies = load_csv()

    progress(f"\nTéléchargement de {len(deputies)} fichiers XML...")
    results = []
    done = 0

    with ThreadPoolExecutor(max_workers=15) as pool:
        futures = {pool.submit(fetch_deputy_xml, d): d for d in deputies}
        for fut in as_completed(futures):
            dep = futures[fut]
            parts = fut.result()
            nom = dep["nom"].upper()
            prenom = dep["prenom"]
            key_full = f"{nom}_{prenom}".lower()
            key_nom = nom.lower()
            # Also try "PRENOM NOM" style
            key_full2 = f"{prenom}_{nom}".lower()
            g = (groupes.get(key_full)
                 or groupes.get(key_full2)
                 or groupes.get(key_nom)
                 or {"groupe": "Inconnu", "couleur": "", "groupe_complet": "Inconnu"})

            results.append({
                "prenom": prenom,
                "nom": nom,
                "qualite": dep["qualite"],
                "departement": dep["departement"],
                "url": dep["url"],
                "groupe": g.get("groupe_complet") or g.get("groupe", "Inconnu"),
                "groupe_sigle": g.get("groupe", "Inconnu"),
                "couleur_groupe": g.get("couleur", ""),
                "participations": parts,
            })
            done += 1
            pct = int(done / len(deputies) * 100)
            progress(f"{done}/{len(deputies)} – {nom} {prenom} ({len(parts)} participations)", pct)

    progress("\nÉcriture de data.json...")
    with open("data.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=None, separators=(",", ":"))

    total_parts = sum(len(r["participations"]) for r in results)
    total_val = sum(p["evaluation"] for r in results for p in r["participations"])
    avec = sum(1 for r in results if r["participations"])
    inconnus = sum(1 for r in results if r["groupe"] == "Inconnu")
    print(f"\n✓ {len(results)} députés · {total_parts} participations · {total_val/1e6:.1f}M€ total déclaré")
    print(f"✓ {avec} députés ont au moins une participation")
    print(f"✓ {inconnus} députés sans groupe identifié")
    print("✓ data.json généré")

if __name__ == "__main__":
    main()
