#!/usr/bin/env python3
"""
Télécharge les données HATVP (DIA deputés) + groupes Assemblée Nationale
et génère un data.json utilisable par le site statique.
"""

import csv
import json
import re
import html as htmlmod
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import StringIO

CSV_URL = "https://www.hatvp.fr/livraison/opendata/liste.csv"
AN_HEMICYCLE_URL = "https://www.assemblee-nationale.fr/dyn/vos-deputes/hemicycle"
AN_EMBED_BASE = "https://www.assemblee-nationale.fr/dyn/embed/acteur-presentation/"
DOSSIERS_BASE = "https://www.hatvp.fr/livraison/dossiers/"
SENAT_GRP_BASE = "https://www.senat.fr/senateurs"

# Couleurs des groupes du Sénat (par slug de page)
SENAT_GROUP_COLORS = {
    "ump":  "#004494",   # Les Républicains
    "soc":  "#E75480",   # Socialiste, Écologiste et Républicain
    "uc":   "#F4A900",   # Union Centriste
    "rtli": "#8B4CC8",   # Les Indépendants - République et Territoires
    "lrem": "#FF8000",   # Rassemblement des démocrates, progressistes et indépendants
    "crc":  "#CC1111",   # Communiste Républicain Citoyen et Écologiste - Kanaky
    "rdse": "#FF6633",   # Rassemblement Démocratique et Social Européen
    "gest": "#3DAA6A",   # Écologiste - Solidarité et Territoires
    "ni":   "#888888",   # Non-inscrits
}

# ── Helpers ────────────────────────────────────────────────────────────────

def norm_key(s):
    """Normalise une chaîne pour la correspondance nom/prénom : minuscules, apostrophes uniformisées."""
    s = re.sub(r"['\u2019\u2018\u02bc\u0060]", "'", s or "")
    return s.lower().strip()

def ascii_key(s):
    """Variante ASCII sans diacritiques (pour matcher les graphies simplifiées)."""
    nfkd = unicodedata.normalize("NFD", s or "")
    return "".join(c for c in nfkd if unicodedata.category(c) != "Mn").lower().strip()

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
                    groupes_by_nom[norm_key(f"{nom_an}_{prenom_an}")] = entry
                    groupes_by_nom[norm_key(nom_an)] = entry
                    # Also try multi-word last names: "Braun-Pivet" → BRAUN-PIVET
                    # "Agnès Firmin Le Bodo" → nom=FIRMIN LE BODO
                    for split_idx in range(1, len(parts)):
                        nom_part = ' '.join(parts[split_idx:]).upper()
                        prenom_part = ' '.join(parts[:split_idx])
                        groupes_by_nom[norm_key(f"{nom_part}_{prenom_part}")] = entry
                        groupes_by_nom[norm_key(nom_part)] = entry
                groupes_by_nom[norm_key(clean)] = entry
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

# ── Groupes parlementaires depuis le Sénat ────────────────────────────────

