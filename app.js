/* ── Utilitaires ─────────────────────────────────────────────────────────── */

// Normalise une chaîne pour la recherche : minuscules, sans accents ni apostrophes ni espaces
function normalizeSearch(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // retire accents
    .replace(/['\u2019\u2018`]/g, '')                  // retire apostrophes
    .replace(/\s+/g, '');                              // retire espaces
}

function formatEur(n) {
  if (!n || isNaN(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M€';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k€';
  return Math.round(n) + '€';
}

function formatM(n) {
  if (!n || isNaN(n)) return '—';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M€';
  if (Math.abs(n) >= 1e3) return Math.round(n / 1e3) + 'k€';
  return Math.round(n) + '€';
}

// Pour les axes : formateur adaptatif basé sur le max du domaine
function axisFormatter(maxVal) {
  if (maxVal >= 1e6) return v => (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1).replace(/\.0$/, '') + 'M€';
  if (maxVal >= 1e3) return v => Math.round(v / 1e3) + 'k€';
  return v => Math.round(v) + '€';
}

function isNonPublic(name) {
  return !name || name.includes('non publi') || name.includes('Non publi');
}

// Détecte les structures privées (SCI, SARL, SAS familiales, etc.) par leur forme juridique
// Ces sociétés ne sont PAS des investissements boursiers
const PRIVATE_STRUCT_RE = /\b(sci|sarl|sas|sasu|snc|scp|selarl|spfpl|earl|gaec|scea|gfa|gfr|fonciere|scpi|fcpe|fcpi|fcp)\b/i;

function isStructurePrivee(name) {
  if (!name) return false;
  return PRIVATE_STRUCT_RE.test(name);
}

// Filtre les participations non publiées
function filterParticipations(parts) {
  return parts;
}

function decodeHtml(str) {
  const t = document.createElement('textarea');
  t.innerHTML = str;
  return t.value;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ── Tooltip ─────────────────────────────────────────────────────────────── */
const tip = document.getElementById('tooltip');

function showTip(html, event) {
  tip.innerHTML = html;
  tip.classList.add('visible');
  moveTip(event);
}
function moveTip(event) {
  const x = event.clientX + 14;
  const y = event.clientY - 10;
  tip.style.left = (x + tip.offsetWidth > window.innerWidth ? event.clientX - tip.offsetWidth - 14 : x) + 'px';
  tip.style.top = y + 'px';
}
function hideTip() { tip.classList.remove('visible'); }

/* ── État global ─────────────────────────────────────────────────────────── */
let allData = [];
let activeGroupe = null;
let activeDepute = null; // filtre sur un député précis (url = clé unique)
let activeSocietes = new Set(); // Set de noms normalisés de sociétés sélectionnées (multi-sélection)
let excludedGroupes = new Set(); // Set de groupes politiques exclus des graphiques
let sortKey = 'valeurTotale', sortDir = -1;
let currentPage = 1;
const PAGE_SIZE = 30;
let currentDataset = 'deputes'; // 'deputes' | 'senateurs'

/* ── Couleurs ────────────────────────────────────────────────────────────── */
const FALLBACK_COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#3b82f6',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#84cc16',
  '#06b6d4', '#a855f7', '#64748b',
];
const _groupColorCache = {};
let _colorIdx = 0;

function groupeColor(g, couleur) {
  if (couleur) return couleur;
  if (!g) return '#445';
  if (!_groupColorCache[g]) _groupColorCache[g] = FALLBACK_COLORS[_colorIdx++ % FALLBACK_COLORS.length];
  return _groupColorCache[g];
}

const groupColorMap = {};
function buildColorMap(data) {
  for (const d of data) {
    const g = d.groupe || 'Inconnu';
    if (!groupColorMap[g] && d.couleur_groupe) groupColorMap[g] = d.couleur_groupe;
  }
}
function gColor(g) { return groupColorMap[g] || groupeColor(g, ''); }

/* Retourne '#fff' ou une couleur sombre selon la luminance du fond — pour les labels sur arcs/cellules */
/* Mode sombre : toujours blanc. Mode clair : calcul luminance. */
function labelOnColor(hex) {
  if (!isLight()) return '#fff';
  const c = d3.color(hex);
  if (!c) return '#fff';
  const toL = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const lum = 0.2126 * toL(c.r) + 0.7152 * toL(c.g) + 0.0722 * toL(c.b);
  return lum > 0.32 ? '#3a3000' : '#fff';
}

/* ── Noms lisibles (sans acronymes) ──────────────────────────────────────── */
function shortGroupe(g) {
  const map = {
    // Assemblée Nationale
    'Rassemblement National':                           'Rassemblement National',
    'Ensemble pour la République':                      'Ensemble',
    'La France insoumise - Nouveau Front Populaire':    'La France Insoumise',
    'Socialistes et apparentés':                        'Socialistes',
    'Droite Républicaine':                              'Droite Républicaine',
    'Écologiste et Social':                             'Écologiste et Social',
    'Les Démocrates':                                   'Les Démocrates',
    'Horizons & Indépendants':                          'Horizons',
    'Libertés, Indépendants, Outre-mer et Territoires': 'Libertés Outre-mer',
    'Gauche Démocrate et Républicaine':                 'Gauche Démocrate',
    'Union des droites pour la République':             'Union des droites',
    // Sénat
    'Les Républicains':                                                'Les Républicains',
    'Rassemblement des démocrates progressistes et indépendants':      'RDPI',
    'Socialistes, Écologistes et Républicains':                        'SER',
    'Union Centriste':                                                  'UC',
    'Les Indépendants - République et Territoires':                    'Les Indépendants',
    'Écologiste - Solidarité et Territoires':                          'Écologistes',
    'Communiste Républicain Citoyen et Écologiste - Kanaky':           'CRCE-K',
    'Rassemblement Démocratique et Social Européen':                   'RDSE',
    // Commun
    'Non inscrit':  'Non inscrit',
    'Inconnu':      'Inconnu',
  };
  return map[g] || g;
}

/* ── Helpers thème ───────────────────────────────────────────────────────── */
function isLight() { return document.body.classList.contains('light'); }
function themeText()    { return isLight() ? 'rgba(57,62,65,0.6)'  : 'rgba(255,255,255,0.6)'; }
function themeTextDim() { return isLight() ? 'rgba(57,62,65,0.35)' : 'rgba(255,255,255,0.35)'; }
function themeAxis()    { return isLight() ? 'rgba(57,62,65,0.08)' : 'rgba(255,255,255,0.08)'; }
function themeAxisLine(){ return isLight() ? 'rgba(57,62,65,0.06)' : 'rgba(255,255,255,0.06)'; }
function themeHint()    { return isLight() ? 'rgba(128,100,0,0.75)' : 'rgba(113,156,175,0.8)'; }
function themeSvgLabel(){ return isLight() ? 'rgba(57,62,65,0.55)' : 'rgba(255,255,255,0.55)'; }

/* ── KPIs dynamiques ─────────────────────────────────────────────────────── */
function updateKpis() {
  let base = allData;
  if (activeDepute) base = allData.filter(d => d.url === activeDepute.url);
  else if (activeGroupe) base = allData.filter(d => d.groupe === activeGroupe);
  else if (excludedGroupes.size > 0) base = allData.filter(d => !excludedGroupes.has(d.groupe));

  const nbDeputes = base.length;
  const valeurs = base.map(d => filterParticipations(d.participations).reduce((s, p) => s + (p.evaluation || 0), 0));
  const totalVal = valeurs.reduce((s, v) => s + v, 0);
  const moyenne = nbDeputes > 0 ? totalVal / nbDeputes : 0;
  // Médiane calculée uniquement sur les députés avec au moins une participation déclarée
  const valeursAvecPart = valeurs.filter(v => v > 0);
  const med = median(valeursAvecPart);

  document.getElementById('stat-deputes').textContent = nbDeputes.toLocaleString('fr-FR');
  document.getElementById('stat-valeur').textContent = formatEur(totalVal);
  document.getElementById('stat-moyenne').textContent = formatEur(moyenne);
  document.getElementById('stat-mediane').textContent = formatEur(med);

  // Label du compteur adapté au filtre et au dataset
  const labelEl = document.getElementById('stat-deputes-label');
  if (labelEl) {
    const word = currentDataset === 'senateurs' ? 'Sénateur' : 'Député';
    labelEl.textContent = activeDepute ? `${word} sélectionné`
      : activeGroupe ? `${word}s — ${shortGroupe(activeGroupe)}`
      : `${word}s avec DIA publiée`;
  }
}

/* ── Agrégation par groupe ───────────────────────────────────────────────── */
function aggregateByGroupe(data) {
  const map = {};
  for (const d of data) {
    const g = d.groupe || 'Inconnu';
    if (!map[g]) map[g] = { groupe: g, couleur: gColor(g), total: 0, valeur: 0, deputes: 0, avecPart: 0, valeurs: [] };
    const parts = filterParticipations(d.participations);
    const val = parts.reduce((s, p) => s + (p.evaluation || 0), 0);
    const nb = parts.length;
    map[g].deputes++;
    map[g].total += nb;
    map[g].valeur += val;
    if (nb > 0) { map[g].avecPart++; map[g].valeurs.push(val); }
  }
  return Object.values(map).sort((a, b) => b.valeur - a.valeur);
}

function filteredForCharts() {
  let base = allData;
  if (activeDepute) base = allData.filter(d => d.url === activeDepute.url);
  else if (activeGroupe) base = allData.filter(d => d.groupe === activeGroupe);
  else if (excludedGroupes.size > 0) base = allData.filter(d => !excludedGroupes.has(d.groupe));
  return aggregateByGroupe(base);
}

/* ── Titres dynamiques ───────────────────────────────────────────────────── */
function updateChartTitles() {
  const elSoc     = document.getElementById('title-societes');
  const elValeur  = document.getElementById('title-valeur-groupe');
  const elMediane = document.getElementById('title-mediane');

  if (activeSocietes.size > 0) {
    const labels = [...activeSocietes].slice(0, 3).join('", "');
    const more = activeSocietes.size > 3 ? ` +${activeSocietes.size - 3}` : '';
    if (elSoc) elSoc.textContent = `Sociétés : "${labels}"${more} — valeur en M€ par groupe`;
  } else if (activeDepute) {
    const name = `${activeDepute.prenom} ${activeDepute.nom}`;
    if (elSoc)     elSoc.textContent     = `Sociétés détenues par ${name}`;
    if (elValeur)  elValeur.textContent  = `Valeur déclarée — ${name}`;
    if (elMediane) elMediane.textContent = `Participations de ${name}`;
  } else if (activeGroupe) {
    const abbr = shortGroupe(activeGroupe);
    if (elSoc)     elSoc.textContent     = `Sociétés détenues par les membres ${abbr} — valeur en M€`;
    if (elValeur)  elValeur.textContent  = `Valeur totale — ${abbr} (M€)`;
    if (elMediane) elMediane.textContent = `Valeur médiane — ${abbr} (€)`;
  } else {
    if (elSoc)     elSoc.textContent     = `Sociétés les plus détenues — valeur en M€ par groupe politique`;
    if (elValeur)  elValeur.textContent  = `Valeur totale par groupe (M€)`;
    if (elMediane) elMediane.textContent = `Valeur médiane des participations par groupe (€)`;
  }
}

/* ── Filtrage croisé ────────────────────────────────────────────────────── */
/* ── Barre de filtres sticky ──────────────────────────────────────────────── */
function updateFilterBar() {
  const bar = document.getElementById('filter-bar');
  const tags = document.getElementById('filter-bar-tags');
  if (!bar || !tags) return;

  tags.innerHTML = '';
  updateGroupeBtns();
  const hasAny = activeDepute || activeSocietes.size > 0;
  bar.classList.toggle('visible', !!hasAny);
  const clearBtn = document.getElementById('filter-bar-clear-btn');
  if (clearBtn) clearBtn.style.display = hasAny ? '' : 'none';
  if (!hasAny) return;

  // Chip député
  if (activeDepute) {
    const chip = document.createElement('div');
    chip.className = 'filter-chip';
    chip.innerHTML = `<span class="chip-icon">👤</span>
      <span style="width:8px;height:8px;border-radius:50%;background:${gColor(activeDepute.groupe)};display:inline-block;flex-shrink:0"></span>
      <span>${activeDepute.prenom} ${activeDepute.nom}</span>
      <button onclick="clearDeputeFilter()" title="Retirer">✕</button>`;
    tags.appendChild(chip);
  }

  // Chips sociétés
  if (activeSocietes.size > 0 && _socList) {
    activeSocietes.forEach(norm => {
      const entry = _socList.find(s => s.norm === norm);
      const label = entry ? entry.label : norm;
      const chip = document.createElement('div');
      chip.className = 'filter-chip';
      chip.innerHTML = `<span class="chip-icon">🏢</span>
        <span>${label}</span>
        <button onclick="socPickerRemove('${norm.replace(/'/g,"\\'")}');updateFilterBar()" title="Retirer">✕</button>`;
      tags.appendChild(chip);
    });
  }
}

/* ── Boutons partis ─────────────────────────────────────────────────────── */
function buildGroupeBtns() {
  const bar = document.getElementById('groupe-btns-bar');
  if (!bar) return;
  bar.innerHTML = '';

  // Groupes triés par valeur totale décroissante, avec couleur
  const byG = aggregateByGroupe(allData).sort((a, b) => b.valeur - a.valeur);

  for (const g of byG) {
    if (g.groupe === 'Inconnu') continue;
    const clr = g.couleur || gColor(g.groupe);
    const btn = document.createElement('button');
    btn.className = 'groupe-btn';
    btn.dataset.groupe = g.groupe;
    btn.title = g.groupe; // tooltip avec nom complet
    btn.textContent = shortGroupe(g.groupe);
    // Couleur inline
    btn.style.setProperty('--gbtn-color', clr);
    btn.addEventListener('click', () => toggleExcludeGroupe(g.groupe));
    bar.appendChild(btn);
  }

  // Bouton "Tout effacer" universel — visible dès qu'un filtre quelconque est actif
  const clearBtn = document.createElement('button');
  clearBtn.className = 'groupe-btn-clear';
  clearBtn.id = 'groupe-clear-btn';
  clearBtn.textContent = '✕ Tout effacer';
  clearBtn.style.display = 'none';
  clearBtn.addEventListener('click', () => clearFilter());
  bar.appendChild(clearBtn);
}

function updateGroupeBtns() {
  document.querySelectorAll('.groupe-btn').forEach(btn => {
    btn.classList.toggle('excluded', excludedGroupes.has(btn.dataset.groupe));
  });
  const clearBtn = document.getElementById('groupe-clear-btn');
  if (clearBtn) {
    const anyFilter = excludedGroupes.size > 0 || !!activeDepute || activeSocietes.size > 0;
    clearBtn.style.display = anyFilter ? 'inline-flex' : 'none';
  }
}

function toggleExcludeGroupe(groupe) {
  // Réinitialiser le filtre député/groupe mono si actif
  activeGroupe = null;
  activeDepute = null;

  if (excludedGroupes.size === 0) {
    // Tous actifs → solo ce groupe (exclure tous les autres)
    const allGroupes = [...new Set(allData.map(d => d.groupe).filter(Boolean))];
    excludedGroupes = new Set(allGroupes.filter(g => g !== groupe));
  } else if (excludedGroupes.has(groupe)) {
    // Ce groupe était exclu → le réactiver
    excludedGroupes.delete(groupe);
  } else {
    // Ce groupe était actif parmi d'autres → l'exclure
    excludedGroupes.add(groupe);
  }
  updateGroupeBtns();
  updateKpis();
  updateChartTitles();
  updateFilterBar();
  const fg = filteredForCharts();
  buildBarValeurGroupe('bar-valeur-groupe-wrap', fg);
  buildBarSocietesStacked('bar-societes-wrap');
  rebuildExplorer();
  currentPage = 1;
  applyTableFilters();
}

// skipSunburst=true quand l'appelant a déjà rendu le sunburst (clic direct sur l'arc)
function setFilter(groupe, skipSunburst = false) {
  activeGroupe = groupe;
  activeDepute = null;
  // Synchroniser les boutons partis : si filtre solo → griser tous les autres
  if (groupe) {
    const allGroupes = [...new Set(allData.map(d => d.groupe).filter(Boolean))];
    excludedGroupes = new Set(allGroupes.filter(g => g !== groupe));
  } else {
    excludedGroupes = new Set();
  }
  updateGroupeBtns();
  updateKpis();
  updateChartTitles();
  updateFilterBar();
  const fg = filteredForCharts();
  buildBarValeurGroupe('bar-valeur-groupe-wrap', fg);
  buildBarSocietesStacked('bar-societes-wrap');
  if (!skipSunburst) {
    if (_currentExplorerView === 'sunburst' && _sunburstHier && _sunburstG) {
      if (groupe) {
        const node = _sunburstHier.descendants().find(d => d.depth === 1 && d.data.name === groupe);
        if (node) {
          _sunburstZoomed = { level: 1, groupeNode: node, deputeNode: null };
          _sunburstRender(_sunburstG, node, null, _sunburstSize / 2, true);
        }
      } else {
        _sunburstZoomed = null;
        _sunburstRender(_sunburstG, null, null, _sunburstSize / 2, true);
      }
    } else if (_currentExplorerView === 'treemap') {
      buildTreemap();
    } else if (_currentExplorerView === 'sankey' && _sankeyBuilt && typeof buildSankey === 'function') {
      buildSankey();
    }
  }
  currentPage = 1;
  applyTableFilters();
}

// Met à jour tous les graphiques/filtres pour un député, sans toucher au sunburst
function _applyDeputeFilterCharts(depute) {
  activeDepute = depute;
  activeGroupe = null;
  // Synchroniser les boutons partis sur le groupe du député
  if (depute.groupe) {
    const allGroupes = [...new Set(allData.map(d => d.groupe).filter(Boolean))];
    excludedGroupes = new Set(allGroupes.filter(g => g !== depute.groupe));
  } else {
    excludedGroupes = new Set();
  }
  updateGroupeBtns();
  const singleData = allData.filter(d => d.url === depute.url);
  const fg = aggregateByGroupe(singleData);
  updateKpis();
  updateChartTitles();
  updateFilterBar();
  buildBarValeurGroupe('bar-valeur-groupe-wrap', fg);
  buildBarSocietesStacked('bar-societes-wrap');
  if (_currentExplorerView === 'treemap') {
    buildTreemap();
  } else if (_sankeyBuilt && typeof buildSankey === 'function') {
    buildSankey();
  }
  currentPage = 1;
  applyTableFilters();
}

function setDeputeFilter(depute) {
  _applyDeputeFilterCharts(depute);
  // Sunburst : drill jusqu'au député (niveau 2)
  if (_sunburstHier && _sunburstG && depute.groupe) {
    const groupeNode = _sunburstHier.descendants().find(d => d.depth === 1 && d.data.name === depute.groupe);
    if (groupeNode) {
      const deputeNode = groupeNode.children?.find(d => d.data.url === depute.url);
      _sunburstZoomed = { level: 2, groupeNode, deputeNode: deputeNode || null };
      _sunburstRender(_sunburstG, groupeNode, deputeNode || null, _sunburstSize / 2, true);
    }
  }
}

// Supprime uniquement le filtre député en conservant le filtre groupe
function clearDeputeFilter() {
  const groupe = activeDepute ? activeDepute.groupe : null;
  if (groupe) {
    setFilter(groupe); // revient au niveau groupe, garde le solo dans la barre
  } else {
    clearFilter();
  }
}
window.clearDeputeFilter = clearDeputeFilter;

function clearFilter() {
  activeGroupe = null;
  activeDepute = null;
  activeSocietes = new Set();
  excludedGroupes = new Set();
  updateGroupeBtns();
  socPickerClearAll(false);
  updateKpis();
  updateChartTitles();
  updateFilterBar();
  const fg = filteredForCharts();
  buildBarValeurGroupe('bar-valeur-groupe-wrap', fg);
  buildBarSocietesStacked('bar-societes-wrap');
  // Reconstruction de la vue explorer active (sunburst, treemap ou sankey)
  rebuildExplorer();
  currentPage = 1;
  applyTableFilters();
}

/* ══════════════════════════════════════════════════════════════════════════
   SUNBURST DATA
   ══════════════════════════════════════════════════════════════════════════ */

function buildSunburstData() {
  const root = { name: 'root', children: [] };
  const groupMap = {};
  for (const d of allData) {
    // Respecter les groupes exclus (et le filtre groupe unique actif)
    const g0 = d.groupe || 'Inconnu';
    if (excludedGroupes.size > 0 && excludedGroupes.has(g0)) continue;
    if (activeGroupe && g0 !== activeGroupe) continue;
    const filteredParts = filterParticipations(d.participations);
    if (filteredParts.length === 0) continue;
    // Filtre société actif : n'inclure que les députés qui possèdent cette société
    if (activeSocietes.size > 0) {
      const hasMatch = filteredParts.some(p => {
        const norm = normalizeSearch(p.societe);
        return [...activeSocietes].some(sel => norm.includes(sel));
      });
      if (!hasMatch) continue;
    }
    const g = d.groupe || 'Inconnu';
    if (!groupMap[g]) {
      groupMap[g] = { name: g, couleur: gColor(g), children: [] };
      root.children.push(groupMap[g]);
    }
    // Sociétés publiques du député (top 12 par valeur)
    const publicSocietes = filteredParts
      .filter(p => !isNonPublic(p.societe) && (p.evaluation || 0) > 0)
      .sort((a, b) => b.evaluation - a.evaluation)
      .slice(0, 12)
      .map(p => ({
        name: p.societe,
        value: p.evaluation,
        type: 'societe',
        couleur: gColor(g),
      }));

    const nonPublicParts = filteredParts.filter(p => isNonPublic(p.societe));
    const societes = [...publicSocietes];
    if (nonPublicParts.length > 0) {
      // Valeur d'affichage arbitraire (valeur réelle non divulguée)
      const baseRef = publicSocietes.length > 0
        ? publicSocietes[publicSocietes.length - 1].value  // plus petite déclarée
        : 10000;
      societes.push({
        name: nonPublicParts.length > 1 ? `Non publié ×${nonPublicParts.length}` : 'Non publié',
        value: Math.max(baseRef * 0.3, 5000),
        type: 'nonpublic',
        couleur: '#7a8a90',
        isNonPublic: true,
      });
    }

    const filteredVal = filteredParts.reduce((s, p) => s + (p.evaluation || 0), 0);

    // Pour éviter le double-comptage avec d3.hierarchy.sum() :
    // si le député a des enfants (sociétés), sa propre valeur = filteredVal - somme des sociétés publiées
    // (la valeur d'affichage des non-publiés est artificielle, on ne la compte pas ici)
    const socSum = publicSocietes.reduce((s, p) => s + (p.value || 0), 0);
    const selfValue = societes.length
      ? Math.max(filteredVal - socSum, 0)   // reste non représenté en enfants
      : Math.max(filteredVal, 1000);         // feuille : valeur minimale pour la visibilité

    groupMap[g].children.push({
      name: `${d.prenom} ${d.nom}`,
      groupe: g,
      couleur: gColor(g),
      url: d.url,
      value: selfValue,
      rawValue: filteredVal,
      nbParts: filteredParts.length,
      children: societes.length ? societes : undefined,
    });
  }
  return root;
}

/* ══════════════════════════════════════════════════════════════════════════
   SUNBURST — zoomable drill-down 3 niveaux
   Niveau 0 (root)   : vue globale  → anneau intérieur = groupes, extérieur = députés
   Niveau 1 (groupe) : drill groupe → anneau intérieur = députés 360°, extérieur = sociétés
   Niveau 2 (député) : drill député → anneau unique = sociétés 360°
   ══════════════════════════════════════════════════════════════════════════ */

let _sunburstSvg    = null;   // SVG persistent
let _sunburstG      = null;   // <g> centré
let _sunburstHier   = null;   // hiérarchie D3 complète
let _sunburstZoomed = null;   // { level: 0|1|2, groupeNode, deputeNode }
let _sunburstPaths  = null;   // paths courants (pour highlight)
let _sunburstSize   = 0;

// Rebuild la vue explorer active (sunburst, treemap ou sankey)
function rebuildExplorer() {
  if (_currentExplorerView === 'treemap') buildTreemap();
  else if (_currentExplorerView === 'sankey' && _sankeyBuilt && typeof buildSankey === 'function') buildSankey();
  else buildSunburst();
}

function buildSunburst() {
  const wrap = document.getElementById('sunburst-wrap');
  if (!wrap) return;
  const W = wrap.clientWidth || 600;
  const size = Math.min(W, 580);
  _sunburstSize = size;
  const radius = size / 2;

  d3.select('#sunburst-wrap').selectAll('*').remove();
  _sunburstZoomed = null;

  const svg = d3.select('#sunburst-wrap')
    .append('svg')
    .attr('viewBox', `0 0 ${size} ${size}`)
    .attr('width', size).attr('height', size)
    .attr('aria-label', 'Sunburst : groupes politiques et députés');

  _sunburstSvg = svg;
  const g = svg.append('g').attr('transform', `translate(${radius},${radius})`);
  _sunburstG = g;

  const hier = d3.hierarchy(buildSunburstData())
    .sum(d => d.value || 0)
    .sort((a, b) => b.value - a.value);

  // partition standard (utilisée seulement pour vue globale)
  d3.partition().size([2 * Math.PI, radius])(hier);
  _sunburstHier = hier;

  _sunburstRender(g, null, null, radius, false);
}

// ── Utilitaire : distribue les angles à 360° proportionnellement à la valeur ──
function _spreadAngles(nodes, totalVal) {
  let cum = 0;
  return nodes.map(n => {
    const span = ((n.value || 0) / (totalVal || 1)) * 2 * Math.PI;
    const x0 = cum, x1 = cum + span;
    cum = x1;
    return { node: n, x0, x1 };
  });
}

// ── Dessine un anneau (liste de {node,x0,x1}, r1, r2, colorFn) ─────────────
function _drawRing(g, slices, r1, r2, colorFn, onMouseover, onClick, cls) {
  const PAD = 0.0025;
  const paths = g.selectAll('.' + cls)
    .data(slices, s => s.node.data.url || s.node.data.name)
    .join('path')
    .attr('class', 'arc-path ' + cls)
    .attr('fill', s => colorFn(s))
    .attr('opacity', 0)
    .style('cursor', 'pointer')
    .attr('d', s => {
      const span = s.x1 - s.x0;
      if (span < 0.001) return '';
      return d3.arc()({
        innerRadius: r1, outerRadius: r2,
        startAngle: s.x0 + PAD, endAngle: Math.max(s.x1 - PAD, s.x0 + PAD + 0.0001),
      });
    });

  // Animation entrée
  paths.transition().duration(450).ease(d3.easeCubicOut)
    .attr('opacity', 0.88)
    .attrTween('d', function(s) {
      const iInner = d3.interpolate(r1 + (r2 - r1) * 0.55, r1);
      const iEnd   = d3.interpolate(s.x0 + PAD, Math.max(s.x1 - PAD, s.x0 + PAD + 0.001));
      return t => d3.arc()({
        innerRadius: iInner(t), outerRadius: r2,
        startAngle: s.x0 + PAD,
        endAngle: Math.max(iEnd(t), s.x0 + PAD + 0.0001),
      });
    });

  paths
    .on('mouseover', function(event, s) {
      d3.select(this).attr('opacity', 1).attr('stroke', '#fff').attr('stroke-width', 0.8);
      onMouseover(event, s);
    })
    .on('mousemove', moveTip)
    .on('mouseleave', function() {
      d3.select(this).attr('opacity', 0.88).attr('stroke', null);
      hideTip();
    })
    .on('click', function(event, s) { event.stopPropagation(); onClick(s); });

  return paths;
}

// ── Labels sur un anneau ────────────────────────────────────────────────────
// colorFn(s) optionnel : retourne la couleur du texte pour chaque slice (sinon '#fff')
function _drawLabels(g, slices, r1, r2, labelFn, minSpan, cls, colorFn) {
  const rMid = (r1 + r2) / 2;
  g.append('g').attr('class', 'arc-label ' + cls).attr('pointer-events', 'none')
    .selectAll('text')
    .data(slices.filter(s => (s.x1 - s.x0) > minSpan))
    .join('text')
    .attr('transform', s => {
      const angle = (s.x0 + s.x1) / 2 * 180 / Math.PI - 90;
      return `rotate(${angle}) translate(${rMid},0) rotate(${angle > 90 ? 180 : 0})`;
    })
    .attr('text-anchor', 'middle').attr('dy', '0.35em')
    .style('font-size', '9px')
    .style('fill', colorFn ? s => colorFn(s) : '#fff')
    .style('font-weight', '500')
    .style('font-family', 'Inter, Arial, sans-serif').style('pointer-events', 'none')
    .text(s => labelFn(s));
}

// ── Centre cliquable ────────────────────────────────────────────────────────
function _drawCenter(g, r, label1, label2, label3, onClickFn) {
  g.selectAll('.center-circle,.center-text').remove();
  const circle = g.append('circle').attr('class', 'center-circle')
    .attr('r', r - 2).attr('fill', 'var(--bg, #1a2327)')
    .attr('stroke', 'rgba(255,255,255,0.08)').attr('stroke-width', 1)
    .style('cursor', onClickFn ? 'pointer' : 'default');
  if (onClickFn) {
    circle.on('click', onClickFn)
      .on('mouseover', function() { d3.select(this).attr('fill', 'rgba(255,255,255,0.05)'); })
      .on('mouseleave', function() { d3.select(this).attr('fill', 'var(--bg, #1a2327)'); });
  }
  const texts = [
    { t: label1, dy: label3 ? '-1.1em' : '-0.1em', size: '13px', weight: '700', color: isLight() ? '#393E41' : '#e9eef4' },
    { t: label2, dy: '0.9em',  size: '9px',  weight: '400', color: isLight() ? 'rgba(57,62,65,0.45)' : 'rgba(255,255,255,0.35)' },
    { t: label3, dy: '2.3em',  size: '9px',  weight: '400', color: themeHint() },
  ];
  texts.forEach(({ t, dy, size, weight, color }) => {
    if (!t) return;
    g.append('text').attr('class', 'center-text')
      .attr('text-anchor', 'middle').attr('dy', dy)
      .style('font-size', size).style('font-weight', weight).style('fill', color)
      .style('pointer-events', 'none').style('font-family', 'Inter, Arial, sans-serif')
      .text(t);
  });
}

// ── Render principal ────────────────────────────────────────────────────────
function _sunburstRender(g, groupeNode, deputeNode, radius, _unused) {
  const INNER_R  = radius * 0.21;
  const OUTER_R  = radius - 2;

  // Nettoyer
  g.selectAll('.arc-path,.arc-label,.center-circle,.center-text').remove();
  _sunburstPaths = null;

  if (!groupeNode) {
    // ════ VUE GLOBALE : anneau1=groupes, anneau2=députés ═════════════════
    const MID_R = radius * 0.52;

    // Anneau groupes (depth 1) — angles issus de la partition D3
    const groupeSlices = _sunburstHier.children.map(n => ({ node: n, x0: n.x0, x1: n.x1 }));

    const gPaths = _drawRing(g, groupeSlices, INNER_R, MID_R - 3,
      s => s.node.data.couleur || gColor(s.node.data.name),
      (event, s) => showTip(
        `<strong>${s.node.data.name}</strong><br>${s.node.children?.length ?? 0} ${currentDataset === 'senateurs' ? 'sénateur(s)' : 'député(s)'} avec participation(s)<br>Valeur : ${formatEur(s.node.value)}`,
        event),
      s => { _sunburstZoomed = { level: 1, groupeNode: s.node, deputeNode: null }; _sunburstRender(g, s.node, null, radius, true); setFilter(s.node.data.name, true); },
      'ring-groupe');

    // Anneau députés (depth 2) — dégradé par rang de richesse dans le groupe
    const deputeSlices = _sunburstHier.children.flatMap(gn =>
      (gn.children || []).map(dn => ({ node: dn, x0: dn.x0, x1: dn.x1 }))
    );
    // Calcul du rang de chaque député au sein de son groupe (trié par valeur décroissante)
    const _depRankMap = {};
    for (const gn of _sunburstHier.children) {
      const sorted = (gn.children || []).slice().sort((a, b) => b.value - a.value);
      sorted.forEach((dn, i) => {
        _depRankMap[dn.data.url || dn.data.name] = { rank: i, total: sorted.length };
      });
    }
    deputeSlices.forEach(s => {
      const info = _depRankMap[s.node.data.url || s.node.data.name] || { rank: 0, total: 1 };
      s._rank = info.rank;
      s._total = info.total;
    });
    const dPaths = _drawRing(g, deputeSlices, MID_R + 1, OUTER_R,
      s => {
        const base = s.node.data.couleur || gColor(s.node.data.groupe || '');
        const t = s._total > 1 ? s._rank / (s._total - 1) : 0;
        const c = d3.color(base);
        if (!c) return base;
        // rang 0 (le plus riche) garde la couleur du groupe ; les suivants s'éclaircissent progressivement
        return t < 0.01 ? c.toString() : c.brighter(t * 1.2).toString();
      },
      (event, s) => showTip(
        `<strong>${s.node.data.name}</strong><br>${s.node.data.groupe}<br>${s.node.data.nbParts} participation(s) · ${s.node.data.rawValue > 0 ? formatEur(s.node.data.rawValue) : 'valeur non précisée'}`,
        event),
      s => {
        if (s.node.data.url) {
          const d = s.node.data;
          const parts = d.name.split(' ');
          // Drill-down vers niveau groupe+député, puis filtre dashboard sans re-render sunburst
          const gn = _sunburstHier.descendants().find(n => n.depth === 1 && n.data.name === d.groupe);
          if (gn) {
            _sunburstZoomed = { level: 2, groupeNode: gn, deputeNode: s.node };
            _sunburstRender(g, gn, s.node, radius, true);
          }
          _applyDeputeFilterCharts({ url: d.url, prenom: parts[0], nom: parts.slice(1).join(' '), groupe: d.groupe });
        }
      },
      'ring-depute');

    _sunburstPaths = dPaths; // pour highlight

    // Labels groupes
    _drawLabels(g, groupeSlices, INNER_R, MID_R - 3,
      s => shortGroupe(s.node.data.name), 0.14, 'lbl-groupe',
      s => labelOnColor(s.node.data.couleur || gColor(s.node.data.name)));

    _drawCenter(g, INNER_R, 'Cliquez', 'un groupe', null, null);

  } else if (!deputeNode) {
    // ════ VUE GROUPE : anneau1=députés 360°, anneau2=sociétés ═══════════
    const MID_R = radius * 0.56;

    const totalGroupe = groupeNode.value || 1;
    const depSlices = _spreadAngles(groupeNode.children || [], totalGroupe);

    // Dégradé de richesse : rang 0 = couleur du groupe, rangs suivants s'éclaircissent
    depSlices.forEach((s, i) => { s._rank = i; s._total = depSlices.length; });

    // Anneau députés
    _drawRing(g, depSlices, INNER_R, MID_R - 3,
      s => {
        const base = s.node.data.couleur || gColor(groupeNode.data.name);
        const t = s._total > 1 ? s._rank / (s._total - 1) : 0;
        const c = d3.color(base);
        if (!c) return base;
        return t < 0.01 ? c.toString() : c.brighter(t * 1.0).toString();
      },
      (event, s) => showTip(
        `<strong>${s.node.data.name}</strong><br>${s.node.data.nbParts} participation(s) · ${s.node.data.rawValue > 0 ? formatEur(s.node.data.rawValue) : 'valeur non précisée'}<br><em style="color:${themeHint()}">Cliquer pour voir les sociétés</em>`,
        event),
      s => {
        _sunburstZoomed = { level: 2, groupeNode, deputeNode: s.node };
        _sunburstRender(g, groupeNode, s.node, radius, true);
        const d = s.node.data;
        const parts = d.name.split(' ');
        // Met à jour le dashboard sans re-render sunburst
        _applyDeputeFilterCharts({ url: d.url, prenom: parts[0], nom: parts.slice(1).join(' '), groupe: d.groupe });
      },
      'ring-depute');

    // Anneau sociétés (agrégé par société sur tout le groupe)
    // On construit une map société→valeur totale sur tout le groupe
    const socMap = {};
    let nonPublicGroupTotal = 0;
    let nonPublicGroupCount = 0;
    for (const dn of (groupeNode.children || [])) {
      for (const sn of (dn.children || [])) {
        if (sn.data.isNonPublic) {
          nonPublicGroupTotal += (sn.data.value || 0);
          nonPublicGroupCount++;
        } else {
          const key = sn.data.name;
          socMap[key] = (socMap[key] || 0) + (sn.data.value || 0);
        }
      }
    }
    const socNodes = Object.entries(socMap)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ data: { name, value, type: 'societe', couleur: gColor(groupeNode.data.name) }, value }));
    if (nonPublicGroupCount > 0) {
      socNodes.push({ data: { name: `Non publié (×${nonPublicGroupCount})`, value: nonPublicGroupTotal, isNonPublic: true }, value: nonPublicGroupTotal });
    }

    const totalSoc = socNodes.reduce((s, n) => s + n.value, 0) || 1;
    const socSlices = _spreadAngles(socNodes, totalSoc);

    _drawRing(g, socSlices, MID_R + 1, OUTER_R,
      s => s.node.data.isNonPublic ? '#7a8a90'
        : (d3.color(gColor(groupeNode.data.name))?.brighter(0.15 + socNodes.indexOf(s.node) * 0.06) ?? gColor(groupeNode.data.name)),
      (event, s) => showTip(
        s.node.data.isNonPublic
          ? `<strong>${s.node.data.name}</strong><br><em style="color:rgba(200,180,80,0.85)">Valeur non divulguée</em>`
          : `<strong>${s.node.data.name}</strong><br>${formatEur(s.node.data.value)}<br><em style="color:${themeHint()}">Cliquer pour filtrer</em>`,
        event),
      s => { if (!s.node.data.isNonPublic) selectSocieteFromChart(s.node.data.name); },
      'ring-soc');

    // Labels députés
    _drawLabels(g, depSlices, INNER_R, MID_R - 3,
      s => s.node.data.name.split(' ').pop(), 0.2, 'lbl-dep',
      s => labelOnColor(s.node.data.couleur || gColor(s.node.data.groupe || '')));

    // Labels sociétés (si assez large)
    _drawLabels(g, socSlices, MID_R + 1, OUTER_R,
      s => s.node.data.name.length > 14 ? s.node.data.name.slice(0, 12) + '…' : s.node.data.name,
      0.22, 'lbl-soc',
      _ => labelOnColor(gColor(groupeNode.data.name)));

    _drawCenter(g, INNER_R,
      shortGroupe(groupeNode.data.name),
      formatEur(groupeNode.value),
      '← retour',
      () => { _sunburstZoomed = null; _sunburstRender(g, null, null, radius, true); setFilter(null, true); });

  } else {
    // ════ VUE DÉPUTÉ : anneau1=député (360°), anneau2=ses sociétés ══════
    const MID_R = radius * 0.52;

    const socNodes = (deputeNode.children || []).map(n => ({ data: n.data, value: n.data.value || 0 }));
    if (!socNodes.length) {
      // Pas de sociétés publiques → retour vue groupe
      _sunburstZoomed = { level: 1, groupeNode, deputeNode: null };
      _sunburstRender(g, groupeNode, null, radius, true);
      return;
    }

    const depColor = deputeNode.data.couleur || gColor(deputeNode.data.groupe || '');

    // Anneau intérieur : le député en arc unique (360°)
    const depSlice = [{ node: deputeNode, x0: 0, x1: 2 * Math.PI }];
    _drawRing(g, depSlice, INNER_R, MID_R - 3,
      () => d3.color(depColor)?.brighter(0.35) ?? depColor,
      (event, s) => showTip(
        `<strong>${s.node.data.name}</strong><br>${s.node.data.groupe}<br>` +
        `${s.node.data.nbParts} participation(s) · ` +
        `${s.node.data.rawValue > 0 ? formatEur(s.node.data.rawValue) : 'valeur non précisée'}`,
        event),
      () => {},
      'ring-depute-single');

    _drawLabels(g, depSlice, INNER_R, MID_R - 3,
      s => s.node.data.name, 0.0, 'lbl-dep-single',
      _ => labelOnColor(depColor));

    // Anneau extérieur : ses sociétés
    const totalSoc = socNodes.reduce((s, n) => s + (n.data.value || 0), 0) || 1;
    const socSlices = _spreadAngles(
      socNodes.map(n => ({ ...n, value: n.data.value || 0 })),
      totalSoc
    );

    _drawRing(g, socSlices, MID_R + 1, OUTER_R,
      s => {
        if (s.node.data.isNonPublic) return '#7a8a90';
        const bright = 0.3 + (socSlices.indexOf(s) / Math.max(socSlices.length - 1, 1)) * 0.6;
        return d3.color(depColor)?.brighter(bright) ?? depColor;
      },
      (event, s) => showTip(
        s.node.data.isNonPublic
          ? `<strong>${s.node.data.name}</strong><br><em style="color:rgba(200,180,80,0.85)">Valeur non divulguée</em>`
          : `<strong>${s.node.data.name}</strong><br>${formatEur(s.node.data.value)}<br><em style="color:${themeHint()}">Cliquer pour filtrer</em>`,
        event),
      s => { if (!s.node.data.isNonPublic) selectSocieteFromChart(s.node.data.name); },
      'ring-soc-dep');

    _drawLabels(g, socSlices, MID_R + 1, OUTER_R,
      s => s.node.data.name.length > 14 ? s.node.data.name.slice(0, 12) + '…' : s.node.data.name,
      0.22, 'lbl-soc-dep',
      _ => labelOnColor(depColor));

    _drawCenter(g, INNER_R,
      shortGroupe(deputeNode.data.groupe),
      formatEur(deputeNode.data.rawValue),
      '← retour',
      () => {
        _sunburstZoomed = { level: 1, groupeNode, deputeNode: null };
        _sunburstRender(g, groupeNode, null, radius, true);
      });
  }
}

function updateSunburstHighlight() {
  // Le highlight est géré à la volée dans _drawRing via opacity
  // On re-rend si le zoom a changé
  if (!_sunburstG || !_sunburstHier) return;
  if (_sunburstZoomed) return; // en drill-down, pas de highlight global
  // Vue globale : dégrade les groupes non-actifs
  _sunburstG.selectAll('.ring-groupe')
    .attr('opacity', s => {
      if (!activeGroupe) return 0.88;
      return s.node.data.name === activeGroupe ? 1 : 0.18;
    });
  _sunburstG.selectAll('.ring-depute')
    .attr('opacity', s => {
      if (activeDepute) return s.node.data.url === activeDepute.url ? 1 : 0.08;
      if (activeGroupe)  return s.node.data.groupe === activeGroupe ? 0.88 : 0.1;
      return 0.88;
    });
}

/* ══════════════════════════════════════════════════════════════════════════
   BAR HORIZONTAL — Valeur totale par groupe (trié décroissant)
   ══════════════════════════════════════════════════════════════════════════ */

function buildBarValeurGroupe(wrapperId, byG) {
  const wrap = document.getElementById(wrapperId);
  if (!wrap) return;
  wrap.innerHTML = '';

  // Tri décroissant par valeur — exclut les groupes sans valeur déclarée
  const data = [...byG].filter(d => d.valeur > 0).sort((a, b) => b.valeur - a.valeur);

  const W = wrap.clientWidth || 300;
  // Marge gauche adaptée aux noms complets de groupes (~20 chars max)
  const leftMargin = Math.min(155, Math.floor(W * 0.48));
  const margin = { top: 8, right: 60, bottom: 10, left: leftMargin };
  // Hauteur calée sur le sunburst si disponible, sinon fallback sur le nb de groupes
  const H = _sunburstSize > 0 ? _sunburstSize : data.length * 30 + margin.top + margin.bottom;
  const rowH = (H - margin.top - margin.bottom) / Math.max(data.length, 1);
  const w = W - margin.left - margin.right;
  const h = H - margin.top - margin.bottom;

  const svg = d3.select(wrap).append('svg').attr('width', W).attr('height', H);
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const y = d3.scaleBand().domain(data.map(d => d.groupe)).range([0, h]).padding(0.25);
  const x = d3.scaleLinear().domain([0, d3.max(data, d => d.valeur)]).range([0, w]).nice();

  // Axe Y — nom lisible du groupe
  g.append('g').call(d3.axisLeft(y).tickSize(0).tickFormat(d => shortGroupe(d)))
    .selectAll('text')
    .style('fill', themeText()).style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif')
    .style('cursor', 'pointer')
    .attr('dx', '-4')
    .on('click', (event, d) => setFilter(activeGroupe === d ? null : d));
  g.select('.domain').remove();

  // Zones de clic invisibles sur toute la marge gauche (pour les petites barres)
  // Isolées dans un <g> dédié pour éviter les conflits avec le join des barres
  g.append('g').selectAll('rect').data(data).join('rect')
    .attr('class', 'label-hit')
    .attr('x', -leftMargin)
    .attr('y', d => y(d.groupe))
    .attr('width', leftMargin)
    .attr('height', y.bandwidth())
    .attr('fill', 'transparent')
    .style('cursor', 'pointer')
    .on('mouseover', function(event, d) {
      showTip(`<strong>${d.groupe}</strong><br>Valeur totale : ${formatM(d.valeur)}<br>${d.avecPart} ${currentDataset === 'senateurs' ? 'sénateur(s)' : 'député(s)'} avec participation(s)`, event);
    })
    .on('mousemove', moveTip)
    .on('mouseleave', hideTip)
    .on('click', (event, d) => setFilter(activeGroupe === d.groupe ? null : d.groupe));

  // Axe X (valeur adaptative)
  const xMax = d3.max(data, d => d.valeur) || 1;
  g.append('g').attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(axisFormatter(xMax)))
    .selectAll('text').style('fill', themeTextDim()).style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif');
  g.selectAll('.tick line').attr('stroke', themeAxisLine());
  g.select('.domain').attr('stroke', themeAxis());

  // Barres avec animation entrée — dans un <g> dédié pour éviter conflits avec label-hit
  const barsG = g.append('g');
  barsG.selectAll('rect').data(data).join('rect')
    .attr('y', d => y(d.groupe))
    .attr('x', 0)
    .attr('height', y.bandwidth())
    .attr('width', 0)
    .attr('fill', d => d.couleur)
    .attr('rx', 3)
    .attr('opacity', d => (!activeGroupe || d.groupe === activeGroupe) ? 0.85 : 0.15)
    .style('cursor', 'pointer')
    .transition().duration(500).ease(d3.easeCubicOut)
    .attr('width', d => x(d.valeur));

  barsG.selectAll('rect')
    .on('mouseover', function (event, d) {
      d3.select(this).attr('opacity', 1);
      showTip(`<strong>${d.groupe}</strong><br>Valeur totale : ${formatM(d.valeur)}<br>${d.avecPart} ${currentDataset === 'senateurs' ? 'sénateur(s)' : 'député(s)'} avec participation(s)`, event);
    })
    .on('mousemove', moveTip)
    .on('mouseleave', function (event, d) {
      d3.select(this).attr('opacity', (!activeGroupe || d.groupe === activeGroupe) ? 0.85 : 0.15);
      hideTip();
    })
    .on('click', (event, d) => setFilter(activeGroupe === d.groupe ? null : d.groupe));

  // Labels valeur à droite
  g.selectAll('.val-label').data(data).join('text')
    .attr('class', 'val-label')
    .attr('x', d => x(d.valeur) + 4)
    .attr('y', d => y(d.groupe) + y.bandwidth() / 2)
    .attr('dy', '0.35em')
    .style('fill', themeTextDim()).style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif')
    .text(d => formatM(d.valeur));
}

