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

let bouSeulFilter = false; // filtre "bourse uniquement" actif

// Filtre une liste de participations selon le mode bourse
function filterParticipations(parts) {
  if (!bouSeulFilter) return parts;
  return parts.filter(p => !isNonPublic(p.societe) && !isStructurePrivee(p.societe));
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
let sortKey = 'valeurTotale', sortDir = -1;
let currentPage = 1;
const PAGE_SIZE = 30;

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

/* ── Noms courts ─────────────────────────────────────────────────────────── */
function shortGroupe(g) {
  const map = {
    'Rassemblement National': 'RN',
    'Ensemble pour la République': 'EPR',
    'La France insoumise - Nouveau Front Populaire': 'LFI-NFP',
    'Socialistes et apparentés': 'SOC',
    'Droite Républicaine': 'DR',
    'Écologiste et Social': 'ECO',
    'Les Démocrates': 'DEM',
    'Horizons & Indépendants': 'HOR',
    'Libertés, Indépendants, Outre-mer et Territoires': 'LIOT',
    'Gauche Démocrate et Républicaine': 'GDR',
    'Union des droites pour la République': 'UDR',
    'Non inscrit': 'NI',
    'Inconnu': '?',
  };
  return map[g] || g;
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
  const hasAny = activeGroupe || activeDepute || activeSocietes.size > 0;
  bar.classList.toggle('visible', !!hasAny);
  const clearBtn = document.getElementById('filter-bar-clear-btn');
  if (clearBtn) clearBtn.style.display = hasAny ? '' : 'none';
  if (!hasAny) return;

  // Chip groupe
  if (activeGroupe) {
    const chip = document.createElement('div');
    chip.className = 'filter-chip';
    chip.innerHTML = `<span class="chip-icon">●</span>
      <span style="width:8px;height:8px;border-radius:50%;background:${gColor(activeGroupe)};display:inline-block;flex-shrink:0"></span>
      <span>${activeGroupe}</span>
      <button onclick="setFilter(null)" title="Retirer">✕</button>`;
    tags.appendChild(chip);
  }

  // Chip député
  if (activeDepute) {
    const chip = document.createElement('div');
    chip.className = 'filter-chip';
    chip.innerHTML = `<span class="chip-icon">👤</span>
      <span style="width:8px;height:8px;border-radius:50%;background:${gColor(activeDepute.groupe)};display:inline-block;flex-shrink:0"></span>
      <span>${activeDepute.prenom} ${activeDepute.nom}</span>
      <button onclick="clearFilter()" title="Retirer">✕</button>`;
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

function setFilter(groupe) {
  activeGroupe = groupe;
  activeDepute = null;
  updateChartTitles();
  updateFilterBar();
  const fg = filteredForCharts();
  buildBarValeurGroupe('bar-valeur-groupe-wrap', fg);
  buildBarMediane('bar-mediane-wrap', fg);
  buildBarSocietesStacked('bar-societes-wrap');
  // Sunburst : drill-down si groupe sélectionné depuis un autre graphique
  if (_sunburstHier && _sunburstG) {
    if (groupe && (!_sunburstZoomed || _sunburstZoomed.data.name !== groupe)) {
      const node = _sunburstHier.descendants().find(d => d.depth === 1 && d.data.name === groupe);
      if (node) {
        _sunburstZoomed = node;
        _sunburstRender(_sunburstG, _sunburstHier, node, _sunburstSize / 2, true);
      }
    } else if (!groupe && _sunburstZoomed) {
      _sunburstZoomed = null;
      _sunburstRender(_sunburstG, _sunburstHier, null, _sunburstSize / 2, true);
    } else {
      updateSunburstHighlight();
    }
  }
  currentPage = 1;
  applyTableFilters();
}

function setDeputeFilter(depute) {
  activeDepute = depute;
  activeGroupe = null;
  const singleData = allData.filter(d => d.url === depute.url);
  const fg = aggregateByGroupe(singleData);
  updateChartTitles();
  updateFilterBar();
  buildBarValeurGroupe('bar-valeur-groupe-wrap', fg);
  buildBarMediane('bar-mediane-wrap', fg);
  buildBarSocietesStacked('bar-societes-wrap');
  // Sunburst : drill-down sur le groupe du député si pas déjà fait
  if (_sunburstHier && _sunburstG && depute.groupe) {
    if (!_sunburstZoomed || _sunburstZoomed.data.name !== depute.groupe) {
      const node = _sunburstHier.descendants().find(d => d.depth === 1 && d.data.name === depute.groupe);
      if (node) {
        _sunburstZoomed = node;
        _sunburstRender(_sunburstG, _sunburstHier, node, _sunburstSize / 2, true);
      }
    } else {
      updateSunburstHighlight();
    }
  }
  currentPage = 1;
  applyTableFilters();
}

function clearFilter() {
  activeGroupe = null;
  activeDepute = null;
  activeSocietes = new Set();
  socPickerClearAll(false);
  updateChartTitles();
  updateFilterBar();
  const fg = filteredForCharts();
  buildBarValeurGroupe('bar-valeur-groupe-wrap', fg);
  buildBarMediane('bar-mediane-wrap', fg);
  buildBarSocietesStacked('bar-societes-wrap');
  // Sunburst : retour vue globale
  if (_sunburstHier && _sunburstG && _sunburstZoomed) {
    _sunburstZoomed = null;
    _sunburstRender(_sunburstG, _sunburstHier, null, _sunburstSize / 2, true);
  } else {
    updateSunburstHighlight();
  }
  currentPage = 1;
  applyTableFilters();
}

/* ══════════════════════════════════════════════════════════════════════════
   SUNBURST — 2 niveaux : Groupes → Députés
   ══════════════════════════════════════════════════════════════════════════ */

function buildSunburstData() {
  const root = { name: 'root', children: [] };
  const groupMap = {};
  for (const d of allData) {
    if (d.nbParts === 0) continue;
    const g = d.groupe || 'Inconnu';
    if (!groupMap[g]) {
      groupMap[g] = { name: g, couleur: gColor(g), children: [] };
      root.children.push(groupMap[g]);
    }
    // Valeur du député = somme de ses participations (min 1000 pour la visibilité)
    groupMap[g].children.push({
      name: `${d.prenom} ${d.nom}`,
      groupe: g,
      couleur: gColor(g),
      url: d.url,
      value: Math.max(d.valeurTotale, 1000),
      rawValue: d.valeurTotale,
      nbParts: d.nbParts,
    });
  }
  return root;
}

/* ══════════════════════════════════════════════════════════════════════════
   SUNBURST — zoomable drill-down (groupes → 360° députés)
   ══════════════════════════════════════════════════════════════════════════ */

let _sunburstSvg = null;        // SVG persistent
let _sunburstG   = null;        // groupe <g> centré
let _sunburstHier = null;       // hiérarchie D3
let _sunburstZoomed = null;     // nœud actuellement zoomé (null = racine)
let _sunburstPaths = null;      // sélection paths (pour highlight)
let _sunburstSize  = 0;

function buildSunburst() {
  const wrap = document.getElementById('sunburst-wrap');
  if (!wrap) return;
  const W = wrap.clientWidth || 600;
  const size = Math.min(W, 560);
  _sunburstSize = size;
  const radius = size / 2;

  // Rebuild SVG from scratch
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

  const root = buildSunburstData();
  const hier = d3.hierarchy(root)
    .sum(d => d.value || 0)
    .sort((a, b) => b.value - a.value);

  const partition = d3.partition().size([2 * Math.PI, radius]);
  partition(hier);
  _sunburstHier = hier;

  _sunburstRender(g, hier, null, radius, false);
}

function _sunburstRender(g, hier, zoomedNode, radius, animate) {
  const INNER_R = radius * 0.22;   // trou central fixe
  const OUTER_R = radius - 2;

  // Calculer les arcs en fonction du nœud zoomé
  // Si zoomedNode = null  → vue globale (2 anneaux : groupes + députés)
  // Si zoomedNode = groupe → vue drill-down (1 anneau : députés à 360°)

  let arcData, arcFn, colorFn;

  if (!zoomedNode) {
    // ── Vue globale ────────────────────────────────────────────────────────
    const mid = radius * 0.58;
    arcData = hier.descendants().filter(d => d.depth > 0);

    arcFn = d3.arc()
      .startAngle(d => d.x0)
      .endAngle(d => d.x1)
      .padAngle(d => Math.min((d.x1 - d.x0) / 2, 0.004))
      .padRadius(mid)
      .innerRadius(d => d.depth === 1 ? INNER_R : mid + 4)
      .outerRadius(d => d.depth === 1 ? mid - 4 : OUTER_R);

    colorFn = d => {
      const base = d.data.couleur || gColor(d.data.groupe || d.data.name || '');
      if (d.depth === 1) return base;
      return d3.color(base)?.brighter(0.4) ?? base;
    };
  } else {
    // ── Vue drill-down : les enfants du groupe zoomé à 360° ────────────────
    const children = zoomedNode.children || [];
    const totalVal = zoomedNode.value || 1;

    // Recalculer les angles à 360° proportionnellement à la valeur
    let cumAngle = 0;
    arcData = children.map(child => {
      const span = (child.value / totalVal) * 2 * Math.PI;
      const x0 = cumAngle;
      const x1 = cumAngle + span;
      cumAngle = x1;
      return { ...child, _x0: x0, _x1: x1 };
    });

    const PAD = 0.003;
    arcFn = d => d3.arc()({
      innerRadius: INNER_R,
      outerRadius: OUTER_R,
      startAngle: d._x0 + PAD,
      endAngle:   d._x1 - PAD,
    });

    colorFn = d => {
      const base = d.data.couleur || gColor(zoomedNode.data.name || '');
      return d3.color(base)?.brighter(0.5) ?? base;
    };
  }

  // ── Nettoyer et redessiner ─────────────────────────────────────────────
  g.selectAll('.arc-path').remove();
  g.selectAll('.arc-label').remove();
  g.selectAll('.center-circle').remove();
  g.selectAll('.center-text').remove();

  // Paths
  const paths = g.selectAll('.arc-path')
    .data(arcData, d => (d.data?.url || d.data?.name || '') + (zoomedNode ? '_drill' : '_root'))
    .join('path')
    .attr('class', 'arc-path')
    .attr('fill', colorFn)
    .attr('opacity', 0)
    .style('cursor', 'pointer')
    .attr('d', zoomedNode
      ? d => d3.arc()({ innerRadius: INNER_R, outerRadius: OUTER_R, startAngle: d._x0 + 0.003, endAngle: d._x0 + 0.003 })
      : d => { try { return arcFn(d); } catch(e) { return ''; } }
    );

  // Transition entrée
  if (animate) {
    if (zoomedNode) {
      // Arcs partent du centre et s'ouvrent
      paths.transition().duration(500).ease(d3.easeCubicOut)
        .attr('opacity', 0.88)
        .attrTween('d', function(d) {
          const iStart = d3.interpolate(d._x0 + 0.003, d._x0 + 0.003);
          const iEnd   = d3.interpolate(d._x0 + 0.003, d._x1 - 0.003);
          const iInner = d3.interpolate(INNER_R + (OUTER_R - INNER_R) * 0.5, INNER_R);
          return t => d3.arc()({
            innerRadius: iInner(t),
            outerRadius: OUTER_R,
            startAngle:  iStart(t),
            endAngle:    Math.max(iEnd(t), iStart(t) + 0.001),
          });
        });
    } else {
      paths.transition().duration(400).ease(d3.easeCubicOut)
        .attr('opacity', 0.88);
    }
  } else {
    paths.attr('opacity', 0.88)
      .attr('d', zoomedNode
        ? d => d3.arc()({ innerRadius: INNER_R, outerRadius: OUTER_R, startAngle: d._x0 + 0.003, endAngle: d._x1 - 0.003 })
        : d => { try { return arcFn(d); } catch(e) { return ''; } }
      );
  }

  _sunburstPaths = paths;

  // Événements
  paths
    .on('mouseover', function (event, d) {
      d3.select(this).attr('opacity', 1).attr('stroke', '#fff').attr('stroke-width', 1);
      let html = '';
      if (!zoomedNode && d.depth === 1) {
        html = `<strong>${d.data.name}</strong><br>${d.children?.length ?? 0} député(s)<br>Valeur : ${formatEur(d.value)}`;
      } else {
        const node = zoomedNode ? d : d;
        html = `<strong>${node.data.name}</strong><br>${node.data.groupe || ''}<br>${node.data.nbParts ?? ''} participation(s) · ${node.data.rawValue > 0 ? formatEur(node.data.rawValue) : 'valeur non précisée'}`;
      }
      showTip(html, event);
    })
    .on('mousemove', moveTip)
    .on('mouseleave', function () {
      d3.select(this).attr('opacity', 0.88).attr('stroke', null);
      hideTip();
    })
    .on('click', function (event, d) {
      event.stopPropagation();
      if (!zoomedNode) {
        // Vue globale : clic sur groupe → drill-down
        if (d.depth === 1) {
          _sunburstZoomed = d;
          _sunburstRender(_sunburstG, _sunburstHier, d, _sunburstSize / 2, true);
          setFilter(d.data.name);
        } else if (d.depth === 2 && d.data.url) {
          setDeputeFilter({ url: d.data.url, prenom: d.data.name.split(' ')[0], nom: d.data.name.split(' ').slice(1).join(' '), groupe: d.data.groupe });
        }
      } else {
        // Vue drill-down : clic sur député
        if (d.data.url) {
          setDeputeFilter({ url: d.data.url, prenom: d.data.name.split(' ')[0], nom: d.data.name.split(' ').slice(1).join(' '), groupe: d.data.groupe });
        }
      }
    });

  // ── Labels ────────────────────────────────────────────────────────────────
  if (!zoomedNode) {
    // Labels groupes (anneaux groupes uniquement, si assez large)
    g.append('g').attr('class', 'arc-label').attr('pointer-events', 'none')
      .selectAll('text')
      .data(hier.descendants().filter(d => d.depth === 1 && (d.x1 - d.x0) > 0.12))
      .join('text')
      .attr('transform', d => {
        const angle = (d.x0 + d.x1) / 2 * 180 / Math.PI - 90;
        const mid = (INNER_R + radius * 0.56) / 2;
        return `rotate(${angle}) translate(${mid},0) rotate(${angle > 90 ? 180 : 0})`;
      })
      .attr('text-anchor', 'middle').attr('dy', '0.35em')
      .style('font-size', '9px').style('fill', '#fff').style('font-weight', '600')
      .style('font-family', 'Inter, Arial, sans-serif')
      .text(d => shortGroupe(d.data.name));
  } else {
    // Labels députés (si arc assez large)
    const labelsData = arcData.filter(d => (d._x1 - d._x0) > 0.18);
    g.append('g').attr('class', 'arc-label').attr('pointer-events', 'none')
      .selectAll('text')
      .data(labelsData)
      .join('text')
      .attr('transform', d => {
        const angle = (d._x0 + d._x1) / 2 * 180 / Math.PI - 90;
        const r = (INNER_R + OUTER_R) / 2;
        return `rotate(${angle}) translate(${r},0) rotate(${angle > 90 ? 180 : 0})`;
      })
      .attr('text-anchor', 'middle').attr('dy', '0.35em')
      .style('font-size', '9px').style('fill', '#fff').style('font-weight', '500')
      .style('font-family', 'Inter, Arial, sans-serif')
      .text(d => {
        const parts = d.data.name.split(' ');
        return parts[parts.length - 1]; // nom de famille
      });
  }

  // ── Cercle central ────────────────────────────────────────────────────────
  const centerCircle = g.append('circle')
    .attr('class', 'center-circle')
    .attr('r', INNER_R - 2)
    .attr('fill', '#1a2327')
    .attr('stroke', 'rgba(255,255,255,0.08)')
    .attr('stroke-width', 1)
    .style('cursor', zoomedNode ? 'pointer' : 'default');

  if (zoomedNode) {
    // Clic centre → retour vue globale
    centerCircle
      .on('click', () => {
        _sunburstZoomed = null;
        _sunburstRender(_sunburstG, _sunburstHier, null, _sunburstSize / 2, true);
        setFilter(null);
      })
      .on('mouseover', function () { d3.select(this).attr('fill', 'rgba(255,255,255,0.05)'); })
      .on('mouseleave', function () { d3.select(this).attr('fill', '#1a2327'); });

    // Texte centre : nom court du groupe + "← retour"
    const abbr = shortGroupe(zoomedNode.data.name);
    g.append('text').attr('class', 'center-text').attr('text-anchor', 'middle').attr('dy', '-0.7em')
      .style('font-size', '14px').style('font-weight', '700').style('fill', '#e9eef4')
      .style('pointer-events', 'none').style('font-family', 'Inter, Arial, sans-serif')
      .text(abbr);
    g.append('text').attr('class', 'center-text').attr('text-anchor', 'middle').attr('dy', '0.6em')
      .style('font-size', '9px').style('fill', 'rgba(255,255,255,0.35)')
      .style('pointer-events', 'none').style('font-family', 'Inter, Arial, sans-serif')
      .text(formatEur(zoomedNode.value));
    g.append('text').attr('class', 'center-text').attr('text-anchor', 'middle').attr('dy', '2em')
      .style('font-size', '9px').style('fill', 'rgba(113,156,175,0.7)')
      .style('pointer-events', 'none').style('font-family', 'Inter, Arial, sans-serif')
      .text('← retour');
  } else {
    g.append('text').attr('class', 'center-text').attr('text-anchor', 'middle').attr('dy', '-0.1em')
      .style('font-size', '10px').style('fill', 'rgba(255,255,255,0.28)')
      .style('pointer-events', 'none').style('font-family', 'Inter, Arial, sans-serif')
      .text('Cliquez');
    g.append('text').attr('class', 'center-text').attr('text-anchor', 'middle').attr('dy', '1.1em')
      .style('font-size', '10px').style('fill', 'rgba(255,255,255,0.28)')
      .style('pointer-events', 'none').style('font-family', 'Inter, Arial, sans-serif')
      .text('un groupe');
  }
}

function updateSunburstHighlight() {
  if (!_sunburstPaths) return;
  if (_sunburstZoomed) {
    // En mode drill-down : highlight le député actif
    _sunburstPaths.attr('opacity', d => {
      if (!activeDepute) return 0.88;
      return d.data.url === activeDepute.url ? 1 : 0.22;
    });
    return;
  }
  _sunburstPaths.attr('opacity', d => {
    if (activeDepute) {
      if (d.depth === 2) return d.data.url === activeDepute.url ? 1 : 0.08;
      if (d.depth === 1) return d.data.name === activeDepute.groupe ? 0.5 : 0.08;
    }
    if (activeGroupe) {
      const dg = d.data.groupe || d.data.name;
      return dg === activeGroupe ? 1 : 0.12;
    }
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

  // Tri décroissant par valeur
  const data = [...byG].sort((a, b) => b.valeur - a.valeur);

  const W = wrap.clientWidth || 300;
  // Marge gauche adaptée à la largeur du conteneur
  const leftMargin = Math.min(80, Math.floor(W * 0.32));
  const margin = { top: 8, right: 60, bottom: 10, left: leftMargin };
  const rowH = 30;
  const H = data.length * rowH + margin.top + margin.bottom;
  const w = W - margin.left - margin.right;
  const h = H - margin.top - margin.bottom;

  const svg = d3.select(wrap).append('svg').attr('width', W).attr('height', H);
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const y = d3.scaleBand().domain(data.map(d => d.groupe)).range([0, h]).padding(0.25);
  const x = d3.scaleLinear().domain([0, d3.max(data, d => d.valeur)]).range([0, w]).nice();

  // Axe Y — nom court (sigles)
  g.append('g').call(d3.axisLeft(y).tickSize(0).tickFormat(d => shortGroupe(d)))
    .selectAll('text')
    .style('fill', 'rgba(255,255,255,0.6)').style('font-size', '11px').style('font-family', 'Inter, Arial, sans-serif')
    .attr('dx', '-4');
  g.select('.domain').remove();

  // Axe X (valeur adaptative)
  const xMax = d3.max(data, d => d.valeur) || 1;
  g.append('g').attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(axisFormatter(xMax)))
    .selectAll('text').style('fill', 'rgba(255,255,255,0.35)').style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif');
  g.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.06)');
  g.select('.domain').attr('stroke', 'rgba(255,255,255,0.08)');

  // Barres
  g.selectAll('rect').data(data).join('rect')
    .attr('y', d => y(d.groupe))
    .attr('x', 0)
    .attr('height', y.bandwidth())
    .attr('width', d => x(d.valeur))
    .attr('fill', d => d.couleur)
    .attr('rx', 3)
    .attr('opacity', d => (!activeGroupe || d.groupe === activeGroupe) ? 0.88 : 0.18)
    .style('cursor', 'pointer')
    .on('mouseover', function (event, d) {
      d3.select(this).attr('opacity', 1);
      showTip(`<strong>${d.groupe}</strong><br>Valeur totale : ${formatM(d.valeur)}<br>${d.avecPart} député(s) avec participation(s)`, event);
    })
    .on('mousemove', moveTip)
    .on('mouseleave', function (event, d) {
      d3.select(this).attr('opacity', (!activeGroupe || d.groupe === activeGroupe) ? 0.88 : 0.18);
      hideTip();
    })
    .on('click', (event, d) => setFilter(activeGroupe === d.groupe ? null : d.groupe));

  // Labels valeur à droite
  g.selectAll('.val-label').data(data).join('text')
    .attr('class', 'val-label')
    .attr('x', d => x(d.valeur) + 4)
    .attr('y', d => y(d.groupe) + y.bandwidth() / 2)
    .attr('dy', '0.35em')
    .style('fill', 'rgba(255,255,255,0.4)').style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif')
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
    .style('fill', 'rgba(255,255,255,0.35)').style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif');
  g.selectAll('.domain,.tick line').attr('stroke', 'rgba(255,255,255,0.08)');

  g.append('g').call(d3.axisLeft(y).ticks(5).tickFormat(formatEur))
    .selectAll('text').style('fill', 'rgba(255,255,255,0.35)').style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif');
  g.select('.domain').attr('stroke', 'rgba(255,255,255,0.08)');
  g.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.06)');

  g.selectAll('rect').data(data).join('rect')
    .attr('x', d => x(d.groupe)).attr('y', d => y(d.med))
    .attr('width', x.bandwidth()).attr('height', d => h - y(d.med))
    .attr('fill', d => d.couleur).attr('rx', 3)
    .attr('opacity', d => (!activeGroupe || d.groupe === activeGroupe) ? 0.85 : 0.18)
    .style('cursor', 'pointer')
    .on('mouseover', function (event, d) {
      d3.select(this).attr('opacity', 1);
      showTip(`<strong>${d.groupe}</strong><br>Médiane : ${formatEur(d.med)}<br>${d.avecPart} député(s) avec participation(s)`, event);
    })
    .on('mousemove', moveTip)
    .on('mouseleave', function (event, d) {
      d3.select(this).attr('opacity', (!activeGroupe || d.groupe === activeGroupe) ? 0.85 : 0.18);
      hideTip();
    })
    .on('click', (event, d) => setFilter(activeGroupe === d.groupe ? null : d.groupe));
}

/* ══════════════════════════════════════════════════════════════════════════
   BARRES EMPILÉES — Top 25 sociétés, valeur en M€ par groupe
   ══════════════════════════════════════════════════════════════════════════ */

function buildBarSocietesStacked(wrapperId) {
  const wrap = document.getElementById(wrapperId);
  if (!wrap) return;
  wrap.innerHTML = '';

  // Si un groupe est actif → on filtre les données source sur ce groupe uniquement
  // et on affiche un bar chart simple (pas empilé) avec le top 25 du groupe
  // Sinon → barres empilées toutes données, top 25 global
  const dataSource = activeDepute
    ? allData.filter(d => d.url === activeDepute.url)
    : activeGroupe ? allData.filter(d => d.groupe === activeGroupe) : allData;

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
    .selectAll('text').style('fill', 'rgba(255,255,255,0.6)').style('font-size', '11px').style('font-family', 'Inter, Arial, sans-serif').attr('dx', '-4');
  g.select('.domain').remove();

  // Axe X (valeur adaptative)
  const xMax = d3.max(topSoc, s => s.totalValeur) || 1;
  g.append('g').attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(x).ticks(6).tickFormat(axisFormatter(xMax)))
    .selectAll('text').style('fill', 'rgba(255,255,255,0.35)').style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif');
  g.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.06)');
  g.select('.domain').attr('stroke', 'rgba(255,255,255,0.08)');

  if (activeGroupe && !activeDepute) {
    // ── Mode groupe : barre simple couleur du groupe ───────────────────────
    const color = gColor(activeGroupe);
    g.selectAll('rect').data(topSoc).join('rect')
      .attr('y', d => y(d.label))
      .attr('x', 0)
      .attr('height', y.bandwidth())
      .attr('width', d => x(d.totalValeur))
      .attr('fill', color)
      .attr('rx', 3)
      .attr('opacity', 0.88)
      .on('mouseover', function (event, d) {
        d3.select(this).attr('opacity', 1);
        showTip(
          `<strong>${d.label}</strong><br>
           <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:4px"></span>${activeGroupe}<br>
           ${formatM(d.totalValeur)}`,
          event
        );
      })
      .on('mousemove', moveTip)
      .on('mouseleave', function () { d3.select(this).attr('opacity', 0.88); hideTip(); })
      .on('click', () => clearFilter());

    g.selectAll('.soc-total').data(topSoc).join('text')
      .attr('class', 'soc-total')
      .attr('x', d => x(d.totalValeur) + 5)
      .attr('y', d => y(d.label) + y.bandwidth() / 2)
      .attr('dy', '0.35em')
      .style('fill', 'rgba(255,255,255,0.35)').style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif')
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
      .attr('width', d => Math.max(0, x(d[1]) - x(d[0])))
      .attr('rx', 2)
      .attr('opacity', 0.88)
      .on('mouseover', function (event, d) {
        d3.select(this).attr('opacity', 1);
        const val = d[1] - d[0];
        showTip(
          `<strong>${d.data.societe}</strong><br>
           <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${gColor(d.key)};margin-right:4px"></span>${d.key}<br>
           ${formatM(val)} · total société : ${formatM(d.data.totalValeur)}`,
          event
        );
      })
      .on('mousemove', moveTip)
      .on('mouseleave', function () { d3.select(this).attr('opacity', 0.88); hideTip(); })
      .on('click', (event, d) => setFilter(d.key));

    // Labels valeur totale
    g.selectAll('.soc-total').data(topSoc).join('text')
      .attr('class', 'soc-total')
      .attr('x', d => x(d.totalValeur) + 5)
      .attr('y', d => y(d.label) + y.bandwidth() / 2)
      .attr('dy', '0.35em')
      .style('fill', 'rgba(255,255,255,0.35)').style('font-size', '10px').style('font-family', 'Inter, Arial, sans-serif')
      .text(d => formatM(d.totalValeur));

    // Légende groupes (en haut)
    const legendG = svg.append('g').attr('transform', `translate(${margin.left}, 4)`);
    let lx = 0;
    for (const gr of activeGroupes) {
      const lw = shortGroupe(gr).length * 7 + 20;
      if (lx + lw > w) break;
      legendG.append('rect').attr('x', lx).attr('y', 0).attr('width', 8).attr('height', 8)
        .attr('rx', 2).attr('fill', gColor(gr)).attr('opacity', 0.85);
      legendG.append('text').attr('x', lx + 11).attr('y', 7.5)
        .style('fill', 'rgba(255,255,255,0.45)').style('font-size', '9px').style('font-family', 'Inter, Arial, sans-serif').text(shortGroupe(gr));
      lx += lw;
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   TABLE
   ══════════════════════════════════════════════════════════════════════════ */

function applyTableFilters() {
  const q = document.getElementById('search').value.toLowerCase().trim();
  const filtered = allData.filter(d => {
    const parts = filterParticipations(d.participations);
    const matchG = !activeGroupe || d.groupe === activeGroupe;
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
    // En mode bourse, on n'affiche que les députés avec au moins 1 participation filtrée
    const hasParts = !bouSeulFilter || parts.some(p => !isNonPublic(p.societe));
    return matchG && matchD && matchQ && matchSoc && hasParts;
  });
  renderTable(filtered);
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
  buildBarSocietesStacked('bar-societes-wrap');
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
        <span style="color:rgba(255,255,255,0.3);font-size:0.68rem;margin-left:6px">${formatM(s.total)}</span>`;
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
      th.innerHTML = `<span style="color:#a8c8d8">📈</span> ${label} <span class="s-soc-sort" data-key="${sortKey_}"></span>`;
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
    if (isActive) {
      tr.style.background = 'rgba(113,156,175,0.10)';
      tr.style.outline = '1px solid rgba(113,156,175,0.35)';
    }
    tr.title = isActive ? 'Cliquer pour enlever le filtre' : 'Cliquer pour filtrer sur ce député';
    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      if (activeDepute && activeDepute.url === d.url) {
        clearFilter();
      } else {
        setDeputeFilter(d);
      }
    });

    // Colonnes fixes
    tr.innerHTML = `
      <td>
        <a href="https://www.hatvp.fr${d.url}" target="_blank" rel="noopener"
           style="color:#a5b4fc;text-decoration:none;font-weight:500">${d.prenom} ${d.nom}</a>
        <div style="font-size:0.7rem;color:#475569;margin-top:2px">${d.qualite || ''}</div>
      </td>
      <td style="white-space:nowrap">
        <span class="group-dot" style="background:${color}"></span>${d.groupe || '—'}
      </td>
      <td>${d.departement || '—'}</td>
      <td><strong style="color:${d.nbParts > 0 ? '#a5b4fc' : '#475569'}">${d.nbParts}</strong></td>
      <td class="amount">${d.valeurTotale > 0 ? formatEur(d.valeurTotale) : '—'}</td>`;

    if (socCols.length > 0) {
      // Colonnes dynamiques : valeur par société sélectionnée
      socCols.forEach(({ norm }) => {
        const td = document.createElement('td');
        td.className = 'amount';
        const val = visibleParts
          .filter(p => normalizeSearch(p.societe).includes(norm))
          .reduce((s, p) => s + (p.evaluation || 0), 0);
        if (val > 0) {
          td.innerHTML = `<strong style="color:#6faf96">${formatEur(val)}</strong>`;
        } else {
          td.innerHTML = `<span style="color:#475569">—</span>`;
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
  pag.innerHTML = `<span>${total} député(s)</span>`;
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

async function main() {
  document.getElementById('status').textContent = 'Chargement des données...';
  let raw;
  try {
    raw = await fetch('./data.json').then(r => r.json());
  } catch (e) {
    document.getElementById('status').textContent = 'Erreur : ' + e.message;
    return;
  }

  allData = raw.map(d => ({
    ...d,
    groupe: decodeHtml(d.groupe || ''),
    participations: d.participations.map(p => ({ ...p, societe: (p.societe || '').replace(/\s+/g, ' ').trim() })),
    nbParts: d.participations.length,
    valeurTotale: d.participations.reduce((s, p) => s + (p.evaluation || 0), 0),
  }));

  buildColorMap(allData);

  const totalParts = allData.reduce((s, d) => s + d.nbParts, 0);
  const totalVal   = allData.reduce((s, d) => s + d.valeurTotale, 0);
  const avecPart   = allData.filter(d => d.nbParts > 0).length;
  const publicSoc  = new Set(allData.flatMap(d => d.participations.map(p => p.societe).filter(s => !isNonPublic(s))));
  document.getElementById('stat-deputes').textContent = allData.length;
  document.getElementById('stat-avec').textContent = avecPart;
  document.getElementById('stat-participations').textContent = totalParts.toLocaleString('fr-FR');
  document.getElementById('stat-valeur').textContent = formatEur(totalVal);
  document.getElementById('stat-societes').textContent = publicSoc.size;

  const byG = aggregateByGroupe(allData);
  buildSunburst();
  buildBarValeurGroupe('bar-valeur-groupe-wrap', byG);
  buildBarMediane('bar-mediane-wrap', byG);
  buildBarSocietesStacked('bar-societes-wrap');

  sortTable('valeurTotale');

  document.getElementById('status').textContent =
    `${allData.length} députés · ${avecPart} avec participations · données HATVP`;

  const rebuild = debounce(() => {
    buildSunburst();
    const fg = filteredForCharts();
    buildBarValeurGroupe('bar-valeur-groupe-wrap', fg);
    buildBarMediane('bar-mediane-wrap', fg);
    buildBarSocietesStacked('bar-societes-wrap');
  }, 200);

  new ResizeObserver(rebuild).observe(document.querySelector('main'));
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

function toggleBourse() {
  bouSeulFilter = !bouSeulFilter;
  _socList = null; // invalide le cache de la liste des sociétés
  const btn = document.getElementById('bourse-toggle-btn');
  if (btn) btn.classList.toggle('active', bouSeulFilter);
  updateFilterBar();
  const fg = filteredForCharts();
  buildBarValeurGroupe('bar-valeur-groupe-wrap', fg);
  buildBarMediane('bar-mediane-wrap', fg);
  buildBarSocietesStacked('bar-societes-wrap');
  currentPage = 1;
  applyTableFilters();
}
window.toggleBourse = toggleBourse;

/* ── Onglets ─────────────────────────────────────────────────────────────── */
let _sankeyBuilt = false;
function switchTab(id, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  btn.classList.add('active');
  // Construire le sankey la première fois qu'on ouvre l'onglet
  if (id === 'sankey' && !_sankeyBuilt && allData.length) {
    _sankeyBuilt = true;
    if (typeof buildSankey === 'function') buildSankey();
  }
}
window.switchTab = switchTab;

main();