def load_groupes_senat():
    """Scrape senat.fr group pages to build sénateur → groupe + couleur mapping."""
    progress("Récupération des groupes du Sénat (senat.fr/senateurs/)...")
    groupes_by_nom = {}

    # Step 1: discover group page slugs from the main groups listing
    try:
        grp_index = fetch(f"{SENAT_GRP_BASE}/grp.html", timeout=15)
        # links look like: href="ump.html" (relative)
        discovered = re.findall(r'href="(\w+\.html)"', grp_index)
        discovered = list(dict.fromkeys(discovered))  # deduplicate
    except Exception as e:
        progress(f"\n  ⚠ Impossible de charger grp.html: {e}")
        discovered = []

    # Fallback slugs if discovery fails
    fallback_slugs = list(SENAT_GROUP_COLORS.keys())
    slugs = [s.replace(".html", "") for s in discovered] if discovered else fallback_slugs
    # Make sure we have at least the known ones
    for known in fallback_slugs:
        if known not in slugs:
            slugs.append(known)

    progress(f"  → {len(slugs)} groupes à scraper: {slugs}")

    total_senators = 0
    for slug in slugs:
        url = f"{SENAT_GRP_BASE}/{slug}.html"
        try:
            html = fetch(url, timeout=15)
        except Exception as e:
            progress(f"\n  ⚠ {slug}.html inaccessible: {e}")
            continue

        # Extract group full name from H1
        h1 = re.search(r"<h1[^>]*>([^<]+)</h1>", html, re.IGNORECASE)
        groupe_complet = h1.group(1).strip() if h1 else slug.upper()
        # Strip "Groupe " prefix if present
        groupe_complet = re.sub(r"^Groupe\s+", "", groupe_complet).strip()
        # Strip "du " prefix (e.g. "du Rassemblement...")
        groupe_complet = re.sub(r"^du\s+", "", groupe_complet).strip()

        couleur = SENAT_GROUP_COLORS.get(slug, "#888888")
        entry = {"groupe": groupe_complet, "couleur": couleur, "groupe_complet": groupe_complet}

        # Extract senator list: <A href="/senateur/...">NOM&nbsp;Prénom</A>
        # The &nbsp; separates NOM (uppercase) from Prénom (mixed case)
        names_raw = re.findall(r'href="/senateur/[^"]+">([^<]+)</A>', html)
        count = 0
        for raw in names_raw:
            # Normalize line-breaks first (multi-line names like "de\nMONTGOLFIER&nbsp;Albéric")
            raw = raw.replace("\n", " ").replace("\r", " ")
            # Collapse regular whitespace (but NOT &nbsp; yet — we use it as separator)
            raw = re.sub(r"[ \t]+", " ", raw).strip()
            # Split on &nbsp; first (entity form, preserved), then on \xa0 (decoded form)
            if "&nbsp;" in raw:
                parts = raw.split("&nbsp;", 1)
            elif "\xa0" in raw:
                parts = raw.split("\xa0", 1)
            else:
                # fallback: first all-caps token(s) = NOM, rest = Prénom
                tokens = raw.split(" ")
                i = 0
                while i < len(tokens) and (tokens[i].upper() == tokens[i] and not tokens[i].islower()):
                    i += 1
                parts = [" ".join(tokens[:i]), " ".join(tokens[i:])] if i else [raw, ""]

            nom    = parts[0].strip().upper()
            prenom = parts[1].strip() if len(parts) > 1 else ""
            if not nom:
                continue

            # Index multiple key variants for robust matching
            groupes_by_nom[norm_key(nom)] = entry
            groupes_by_nom[ascii_key(nom)] = entry  # ASCII fallback (e.g. NICOLAY for NICOLAŸ)
            if prenom:
                groupes_by_nom[norm_key(f"{nom}_{prenom}")] = entry
                groupes_by_nom[norm_key(f"{prenom}_{nom}")] = entry
                groupes_by_nom[ascii_key(f"{nom}_{prenom}")] = entry
            # sub-name variants (e.g. "ESTROSI SASSONE" → also "SASSONE")
            nom_parts = nom.split()
            for i in range(1, len(nom_parts)):
                groupes_by_nom[norm_key(" ".join(nom_parts[i:]))] = entry
            count += 1

        total_senators += count
        progress(f"  {slug}: {groupe_complet} — {count} sénateurs")

    progress(f"\n  → {len(groupes_by_nom)} entrées indexées · {total_senators} sénateurs au total")
    return groupes_by_nom


def load_csv_senateurs():
    """Charge les sénateurs avec DIA publiée depuis le CSV HATVP."""
    progress("Chargement CSV HATVP (sénateurs)...")
    text = fetch(CSV_URL)
    reader = csv.DictReader(StringIO(text), delimiter=";")
    entries = {}
    for row in reader:
        mandat = (row.get("type_mandat") or "").lower().strip()
        # accepte "senateur" et "sénateur" (avec/sans accent)
        if (mandat in ("senateur", "sénateur", "sénatrice", "senatrice")
                and row.get("type_document") == "dia"
                and row.get("open_data", "").endswith(".xml")
                and row.get("statut_publication") == "Livrée"):
            key = f"{row['nom']}_{row['prenom']}".lower()
            if key not in entries:
                entries[key] = {
                    "prenom": row["prenom"],
                    "nom":    row["nom"],
                    "qualite":     row["qualite"],
                    "departement": row["departement"],
                    "xml": row["open_data"],
                    "url": row["url_dossier"],
                    "date": row.get("date_publication", ""),
                }
    progress(f"  → {len(entries)} sénateurs avec DIA publiée")
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