/* ══════════════════════════════════════════════════════════════════════════
   BAR CHART — % avec participation
   ══════════════════════════════════════════════════════════════════════════ */

function buildBarPct(wrapperId, byG) {
  const wrap = document.getElementById(wrapperId);
  if (!wrap) return;
  wrap.innerHTML = '';

  const data = [...byG].sort((a, b) => (b.deputes ? b.avecPart / b.deputes : 0) - (a.deputes ? a.avecPart / a.deputes : 0));

  const W = wrap.clientWidth || 500;
  const margin = { top: 8, right: 16, bottom: 60, left: 48 };
  const H = 240, w = W - margin.left - margin.right, h = H - margin.top - margin.bottom;

  const svg = d3.select(wrap).append('svg').attr('width', W).attr('height', H);
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const x = d3.scaleBand().domain(data.map(d => d.groupe)).range([0, w]).padding(0.25);
  const y = d3.scaleLinear().domain([0, 100]).range([h, 0]);

  g.append('g').attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(x).tickFormat(shortGroupe))
    .selectAll('text').attr('transform', 'rotate(-35)').attr('text-anchor', 'end')
    .style('fill', '#8892b0').style('font-size', '10px');
  g.selectAll('.domain,.tick line').attr('stroke', '#2a3560');

  g.append('g').call(d3.axisLeft(y).ticks(5).tickFormat(v => v + '%'))
    .selectAll('text').style('fill', '#8892b0').style('font-size', '10px');
  g.select('.domain').attr('stroke', '#2a3560');
  g.selectAll('.tick line').attr('stroke', '#1e2640');

  g.selectAll('rect').data(data).join('rect')
    .attr('x', d => x(d.groupe))
    .attr('y', d => y(d.deputes ? d.avecPart / d.deputes * 100 : 0))
    .attr('width', x.bandwidth())
    .attr('height', d => h - y(d.deputes ? d.avecPart / d.deputes * 100 : 0))
    .attr('fill', d => d.couleur).attr('rx', 3)
    .attr('opacity', d => (!activeGroupe || d.groupe === activeGroupe) ? 0.85 : 0.18)
    .style('cursor', 'pointer')
    .on('mouseover', function (event, d) {
      d3.select(this).attr('opacity', 1);
      const pct = d.deputes ? (d.avecPart / d.deputes * 100).toFixed(1) : 0;
      showTip(`<strong>${d.groupe}</strong><br>${d.avecPart} / ${d.deputes} députés (${pct}%)`, event);
    })
    .on('mousemove', moveTip)
    .on('mouseleave', function (event, d) {
      d3.select(this).attr('opacity', (!activeGroupe || d.groupe === activeGroupe) ? 0.85 : 0.18);
      hideTip();
    })
    .on('click', (event, d) => setFilter(activeGroupe === d.groupe ? null : d.groupe));
}

/* ══════════════════════════════════════════════════════════════════════════
   BAR CHART — Valeur médiane
   ══════════════════════════════════════════════════════════════════════════ */

function buildBarMediane(wrapperId, byG) {
  const wrap = document.getElementById(wrapperId);
  if (!wrap) return;
  wrap.innerHTML = '';

  const data = byG.map(d => ({ ...d, med: Math.round(median(d.valeurs)) }))
    .filter(d => d.med > 0)
    .sort((a, b) => b.med - a.med);
  if (!data.length) return;

  const W = wrap.clientWidth || 500;
  const margin = { top: 8, right: 16, bottom: 60, left: 68 };
  const H = 240, w = W - margin.left - margin.right, h = H - margin.top - margin.bottom;

  const svg = d3.select(wrap).append('svg').attr('width', W).attr('height', H);
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const x = d3.scaleBand().domain(data.map(d => d.groupe)).range([0, w]).padding(0.25);
  const y = d3.scaleLinear().domain([0, d3.max(data, d => d.med) * 1.1]).range([h, 0]);

  g.append('g').attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(x).tickFormat(shortGroupe))
    .selectAll('text').attr('transform', 'rotate(-35)').attr('text-anchor', 'end')
    .style('fill', themeTextDim()).style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif');
  g.selectAll('.domain,.tick line').attr('stroke', themeAxis());

  g.append('g').call(d3.axisLeft(y).ticks(5).tickFormat(formatEur))
    .selectAll('text').style('fill', themeTextDim()).style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif');
  g.select('.domain').attr('stroke', themeAxis());
  g.selectAll('.tick line').attr('stroke', themeAxisLine());

  g.selectAll('rect').data(data).join('rect')
    .attr('x', d => x(d.groupe))
    .attr('y', h)
    .attr('width', x.bandwidth())
    .attr('height', 0)
    .attr('fill', d => d.couleur)
    .attr('rx', 3)
    .attr('opacity', d => (!activeGroupe || d.groupe === activeGroupe) ? 0.85 : 0.15)
    .style('cursor', 'pointer')
    .transition().duration(520).ease(d3.easeCubicOut)
    .attr('y', d => y(d.med))
    .attr('height', d => h - y(d.med));

  g.selectAll('rect')
    .on('mouseover', function (event, d) {
      d3.select(this).attr('opacity', 1);
      showTip(`<strong>${d.groupe}</strong><br>Médiane : ${formatEur(d.med)}<br>${d.avecPart} ${currentDataset === 'senateurs' ? 'sénateur(s)' : 'député(s)'} avec participation(s)`, event);
    })
    .on('mousemove', moveTip)
    .on('mouseleave', function (event, d) {
      d3.select(this).attr('opacity', (!activeGroupe || d.groupe === activeGroupe) ? 0.85 : 0.15);
      hideTip();
    })
    .on('click', (event, d) => setFilter(activeGroupe === d.groupe ? null : d.groupe));
}