# ── Helpers mutualisés ─────────────────────────────────────────────────────

def build_results(members, groupes, label="parlementaires"):
    """Télécharge les XML et associe les groupes pour une liste de parlementaires."""
    progress(f"\nTéléchargement de {len(members)} fichiers XML ({label})...")
    results = []
    done = 0
    with ThreadPoolExecutor(max_workers=15) as pool:
        futures = {pool.submit(fetch_deputy_xml, d): d for d in members}
        for fut in as_completed(futures):
            dep = futures[fut]
            parts = fut.result()
            nom    = dep["nom"].upper()
            prenom = dep["prenom"]
            g = (groupes.get(norm_key(f"{nom}_{prenom}"))
                 or groupes.get(norm_key(f"{prenom}_{nom}"))
                 or groupes.get(norm_key(nom))
                 or groupes.get(ascii_key(f"{nom}_{prenom}"))   # fallback: strip accents
                 or groupes.get(ascii_key(nom))
                 or {"groupe": "Inconnu", "couleur": "", "groupe_complet": "Inconnu"})
            results.append({
                "prenom": prenom,
                "nom":    nom,
                "qualite":     dep["qualite"],
                "departement": dep["departement"],
                "url":         dep["url"],
                "groupe":        g.get("groupe_complet") or g.get("groupe", "Inconnu"),
                "groupe_sigle":  g.get("groupe", "Inconnu"),
                "couleur_groupe": g.get("couleur", ""),
                "participations": parts,
            })
            done += 1
            pct = int(done / len(members) * 100)
            progress(f"{done}/{len(members)} – {nom} {prenom} ({len(parts)} participations)", pct)
    return results


def write_output(results, json_file, js_file, js_var):
    """Écrit les résultats en JSON + JS embarqué."""
    json_str = json.dumps(results, ensure_ascii=False, separators=(",", ":"))
    progress(f"\nÉcriture de {json_file}...")
    with open(json_file, "w", encoding="utf-8") as f:
        f.write(json_str)
    progress(f"Écriture de {js_file} (bundle embarqué)...")
    with open(js_file, "w", encoding="utf-8") as f:
        f.write("/* AUTO-GENERATED — do not edit manually, run fetch_data.py instead */\n")
        f.write(f"{js_var}=")
        f.write(json_str)
        f.write(";\n")
    total_parts = sum(len(r["participations"]) for r in results)
    total_val   = sum(p["evaluation"] for r in results for p in r["participations"])
    avec        = sum(1 for r in results if r["participations"])
    inconnus    = sum(1 for r in results if r["groupe"] == "Inconnu")
    print(f"\n✓ {len(results)} entrées · {total_parts} participations · {total_val/1e6:.1f}M€")
    print(f"✓ {avec} avec au moins une participation · {inconnus} sans groupe identifié")
    print(f"✓ {json_file} + {js_file} générés")


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    # ── Députés ────────────────────────────────────────────────────────────
    print("\n══ ASSEMBLÉE NATIONALE — DÉPUTÉS ══")
    groupes_an  = load_groupes()
    deputies    = load_csv()
    res_deputes = build_results(deputies, groupes_an, "députés")

    # Correctif manuel (apostrophes Unicode non reconnues par le scraping AN)
    overrides = {'/pages_nominatives/d-intorni-christelle-20430': 'Union des droites pour la République'}
    for r in res_deputes:
        if overrides.get(r["url"]):
            r["groupe"] = overrides[r["url"]]

    write_output(res_deputes, "data.json", "data.js", "window.HATVP_DATA")

    # ── Sénateurs ──────────────────────────────────────────────────────────
    print("\n══ SÉNAT — SÉNATEURS ══")
    groupes_senat  = load_groupes_senat()
    senateurs      = load_csv_senateurs()
    if senateurs:
        res_senateurs = build_results(senateurs, groupes_senat, "sénateurs")
        write_output(res_senateurs, "data_senateurs.json", "data_senateurs.js",
                     "window.HATVP_DATA_SENATEURS")
    else:
        progress("  ⚠ Aucun sénateur trouvé dans le CSV HATVP (vérifier type_mandat)")


if __name__ == "__main__":
    main()