/* ══════════════════════════════════════════════════════════════════════════
   BARRES EMPILÉES — Top 25 sociétés, valeur en M€ par groupe
   ══════════════════════════════════════════════════════════════════════════ */

// Sélectionne une société depuis un clic sur le graphique (même logique que le picker)
function selectSocieteFromChart(label) {
  if (!_socList) _socList = getSocietyList();
  const norm = normalizeSearch(label);
  if (activeSocietes.has(norm)) {
    activeSocietes.delete(norm);
  } else {
    activeSocietes.add(norm);
  }
  socPickerApply();
  socPickerRenderTags();
  socPickerRenderDropdown();
}

function buildBarSocietesStacked(wrapperId) {
  const wrap = document.getElementById(wrapperId);
  if (!wrap) return;
  wrap.innerHTML = '';

  // Si un groupe est actif → on filtre les données source sur ce groupe uniquement
  // et on affiche un bar chart simple (pas empilé) avec le top 25 du groupe
  // Sinon → barres empilées toutes données, top 25 global
  const dataSource = activeDepute
    ? allData.filter(d => d.url === activeDepute.url)
    : activeGroupe ? allData.filter(d => d.groupe === activeGroupe)
    : excludedGroupes.size > 0 ? allData.filter(d => !excludedGroupes.has(d.groupe || 'Inconnu'))
    : allData;

  // Pour le stack, on a besoin de tous les groupes possibles
  // (si filtré par député, ses sociétés peuvent être partagées avec d'autres groupes)
  const allGroupes = [...new Set(allData.map(d => d.groupe || 'Inconnu'))];

  // Calcul valeur par (société, groupe) — sur dataSource uniquement
  const socMap = {};
  for (const d of dataSource) {
    const g = d.groupe || 'Inconnu';
    for (const p of filterParticipations(d.participations)) {
      if (isNonPublic(p.societe)) continue;
      const key = p.societe.toUpperCase();
      if (!socMap[key]) {
        socMap[key] = { label: p.societe, totalValeur: 0, byGroupe: {} };
        for (const gr of allGroupes) socMap[key].byGroupe[gr] = 0;
      }
      socMap[key].totalValeur += p.evaluation || 0;
      socMap[key].byGroupe[g] = (socMap[key].byGroupe[g] || 0) + (p.evaluation || 0);
    }
  }

  // Tri par valeur totale — pas de limite, scrollable
  // Si recherche société active : filtre sur le nom
  let topSoc = Object.values(socMap).sort((a, b) => b.totalValeur - a.totalValeur);
  if (activeSocietes.size > 0) {
    topSoc = topSoc.filter(s => {
      const norm = normalizeSearch(s.label);
      return [...activeSocietes].some(sel => norm.includes(sel));
    });
  }
  if (!topSoc.length) return;

  const W = wrap.clientWidth || 900;
  const margin = { top: (activeGroupe && !activeDepute) ? 8 : 16, right: 20, bottom: 10, left: 220 };
  const rowH = 26;
  const H = topSoc.length * rowH + margin.top + margin.bottom;
  const w = W - margin.left - margin.right;
  const h = H - margin.top - margin.bottom;

  const svg = d3.select(wrap).append('svg').attr('width', W).attr('height', H);
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const y = d3.scaleBand().domain(topSoc.map(s => s.label)).range([0, h]).padding(0.2);
  const x = d3.scaleLinear()
    .domain([0, d3.max(topSoc, s => s.totalValeur)])
    .range([0, w]).nice();

  // Axe Y
  g.append('g').call(d3.axisLeft(y).tickSize(0))
    .selectAll('text').style('fill', themeText()).style('font-size', '11px').style('font-family', 'Inter, Arial, sans-serif').attr('dx', '-4');
  g.select('.domain').remove();

  // Axe X (valeur adaptative)
  const xMax = d3.max(topSoc, s => s.totalValeur) || 1;
  g.append('g').attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(x).ticks(6).tickFormat(axisFormatter(xMax)))
    .selectAll('text').style('fill', themeTextDim()).style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif');
  g.selectAll('.tick line').attr('stroke', themeAxisLine());
  g.select('.domain').attr('stroke', themeAxis());

  if (activeGroupe && !activeDepute) {
    // ── Mode groupe : barre simple couleur du groupe ───────────────────────
    const color = gColor(activeGroupe);
    g.selectAll('rect').data(topSoc).join('rect')
      .attr('y', d => y(d.label))
      .attr('x', 0)
      .attr('height', y.bandwidth())
      .attr('width', 0)
      .attr('fill', color)
      .attr('rx', 3)
      .attr('opacity', 0.85)
      .style('cursor', 'pointer')
      .transition().duration(480).ease(d3.easeCubicOut)
      .attr('width', d => x(d.totalValeur));

    g.selectAll('rect')
      .on('mouseover', function (event, d) {
        d3.select(this).attr('opacity', 1);
        showTip(
          `<strong>${d.label}</strong><br>
           <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};margin-right:4px;vertical-align:middle"></span>${activeGroupe}<br>
           <strong>${formatM(d.totalValeur)}</strong>`,
          event
        );
      })
      .on('mousemove', moveTip)
      .on('mouseleave', function () { d3.select(this).attr('opacity', 0.85); hideTip(); })
      .on('click', (event, d) => selectSocieteFromChart(d.label));

    g.selectAll('.soc-total').data(topSoc).join('text')
      .attr('class', 'soc-total')
      .attr('x', d => x(d.totalValeur) + 5)
      .attr('y', d => y(d.label) + y.bandwidth() / 2)
      .attr('dy', '0.35em')
      .style('fill', themeTextDim()).style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif')
      .text(d => formatM(d.totalValeur));

  } else {
    // ── Mode global ou député : barres empilées par groupe ────────────────
    const activeGroupes = allGroupes.filter(gr => topSoc.some(s => s.byGroupe[gr] > 0));
    const stackKeys = activeGroupes;
    const stackData = topSoc.map(s => {
      const row = { societe: s.label, totalValeur: s.totalValeur };
      for (const gr of stackKeys) row[gr] = s.byGroupe[gr] || 0;
      return row;
    });

    const stack = d3.stack().keys(stackKeys).order(d3.stackOrderNone).offset(d3.stackOffsetNone);
    const series = stack(stackData);

    g.append('g')
      .selectAll('g')
      .data(series)
      .join('g')
      .attr('fill', d => gColor(d.key))
      .selectAll('rect')
      .data(d => d.map(v => ({ ...v, key: d.key })))
      .join('rect')
      .attr('y', d => y(d.data.societe))
      .attr('x', d => x(d[0]))
      .attr('height', y.bandwidth())
      .attr('width', 0)
      .attr('rx', 2)
      .attr('opacity', 0.85)
      .style('cursor', 'pointer')
      .transition().duration(480).ease(d3.easeCubicOut)
      .attr('width', d => Math.max(0, x(d[1]) - x(d[0])));

    g.selectAll('g g rect')
      .on('mouseover', function (event, d) {
        d3.select(this).attr('opacity', 1);
        const val = d[1] - d[0];
        const c = gColor(d.key);
        showTip(
          `<strong>${d.data.societe}</strong><br>
           <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${c};margin-right:4px;vertical-align:middle"></span>${d.key}<br>
           <strong>${formatM(val)}</strong> · total : ${formatM(d.data.totalValeur)}`,
          event
        );
      })
      .on('mousemove', moveTip)
      .on('mouseleave', function () { d3.select(this).attr('opacity', 0.85); hideTip(); })
      .on('click', (event, d) => selectSocieteFromChart(d.data.societe));

    // Labels valeur totale
    g.selectAll('.soc-total').data(topSoc).join('text')
      .attr('class', 'soc-total')
      .attr('x', d => x(d.totalValeur) + 5)
      .attr('y', d => y(d.label) + y.bandwidth() / 2)
      .attr('dy', '0.35em')
      .style('fill', themeTextDim()).style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif')
      .text(d => formatM(d.totalValeur));

    // Légende groupes (en haut)
    const legendG = svg.append('g').attr('transform', `translate(${margin.left}, 4)`);
    let lx = 0;
    for (const gr of activeGroupes) {
      const lw = shortGroupe(gr).length * 6 + 16;
      if (lx + lw > w) break;
      legendG.append('rect').attr('x', lx).attr('y', 0).attr('width', 8).attr('height', 8)
        .attr('rx', 2).attr('fill', gColor(gr)).attr('opacity', 0.85);
      legendG.append('text').attr('x', lx + 11).attr('y', 7.5)
        .style('fill', themeTextDim()).style('font-size', '9px').style('font-family', 'Inter, Arial, sans-serif').text(shortGroupe(gr));
      lx += lw;
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   TABLE
   ══════════════════════════════════════════════════════════════════════════ */

// Cale la hauteur de la carte sociétés sur la hauteur du tableau
function syncSocCardHeight() {
  requestAnimationFrame(() => {
    const tableCard = document.querySelector('.table-card');
    const socCard = document.querySelector('.split-layout > .chart-card');
    if (tableCard && socCard) {
      socCard.style.maxHeight = tableCard.offsetHeight + 'px';
    }
  });
}

function applyTableFilters() {
  const q = document.getElementById('search').value.toLowerCase().trim();
  const filtered = allData.filter(d => {
    const parts = filterParticipations(d.participations);
    const matchG = activeGroupe ? d.groupe === activeGroupe
      : excludedGroupes.size > 0 ? !excludedGroupes.has(d.groupe)
      : true;
    const matchD = !activeDepute || d.url === activeDepute.url;
    const matchQ = !q
      || d.nom.toLowerCase().includes(q)
      || d.prenom.toLowerCase().includes(q)
      || parts.some(p => p.societe.toLowerCase().includes(q));
    const matchSoc = activeSocietes.size === 0
      || parts.some(p => {
           const norm = normalizeSearch(p.societe);
           return [...activeSocietes].some(sel => norm.includes(sel));
         });
    return matchG && matchD && matchQ && matchSoc;
  });
  renderTable(filtered);
  syncSocCardHeight();
}

/* ── Société multi-picker ─────────────────────────────────────────────────── */

// Construit la liste de toutes les sociétés publiques triées par valeur totale
function getSocietyList() {
  const map = {};
  for (const d of allData) {
    for (const p of filterParticipations(d.participations)) {
      if (isNonPublic(p.societe)) continue;
      const key = normalizeSearch(p.societe);
      if (!map[key]) map[key] = { label: p.societe, norm: key, total: 0 };
      map[key].total += p.evaluation || 0;
    }
  }
  return Object.values(map).sort((a, b) => b.total - a.total);
}

let _socList = null; // cache

function socPickerApply() {
  currentPage = 1;
  // Auto-tri : si une société est sélectionnée, trier par sa valeur desc
  if (activeSocietes.size > 0) {
    const firstNorm = [...activeSocietes][0];
    sortKey = 'soc:' + firstNorm;
    sortDir = -1;
  } else {
    // Retour au tri par défaut quand on efface
    sortKey = 'valeurTotale';
    sortDir = -1;
  }
  buildBarSocietesStacked('bar-societes-wrap');
  rebuildExplorer();
  updateChartTitles();
  applyTableFilters();
  updateFilterBar();
  // Affiche/masque le bouton clear
  const clearBtn = document.getElementById('soc-picker-clear');
  if (clearBtn) clearBtn.style.display = activeSocietes.size > 0 ? '' : 'none';
  // Render tags
  socPickerRenderTags();
}

function socPickerRenderDropdown() {
  const input = document.getElementById('search-societes');
  const dropdown = document.getElementById('soc-picker-dropdown');
  if (!input || !dropdown) return;

  const q = normalizeSearch(input.value);
  if (!_socList) _socList = getSocietyList();

  const filtered = q
    ? _socList.filter(s => s.norm.includes(q))
    : _socList;

  dropdown.innerHTML = '';
  if (filtered.length === 0) {
    dropdown.innerHTML = '<li class="soc-picker-empty">Aucune société trouvée</li>';
  } else {
    filtered.slice(0, 80).forEach(s => {
      const li = document.createElement('li');
      li.className = 'soc-picker-item' + (activeSocietes.has(s.norm) ? ' selected' : '');
      li.innerHTML = `<input type="checkbox" ${activeSocietes.has(s.norm) ? 'checked' : ''}>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis">${s.label}</span>
        <span style="color:var(--text-dim);font-size:0.68rem;margin-left:6px">${formatM(s.total)}</span>`;
      li.addEventListener('mousedown', e => {
        e.preventDefault(); // évite que l'input perde le focus
        if (activeSocietes.has(s.norm)) activeSocietes.delete(s.norm);
        else activeSocietes.add(s.norm);
        socPickerApply();
        socPickerRenderDropdown(); // re-render dropdown avec checkboxes à jour
      });
      dropdown.appendChild(li);
    });
  }
  dropdown.style.display = '';
}

function socPickerRenderTags() {
  const container = document.getElementById('soc-picker-tags');
  if (!container) return;
  container.innerHTML = '';
  if (!_socList) return;
  activeSocietes.forEach(norm => {
    const entry = _socList.find(s => s.norm === norm);
    const label = entry ? entry.label : norm;
    const tag = document.createElement('div');
    tag.className = 'soc-tag';
    tag.innerHTML = `<span>${label}</span><button title="Retirer" onclick="socPickerRemove('${norm}')">✕</button>`;
    container.appendChild(tag);
  });
}

function socPickerOpen() {
  if (!_socList) _socList = getSocietyList();
  socPickerRenderDropdown();
}

function socPickerOnInput() {
  socPickerRenderDropdown();
}

function socPickerRemove(norm) {
  activeSocietes.delete(norm);
  socPickerApply();
  socPickerRenderDropdown();
}

function socPickerClearAll(reapply = true) {
  activeSocietes = new Set();
  const input = document.getElementById('search-societes');
  if (input) input.value = '';
  const dropdown = document.getElementById('soc-picker-dropdown');
  if (dropdown) dropdown.style.display = 'none';
  const clearBtn = document.getElementById('soc-picker-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  socPickerRenderTags();
  if (reapply) socPickerApply();
}

// Ferme la dropdown si on clique ailleurs
document.addEventListener('click', e => {
  const picker = document.getElementById('societes-picker');
  if (picker && !picker.contains(e.target)) {
    const dropdown = document.getElementById('soc-picker-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  }
});

// Compat : exposer filterSocietes pour tout ancien appel éventuel
function filterSocietes() { socPickerOnInput(); }

// Clés de tri statiques (colonnes fixes)
const STATIC_SORT_KEYS = ['nom', 'groupe', 'departement', 'nbParts', 'valeurTotale'];

function sortTable(key) {
  // Réinitialise les indicateurs sur toutes les colonnes fixes
  STATIC_SORT_KEYS.forEach(k => {
    const el = document.getElementById('s-' + k);
    if (el) el.textContent = '';
  });
  // Réinitialise aussi les indicateurs sur les colonnes dynamiques
  document.querySelectorAll('.s-soc-sort').forEach(el => el.textContent = '');

  if (sortKey === key) sortDir *= -1;
  else { sortKey = key; sortDir = -1; }

  // Indicateur sur la colonne active
  const el = document.getElementById('s-' + key);
  if (el) {
    el.textContent = sortDir > 0 ? ' ↑' : ' ↓';
  } else {
    // Colonne dynamique société
    const dynEl = document.querySelector(`.s-soc-sort[data-key="${CSS.escape(key)}"]`);
    if (dynEl) dynEl.textContent = sortDir > 0 ? ' ↑' : ' ↓';
  }
  applyTableFilters();
}

// Construit la liste des sociétés sélectionnées avec leurs labels réels (pour colonnes dynamiques)
function getActiveSocietesLabels() {
  if (activeSocietes.size === 0) return [];
  if (!_socList) _socList = getSocietyList();
  return [...activeSocietes].map(norm => {
    const entry = _socList.find(s => s.norm === norm);
    return { norm, label: entry ? entry.label : norm };
  });
}

// Met à jour le <thead> pour ajouter/retirer les colonnes dynamiques des sociétés
function updateTableHead() {
  const thead = document.getElementById('table-head');
  if (!thead) return;
  const tr = thead.querySelector('tr');
  if (!tr) return;

  // Retire les anciennes colonnes dynamiques
  tr.querySelectorAll('th.soc-col').forEach(th => th.remove());

  // Retire la colonne "Principales sociétés" fixe si des sociétés sont sélectionnées
  const socFixedTh = tr.querySelector('th.soc-fixed');
  if (socFixedTh) socFixedTh.remove();

  const socCols = getActiveSocietesLabels();

  if (socCols.length > 0) {
    // Colonnes dynamiques (une par société)
    socCols.forEach(({ norm, label }) => {
      const th = document.createElement('th');
      th.className = 'soc-col';
      th.style.cursor = 'pointer';
      th.style.whiteSpace = 'nowrap';
      const sortKey_ = 'soc:' + norm;
      th.onclick = () => sortTable(sortKey_);
      th.innerHTML = `${label} <span class="s-soc-sort" data-key="${sortKey_}"></span>`;
      tr.appendChild(th);
    });
  } else {
    // Colonne fixe "Principales sociétés"
    const th = document.createElement('th');
    th.className = 'soc-fixed';
    th.textContent = 'Principales sociétés';
    tr.appendChild(th);
  }
}

function renderTable(filtered) {
  // Met à jour les colonnes du header
  updateTableHead();

  const socCols = getActiveSocietesLabels();

  // Pour le tri : si sortKey est "soc:xxx", on trie par valeur de cette société
  function getSortVal(d) {
    if (sortKey.startsWith('soc:')) {
      const norm = sortKey.slice(4);
      const parts = filterParticipations(d.participations);
      return parts
        .filter(p => normalizeSearch(p.societe).includes(norm))
        .reduce((s, p) => s + (p.evaluation || 0), 0);
    }
    return d[sortKey] ?? '';
  }

  const sorted = [...filtered].sort((a, b) => {
    const av = getSortVal(a), bv = getSortVal(b);
    return typeof av === 'number' ? (av - bv) * sortDir : String(av).localeCompare(String(bv)) * sortDir;
  });
  const total = sorted.length;
  const pages = Math.ceil(total / PAGE_SIZE) || 1;
  if (currentPage > pages) currentPage = 1;
  const slice = sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';
  for (const d of slice) {
    const visibleParts = filterParticipations(d.participations);
    const color = gColor(d.groupe);
    const isActive = activeDepute && activeDepute.url === d.url;
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    if (isActive) tr.classList.add('row-active');
    tr.title = isActive ? 'Cliquer pour enlever le filtre' : 'Cliquer pour filtrer sur ce député';
    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      if (activeDepute && activeDepute.url === d.url) {
        clearDeputeFilter();
      } else {
        setDeputeFilter(d);
      }
    });

    // Colonnes fixes
    const accentLink = isLight() ? 'var(--accent)' : '#a5b4fc';
    tr.innerHTML = `
      <td>
        <div class="dep-name">
          <a href="https://www.hatvp.fr${d.url}" target="_blank" rel="noopener"
             style="color:${accentLink};text-decoration:none">${d.prenom} ${d.nom}</a>
        </div>
        ${d.qualite ? `<div class="dep-quality">${d.qualite}</div>` : ''}
      </td>
      <td style="white-space:nowrap">
        <span class="group-badge" style="border-color:${color}22">
          <span class="group-dot" style="background:${color}"></span>${d.groupe || '—'}
        </span>
      </td>
      <td style="color:var(--text-muted);font-size:0.73rem">${d.departement || '—'}</td>
      <td><strong style="color:${d.nbParts > 0 ? 'var(--accent)' : 'var(--text-dim)'}">${d.nbParts}</strong></td>
      <td class="amount">${d.valeurTotale > 0 ? formatEur(d.valeurTotale) : '<span style="color:var(--text-dim)">—</span>'}</td>`;

    if (socCols.length > 0) {
      // Colonnes dynamiques : valeur par société sélectionnée
      socCols.forEach(({ norm }) => {
        const td = document.createElement('td');
        td.className = 'amount';
        const val = visibleParts
          .filter(p => normalizeSearch(p.societe).includes(norm))
          .reduce((s, p) => s + (p.evaluation || 0), 0);
        if (val > 0) {
          td.innerHTML = `<strong style="color:var(--accent2)">${formatEur(val)}</strong>`;
        } else {
          td.innerHTML = `<span style="color:var(--text-dim)">—</span>`;
        }
        tr.appendChild(td);
      });
    } else {
      // Colonne fixe : principales sociétés (tags)
      const topSoc = visibleParts.slice().sort((a, b) => b.evaluation - a.evaluation)
        .filter(p => !isNonPublic(p.societe)).slice(0, 4)
        .map(p => `<span class="tag" title="${formatEur(p.evaluation)}">${p.societe}</span>`).join('');
      const nonPubCount = d.participations.filter(p => isNonPublic(p.societe)).length;
      const nonPubStr = nonPubCount > 0
        ? `<span class="tag" style="color:#64748b">${nonPubCount} non publiée${nonPubCount > 1 ? 's' : ''}</span>` : '';
      const td = document.createElement('td');
      td.style.maxWidth = '300px';
      td.innerHTML = topSoc + nonPubStr;
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  const pag = document.getElementById('pagination');
  pag.innerHTML = `<span>${total} ${currentDataset === 'senateurs' ? 'sénateur(s)' : 'député(s)'}</span>`;
  if (pages > 1) {
    const prev = document.createElement('button');
    prev.className = 'page-btn'; prev.textContent = '←'; prev.disabled = currentPage === 1;
    prev.onclick = () => { currentPage--; applyTableFilters(); };
    pag.appendChild(prev);
    const start = Math.max(1, currentPage - 3), end = Math.min(pages, start + 6);
    for (let i = start; i <= end; i++) {
      const btn = document.createElement('button');
      btn.className = 'page-btn' + (i === currentPage ? ' active' : '');
      btn.textContent = i;
      btn.onclick = (p => () => { currentPage = p; applyTableFilters(); })(i);
      pag.appendChild(btn);
    }
    const next = document.createElement('button');
    next.className = 'page-btn'; next.textContent = '→'; next.disabled = currentPage === pages;
    next.onclick = () => { currentPage++; applyTableFilters(); };
    pag.appendChild(next);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════════ */

function main() {
  const raw = window.HATVP_DATA;
  if (!raw || !raw.length) {
    console.error('Erreur : données introuvables (data.js manquant ?)');
    return;
  }

  allData = raw.map(d => ({
    ...d,
    groupe: decodeHtml(d.groupe || ''),
    participations: d.participations.map(p => ({ ...p, societe: (p.societe || '').replace(/\s+/g, ' ').trim() })),
    nbParts: d.participations.length,
    valeurTotale: d.participations.reduce((s, p) => s + (p.evaluation || 0), 0),
  }));

  // Correctifs manuels — députés non reconnus par le scraping AN (apostrophes Unicode, etc.)
  const _GROUPE_OVERRIDES = {
    '/pages_nominatives/d-intorni-christelle-20430': 'Union des droites pour la République',
  };
  allData.forEach(d => { if (_GROUPE_OVERRIDES[d.url]) d.groupe = _GROUPE_OVERRIDES[d.url]; });

  buildColorMap(allData);
  updateHeaderDesc();
  buildGroupeBtns();

  const avecPart = allData.filter(d => d.nbParts > 0).length;
  updateKpis();


  const byG = aggregateByGroupe(allData);
  buildSunburst();
  buildBarValeurGroupe('bar-valeur-groupe-wrap', byG);
  buildBarSocietesStacked('bar-societes-wrap');

  applyTableFilters();

  let _lastMainWidth = 0;
  let _lastSunburstWidth = 0;
  const mainEl = document.querySelector('main');

  const rebuild = debounce(() => {
    // Ne rebuilder que si la LARGEUR a changé (pas juste la hauteur).
    // Évite le double-clignotement des animations quand syncSocCardHeight ou la
    // filter-bar modifient la hauteur de la page sans toucher à la largeur.
    const newW = mainEl ? mainEl.clientWidth : 0;
    if (Math.abs(newW - _lastMainWidth) < 8) return;
    _lastMainWidth = newW;

    if (_currentExplorerView === 'sunburst') {
      const wrap = document.getElementById('sunburst-wrap');
      const sbW = wrap ? wrap.clientWidth : 0;
      if (Math.abs(sbW - _lastSunburstWidth) > 10) {
        _lastSunburstWidth = sbW;
        // Sauvegarder l'état du zoom avant rebuild
        const savedZoom = _sunburstZoomed;
        buildSunburst();
        // Restaurer le zoom après rebuild
        if (savedZoom && _sunburstG && _sunburstHier) {
          if (savedZoom.level === 1 && savedZoom.groupeNode) {
            const gn = _sunburstHier.descendants().find(d => d.depth === 1 && d.data.name === savedZoom.groupeNode.data.name);
            if (gn) { _sunburstZoomed = { level: 1, groupeNode: gn, deputeNode: null }; _sunburstRender(_sunburstG, gn, null, _sunburstSize / 2, false); }
          } else if (savedZoom.level === 2 && savedZoom.groupeNode && savedZoom.deputeNode) {
            const gn = _sunburstHier.descendants().find(d => d.depth === 1 && d.data.name === savedZoom.groupeNode.data.name);
            const dn = gn?.children?.find(d => d.data.url === savedZoom.deputeNode.data.url);
            if (gn && dn) { _sunburstZoomed = { level: 2, groupeNode: gn, deputeNode: dn }; _sunburstRender(_sunburstG, gn, dn, _sunburstSize / 2, false); }
          }
        }
      }
    } else {
      rebuildExplorer();
    }
    const fg = filteredForCharts();
    buildBarValeurGroupe('bar-valeur-groupe-wrap', fg);
    buildBarSocietesStacked('bar-societes-wrap');
  }, 200);

  _lastMainWidth = mainEl ? mainEl.clientWidth : 0;
  _lastSunburstWidth = document.getElementById('sunburst-wrap')?.clientWidth || 0;
  new ResizeObserver(rebuild).observe(mainEl);
}

document.getElementById('search').addEventListener('input', () => { currentPage = 1; applyTableFilters(); });
window.sortTable = sortTable;
window.clearFilter = clearFilter;
window.setDeputeFilter = setDeputeFilter;
window.filterSocietes = filterSocietes;
window.socPickerOnInput = socPickerOnInput;
window.socPickerOpen = socPickerOpen;
window.socPickerClearAll = socPickerClearAll;
window.socPickerRemove = socPickerRemove;
window.updateFilterBar = updateFilterBar;


/* ── Toggle thème clair / sombre ────────────────────────────────────────── */
function toggleTheme() {
  const isLight = document.body.classList.toggle('light');
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = isLight ? 'Mode sombre' : 'Mode clair';
  try { localStorage.setItem('theme', isLight ? 'light' : 'dark'); } catch(e) {}
  // Re-render les graphiques D3 (couleurs texte SVG hardcodées)
  if (_currentExplorerView === 'sunburst') {
    if (_sunburstHier && _sunburstG) {
      const z = _sunburstZoomed;
      _sunburstRender(_sunburstG, z?.groupeNode ?? null, z?.deputeNode ?? null, _sunburstSize / 2, false);
    }
  } else {
    rebuildExplorer(); // treemap ou sankey : rebuild complet pour recalculer les couleurs
  }
  const fg = filteredForCharts();
  buildBarValeurGroupe('bar-valeur-groupe-wrap', fg);
  buildBarSocietesStacked('bar-societes-wrap');
}
window.toggleTheme = toggleTheme;

/* ── Vue explorer (Sunburst / Treemap / Sankey) ─────────────────────────── */
let _sankeyBuilt = false;
let _currentExplorerView = 'sunburst';

function switchExplorerView(view, btn) {
  _currentExplorerView = view;
  document.querySelectorAll('.explorer-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  document.getElementById('sunburst-wrap').style.display  = view === 'sunburst' ? '' : 'none';
  document.getElementById('treemap-wrap').style.display   = view === 'treemap'  ? '' : 'none';
  document.getElementById('sankey-inner').style.display   = view === 'sankey'   ? '' : 'none';

  const w = currentDataset === 'senateurs' ? 'sénateur' : 'député';
  const subtitles = {
    sunburst: `Anneau intérieur = groupe · anneau externe = ${w} · surface ∝ valeur déclarée · double-clic pour zoomer`,
    treemap:  `Surface proportionnelle à la valeur · couleur = groupe · cliquer sur un groupe ou un ${w} pour filtrer`,
    sankey:   'Épaisseur des liens proportionnelle à la valeur · cliquer sur un nœud pour filtrer',
  };
  const sub = document.getElementById('explorer-subtitle');
  if (sub) sub.textContent = subtitles[view] || '';

  // Toujours reconstruire la vue cible avec les filtres courants
  if (view === 'treemap') {
    buildTreemap();
  } else if (view === 'sunburst') {
    buildSunburst();
  } else if (view === 'sankey') {
    if (!_sankeyBuilt) _sankeyBuilt = true;
    if (typeof buildSankey === 'function') buildSankey();
  }
}
window.switchExplorerView = switchExplorerView;

/* ── Changement de dataset (Députés ↔ Sénateurs) ────────────────────────── */
function updateHeaderDesc() {
  const isSen = currentDataset === 'senateurs';
  const n = allData.length;

  // Bandeau header
  const descEl = document.getElementById('header-desc');
  if (descEl) {
    const who = isSen ? `${n} sénateurs du Sénat` : `${n} députés de l'Assemblée Nationale`;
    descEl.innerHTML = `Participations financières et intérêts déclarés par les ${who} · Source : <a href="https://www.hatvp.fr/consulter-les-declarations/#open-data" target="_blank" rel="noopener">hatvp.fr</a>`;
  }

  // Titre explorer
  const explorerTitle = document.getElementById('explorer-title');
  if (explorerTitle) {
    const w = isSen ? 'Sénateurs' : 'Députés';
    explorerTitle.innerHTML = `Explorer : Groupes → ${w} <small>(cliquez pour filtrer)</small>`;
  }

  // Titre section tableau + placeholder recherche + colonne
  const tableTitle = document.getElementById('table-title');
  if (tableTitle) tableTitle.textContent = isSen ? 'Détail par sénateur' : 'Détail par député';

  const searchEl = document.getElementById('search');
  if (searchEl) {
    const ph = isSen ? 'Sénateur, société...' : 'Député, société...';
    searchEl.placeholder = ph;
    searchEl.setAttribute('aria-label', isSen ? 'Rechercher un sénateur ou une société' : 'Rechercher un député ou une société');
  }

  const thNom = document.getElementById('th-nom');
  if (thNom) {
    const sortSpan = document.getElementById('s-nom');
    thNom.innerHTML = `${isSen ? 'Sénateur' : 'Député'} `;
    if (sortSpan) thNom.appendChild(sortSpan);
    else thNom.innerHTML += '<span id="s-nom"></span>';
  }
}

function switchDataset(ds, btn) {
  if (ds === currentDataset) return;

  const raw = ds === 'senateurs' ? window.HATVP_DATA_SENATEURS : window.HATVP_DATA;
  if (!raw || !raw.length) {
    alert(ds === 'senateurs'
      ? 'Données sénateurs non disponibles — lancez fetch_data.py pour les générer.'
      : 'Données députés non disponibles.');
    return;
  }

  currentDataset = ds;

  // Reset tous les filtres
  activeGroupe  = null;
  activeDepute  = null;
  activeSocietes = new Set();
  excludedGroupes = new Set();
  sortKey = 'valeurTotale'; sortDir = -1;
  currentPage = 1;

  // Reset couleurs (groupes différents entre AN et Sénat)
  for (const k in groupColorMap) delete groupColorMap[k];
  for (const k in _groupColorCache) delete _groupColorCache[k];
  _colorIdx = 0;

  // Reset état explorer complet
  _sunburstHier   = null;
  _sunburstG      = null;
  _sunburstZoomed = null;
  _sunburstSvg    = null;
  _sunburstPaths  = null;
  _sunburstSize   = 0;
  _sankeyBuilt    = false;
  _currentExplorerView = 'sunburst';
  // Remettre le bouton Sunburst actif dans le toggle
  document.querySelectorAll('.explorer-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  // Mettre à jour la visibilité des panels (si l'utilisateur était sur treemap/sankey)
  const sbWrap = document.getElementById('sunburst-wrap');
  const tmWrap = document.getElementById('treemap-wrap');
  const skInner = document.getElementById('sankey-inner');
  if (sbWrap)  sbWrap.style.display  = '';
  if (tmWrap)  tmWrap.style.display  = 'none';
  if (skInner) skInner.style.display = 'none';
  // Remettre le sous-titre sunburst
  const explorerSub = document.getElementById('explorer-subtitle');
  const word = ds === 'senateurs' ? 'sénateur' : 'député';
  if (explorerSub) explorerSub.textContent =
    `Anneau intérieur = groupe · anneau externe = ${word} · surface ∝ valeur déclarée · double-clic pour zoomer`;

  // Reconstruire allData
  allData = raw.map(d => ({
    ...d,
    groupe: decodeHtml(d.groupe || ''),
    participations: d.participations.map(p => ({ ...p, societe: (p.societe || '').replace(/\s+/g, ' ').trim() })),
    nbParts: d.participations.length,
    valeurTotale: d.participations.reduce((s, p) => s + (p.evaluation || 0), 0),
  }));

  buildColorMap(allData);

  // Mettre à jour les boutons dataset
  document.querySelectorAll('.dataset-btn').forEach(b => b.classList.toggle('active', b.dataset.ds === ds));

  // Vider le champ de recherche texte (noms différents entre les deux datasets)
  const searchEl = document.getElementById('search');
  if (searchEl) searchEl.value = '';

  updateHeaderDesc();
  buildGroupeBtns();
  clearFilter(); // reconstruit tous les charts (KPIs, barres, explorer, table)
}
window.switchDataset = switchDataset;

/* ── Treemap ─────────────────────────────────────────────────────────────── */
function buildTreemap() {
  const wrap = document.getElementById('treemap-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  const W = wrap.clientWidth || 800;
  const sub = document.getElementById('explorer-subtitle');

  // ── Mode député : treemap plat des participations ─────────────────────────
  if (activeDepute) {
    const dep = allData.find(d => d.url === activeDepute.url);
    if (!dep) return;
    if (sub) sub.textContent = `Participations de ${dep.prenom} ${dep.nom} · surface ∝ valeur · cliquer pour filtrer par société`;

    const clr = gColor(dep.groupe || 'Inconnu');
    const allParts = filterParticipations(dep.participations);
    const publicParts = allParts
      .filter(p => !isNonPublic(p.societe) && (p.evaluation || 0) > 0)
      .sort((a, b) => b.evaluation - a.evaluation);
    const nonPublicCount = allParts.filter(p => isNonPublic(p.societe)).length;

    if (!publicParts.length && !nonPublicCount) {
      wrap.innerHTML = '<div class="empty-state">Aucune participation pour ce député.</div>';
      return;
    }

    // Valeur d'affichage arbitraire pour les non-publiés
    const baseRef = publicParts.length > 0 ? publicParts[publicParts.length - 1].evaluation : 10000;
    const nonPublicDisplayVal = Math.max(baseRef * 0.3, 5000);

    const children = [
      ...publicParts.map(p => ({ name: p.societe, value: p.evaluation, isNonPublic: false })),
      ...(nonPublicCount > 0 ? [{
        name: nonPublicCount > 1 ? `Non publié ×${nonPublicCount}` : 'Non publié',
        value: nonPublicDisplayVal,
        isNonPublic: true,
      }] : []),
    ];

    const H = Math.max(Math.round(W * 0.55), 280);
    const root = d3.hierarchy({
      name: dep.nom,
      children,
    })
      .sum(d => d.value || 0)
      .sort((a, b) => b.value - a.value);

    d3.treemap()
      .size([W, H])
      .paddingOuter(3).paddingTop(0).paddingInner(2)
      .round(true)(root);

    const svg = d3.select(wrap).append('svg')
      .attr('width', W).attr('height', H)
      .style('font-family', 'Inter, Arial, sans-serif')
      .style('opacity', 0);

    (root.children || []).forEach(node => {
      const nw = Math.max(0, node.x1 - node.x0);
      const nh = Math.max(0, node.y1 - node.y0);
      const ratio = root.value ? node.value / root.value : 0;
      const isActive = !node.data.isNonPublic && activeSocietes.has(normalizeSearch(node.data.name));
      const fill    = node.data.isNonPublic ? '#5a6870' : clr;
      const opacity = node.data.isNonPublic ? 0.55 : (isActive ? 1 : 0.42 + ratio * 0.50);

      svg.append('rect')
        .attr('x', node.x0).attr('y', node.y0)
        .attr('width', nw).attr('height', nh)
        .attr('fill', fill)
        .attr('opacity', opacity)
        .attr('stroke', isActive ? '#fff' : (node.data.isNonPublic ? '#9aa8b0' : 'none'))
        .attr('stroke-width', isActive ? 1.5 : (node.data.isNonPublic ? 1 : 0))
        .attr('stroke-dasharray', node.data.isNonPublic ? '3,2' : 'none')
        .attr('rx', 2)
        .style('cursor', node.data.isNonPublic ? 'default' : 'pointer')
        .on('mouseover', (event) => {
          showTip(
            node.data.isNonPublic
              ? `<strong>${node.data.name}</strong><br><em style="color:rgba(200,180,80,0.85)">Valeur non divulguée</em>`
              : `<strong>${node.data.name}</strong><br>${formatEur(node.value)}<br><em style="color:${themeHint()}">Cliquer pour filtrer cette société</em>`,
            event);
        })
        .on('mousemove', moveTip)
        .on('mouseout', () => hideTip())
        .on('click', () => { if (!node.data.isNonPublic) selectSocieteFromChart(node.data.name); });

      if (nw > 40 && nh > 14) {
        const maxChars = Math.max(3, Math.floor(nw / 6.5));
        const nameLabel = node.data.name.length > maxChars
          ? node.data.name.slice(0, maxChars - 1) + '…'
          : node.data.name;
        const lblClr = labelOnColor(fill);
        const lblClrDim = lblClr === '#fff' ? 'rgba(255,255,255,0.65)' : 'rgba(58,48,0,0.55)';
        svg.append('text')
          .attr('x', node.x0 + 4).attr('y', node.y0 + 12)
          .text(nameLabel)
          .attr('fill', lblClr).attr('font-size', '9px').attr('font-weight', '500')
          .style('pointer-events', 'none');
        if (nh > 26 && !node.data.isNonPublic) {
          svg.append('text')
            .attr('x', node.x0 + 4).attr('y', node.y0 + 24)
            .text(formatEur(node.value))
            .attr('fill', lblClrDim).attr('font-size', '8px').attr('font-weight', '300')
            .style('pointer-events', 'none');
        }
      }
    });
    svg.transition().duration(320).ease(d3.easeCubicOut).style('opacity', 1);
    return;
  }

  // ── Mode global / groupe : treemap groupes → députés ─────────────────────
  if (sub) sub.textContent = 'Surface proportionnelle à la valeur · couleur = groupe · cliquer sur un groupe ou un député pour filtrer';

  const H = Math.round(W * 0.62);

  const raw = buildSunburstData();
  if (!raw.children || !raw.children.length) return;

  const root = d3.hierarchy(raw)
    .sum(d => d.value || 0)
    .sort((a, b) => b.value - a.value);

  d3.treemap()
    .size([W, H])
    .paddingOuter(4)
    .paddingTop(20)
    .paddingInner(2)
    .round(true)(root);

  const svg = d3.select(wrap).append('svg')
    .attr('width', W).attr('height', H)
    .style('font-family', 'Inter, Arial, sans-serif')
    .style('opacity', 0);

  (root.children || []).forEach(gNode => {
    const clr = gNode.data.couleur || gColor(gNode.data.name);
    const gw = gNode.x1 - gNode.x0;
    const gh = gNode.y1 - gNode.y0;

    // Fond du groupe
    svg.append('rect')
      .attr('x', gNode.x0).attr('y', gNode.y0)
      .attr('width', gw).attr('height', gh)
      .attr('fill', clr).attr('opacity', 0.12)
      .attr('rx', 3);

    // Bordure du groupe (cliquable)
    svg.append('rect')
      .attr('x', gNode.x0).attr('y', gNode.y0)
      .attr('width', gw).attr('height', gh)
      .attr('fill', 'none')
      .attr('stroke', clr).attr('stroke-width', 1.5)
      .attr('rx', 3)
      .style('cursor', 'pointer')
      .on('click', () => setFilter(gNode.data.name));

    // Label du groupe
    if (gh > 18) {
      const label = shortGroupe(gNode.data.name);
      svg.append('text')
        .attr('x', gNode.x0 + 5).attr('y', gNode.y0 + 14)
        .text(gw > label.length * 6.5 ? label : label.slice(0, Math.max(3, Math.floor(gw / 7))))
        .attr('fill', clr)
        .attr('font-size', '10px').attr('font-weight', '700')
        .style('pointer-events', 'none');
    }

    // Cellules des députés
    (gNode.children || []).forEach(dNode => {
      const dw = Math.max(0, dNode.x1 - dNode.x0);
      const dh = Math.max(0, dNode.y1 - dNode.y0);
      const dep = allData.find(d => d.url === dNode.data.url);

      svg.append('rect')
        .attr('x', dNode.x0).attr('y', dNode.y0)
        .attr('width', dw).attr('height', dh)
        .attr('fill', clr).attr('opacity', 0.72)
        .attr('rx', 2)
        .style('cursor', 'pointer')
        .on('mouseover', (event) => {
          const val = dNode.data.rawValue || 0;
          const groupeName = gNode.data.name || 'Inconnu';
          const groupIsActive = activeGroupe === groupeName
            || (excludedGroupes.size > 0 && !excludedGroupes.has(groupeName));
          const hint = groupIsActive
            ? `<em style="color:${themeHint()}">Cliquer pour filtrer ce député</em>`
            : `<em style="color:${themeHint()}">Cliquer pour filtrer ${shortGroupe(groupeName)}</em>`;
          showTip(`<strong>${dNode.data.name}</strong><br>${shortGroupe(groupeName)}<br>${formatEur(val)}<br>${hint}`, event);
        })
        .on('mousemove', moveTip)
        .on('mouseout', () => hideTip())
        .on('click', () => {
          if (!dep) return;
          // 1er clic → sélectionne le groupe ; 2e clic (groupe déjà actif) → zoom député
          const groupeName = gNode.data.name || 'Inconnu';
          const groupIsActive = activeGroupe === groupeName
            || (excludedGroupes.size > 0 && !excludedGroupes.has(groupeName));
          if (groupIsActive) {
            setDeputeFilter(dep);
          } else {
            setFilter(groupeName);
          }
        });

      // Prénom abrégé + Nom si assez de place
      if (dw > 32 && dh > 13) {
        const parts = dNode.data.name.split(' ');
        const lastName = parts[parts.length - 1];
        const label = dw > (lastName.length * 6.2 + 6) ? lastName
          : lastName.slice(0, Math.max(2, Math.floor((dw - 6) / 6.2)));
        svg.append('text')
          .attr('x', dNode.x0 + 3).attr('y', dNode.y0 + 11)
          .text(label)
          .attr('fill', labelOnColor(clr)).attr('font-size', '9px').attr('font-weight', '500')
          .style('pointer-events', 'none');
      }
    });
  });
  svg.transition().duration(320).ease(d3.easeCubicOut).style('opacity', 1);
}

window.buildTreemap = buildTreemap;

// Restaurer le thème sauvegardé
try {
  if (localStorage.getItem('theme') === 'light') {
    document.body.classList.add('light');
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = '🌙 Mode sombre';
  }
} catch(e) {}

main();
