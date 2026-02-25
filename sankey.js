/* ══════════════════════════════════════════════════════════════════════════
   SANKEY — Groupes → Députés → Sociétés (valeur en M€)
   ══════════════════════════════════════════════════════════════════════════ */

let _sankeyActiveNode = null;

function rebuildSankey() {
  _sankeyActiveNode = null;
  buildSankey();
}
window.rebuildSankey = rebuildSankey;

function buildSankey() {
  // Récupère les paramètres des contrôles
  const topN    = parseInt(document.getElementById('sankey-top-n')?.value    || '25', 10);
  const minVal  = parseInt(document.getElementById('sankey-min-val')?.value  || '500000', 10);
  const filterG = document.getElementById('sankey-groupe')?.value || '';

  const wrap = document.getElementById('sankey-wrap');
  if (!wrap || !allData || !allData.length) return;
  wrap.innerHTML = '';

  // ── 1. Peupler le select groupes (une seule fois) ────────────────────────
  const selG = document.getElementById('sankey-groupe');
  if (selG && selG.options.length <= 1) {
    const groupes = [...new Set(allData.map(d => d.groupe || 'Inconnu'))].sort();
    for (const g of groupes) {
      const opt = document.createElement('option');
      opt.value = g; opt.textContent = shortGroupe(g);
      selG.appendChild(opt);
    }
    if (filterG) selG.value = filterG;
  }

  // ── 2. Construire les liens bruts ─────────────────────────────────────────
  // Source data : tous les députés avec participations
  const source = filterG
    ? allData.filter(d => (d.groupe || 'Inconnu') === filterG)
    : allData;

  // On agrège d'abord par société pour trouver le top N
  const socTotal = {};
  for (const d of source) {
    for (const p of d.participations) {
      if (isNonPublic(p.societe) || !p.evaluation || p.evaluation < minVal) continue;
      const key = p.societe.toUpperCase();
      socTotal[key] = (socTotal[key] || 0) + p.evaluation;
    }
  }
  const topSocSet = new Set(
    Object.entries(socTotal)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([k]) => k)
  );
  if (!topSocSet.size) {
    wrap.innerHTML = '<p style="color:#64748b;padding:20px">Aucune donnée avec ces filtres.</p>';
    return;
  }

  // ── 3. Nœuds & liens ─────────────────────────────────────────────────────
  const nodeMap = {}; // id string → index
  const nodes   = [];
  const links   = [];

  function nodeId(type, name) { return `${type}::${name}`; }
  function getNode(type, name, label, color, meta) {
    const id = nodeId(type, name);
    if (nodeMap[id] === undefined) {
      nodeMap[id] = nodes.length;
      nodes.push({ id, type, name: label || name, color: color || '#445', meta: meta || {} });
    }
    return nodeMap[id];
  }

  for (const d of source) {
    const g  = d.groupe || 'Inconnu';
    const gC = gColor(g);
    const depName = `${d.prenom} ${d.nom}`;

    for (const p of d.participations) {
      if (isNonPublic(p.societe) || !p.evaluation || p.evaluation < minVal) continue;
      const key = p.societe.toUpperCase();
      if (!topSocSet.has(key)) continue;

      const iG   = getNode('groupe',  g,        shortGroupe(g), gC,  { fullName: g });
      const iDep = getNode('depute',  depName,  depName,        d3.color(gC)?.brighter(0.5) ?? gC, { url: d.url, groupe: g });
      const iSoc = getNode('societe', key,      p.societe,      '#6366f1', { fullName: p.societe });

      // Lien groupe → député
      const lgd = links.findIndex(l => l.source === iG && l.target === iDep);
      if (lgd === -1) links.push({ source: iG, target: iDep, value: p.evaluation, _groupe: g });
      else links[lgd].value += p.evaluation;

      // Lien député → société
      const lds = links.findIndex(l => l.source === iDep && l.target === iSoc);
      if (lds === -1) links.push({ source: iDep, target: iSoc, value: p.evaluation, _groupe: g });
      else links[lds].value += p.evaluation;
    }
  }

  if (!links.length) {
    wrap.innerHTML = '<p style="color:#64748b;padding:20px">Aucun lien avec ces filtres.</p>';
    return;
  }

  // ── 4. Layout Sankey ─────────────────────────────────────────────────────
  const W = Math.max(wrap.clientWidth || 900, 700);
  const H = Math.max(nodes.length * 14, 500);
  const margin = { top: 20, right: 180, bottom: 20, left: 160 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;

  const sankey = d3.sankey()
    .nodeWidth(14)
    .nodePadding(8)
    .extent([[0, 0], [innerW, innerH]])
    .nodeSort(null);

  // d3-sankey modifie les objets en place
  const graph = sankey({
    nodes: nodes.map(n => ({ ...n })),
    links: links.map(l => ({ ...l })),
  });

  // ── 5. SVG ───────────────────────────────────────────────────────────────
  const svg = d3.select('#sankey-wrap').append('svg')
    .attr('width', W).attr('height', H + margin.top + margin.bottom)
    .attr('viewBox', `0 0 ${W} ${H + margin.top + margin.bottom}`);

  const root = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  // ── 6. Liens ─────────────────────────────────────────────────────────────
  const linkPath = d3.sankeyLinkHorizontal();

  const linkSel = root.append('g').selectAll('path')
    .data(graph.links)
    .join('path')
    .attr('class', 'sankey-link')
    .attr('d', linkPath)
    .attr('stroke', d => {
      // Couleur du groupe source (depth 0→1) ou du groupe parent (depth 1→2)
      const srcNode = d.source;
      if (srcNode.type === 'groupe') return srcNode.color;
      if (srcNode.type === 'depute') return gColor(srcNode.meta?.groupe || '');
      return '#6366f1';
    })
    .attr('stroke-width', d => Math.max(1, d.width || 1))
    .attr('opacity', 0.22)
    .on('mouseover', function (event, d) {
      d3.select(this).attr('opacity', 0.6);
      showTip(
        `<strong>${d.source.name}</strong> → <strong>${d.target.name}</strong><br>
         ${formatM(d.value)}`,
        event
      );
    })
    .on('mousemove', moveTip)
    .on('mouseleave', function () { d3.select(this).attr('opacity', 0.22); hideTip(); });

  // ── 7. Nœuds ─────────────────────────────────────────────────────────────
  const nodeSel = root.append('g').selectAll('g')
    .data(graph.nodes)
    .join('g')
    .attr('class', 'sankey-node')
    .style('cursor', 'pointer')
    .on('mouseover', function (event, d) {
      const totalIn  = d.targetLinks?.reduce((s, l) => s + l.value, 0) || 0;
      const totalOut = d.sourceLinks?.reduce((s, l) => s + l.value, 0) || 0;
      const val = Math.max(totalIn, totalOut);
      let html = `<strong>${d.name}</strong>`;
      if (d.type === 'groupe')  html += `<br>Groupe politique<br>Total : ${formatM(val)}`;
      if (d.type === 'depute')  html += `<br>${d.meta?.groupe || ''}<br>Total : ${formatM(val)}`;
      if (d.type === 'societe') html += `<br>Société<br>Total détenu : ${formatM(val)}`;
      showTip(html, event);
    })
    .on('mousemove', moveTip)
    .on('mouseleave', () => hideTip())
    .on('click', function (event, d) {
      _sankeyActiveNode = _sankeyActiveNode === d.id ? null : d.id;
      highlightSankey(linkSel, nodeSel, _sankeyActiveNode);
    });

  nodeSel.append('rect')
    .attr('x', d => d.x0)
    .attr('y', d => d.y0)
    .attr('height', d => Math.max(1, d.y1 - d.y0))
    .attr('width', d => d.x1 - d.x0)
    .attr('fill', d => d.color)
    .attr('rx', 3)
    .attr('opacity', 0.9);

  // Labels
  nodeSel.append('text')
    .attr('class', 'sankey-label')
    .attr('x', d => d.x0 < innerW / 2 ? d.x1 + 6 : d.x0 - 6)
    .attr('y', d => (d.y0 + d.y1) / 2)
    .attr('dy', '0.35em')
    .attr('text-anchor', d => d.x0 < innerW / 2 ? 'start' : 'end')
    .text(d => {
      const val = Math.max(
        d.targetLinks?.reduce((s, l) => s + l.value, 0) || 0,
        d.sourceLinks?.reduce((s, l) => s + l.value, 0) || 0
      );
      const label = d.name.length > 28 ? d.name.slice(0, 26) + '…' : d.name;
      return `${label}  ${formatM(val)}`;
    })
    .style('font-size', d => d.type === 'depute' ? '9px' : '11px')
    .style('fill', d => d.type === 'groupe' ? '#e8eaf0' : '#a5b4fc');

  // Titres colonnes
  const colLabels = [
    { text: 'GROUPE POLITIQUE', x: 0 },
    { text: 'DÉPUTÉ', x: innerW / 2 },
    { text: 'SOCIÉTÉ', x: innerW },
  ];
  svg.append('g').attr('transform', `translate(${margin.left},8)`)
    .selectAll('text')
    .data(colLabels)
    .join('text')
    .attr('x', d => d.x)
    .attr('y', 0)
    .attr('text-anchor', (d, i) => i === 0 ? 'start' : i === 2 ? 'end' : 'middle')
    .style('fill', '#475569')
    .style('font-size', '10px')
    .style('font-weight', '700')
    .style('letter-spacing', '0.08em')
    .text(d => d.text);
}

function highlightSankey(linkSel, nodeSel, activeId) {
  if (!activeId) {
    linkSel.attr('opacity', 0.22);
    nodeSel.select('rect').attr('opacity', 0.9);
    return;
  }
  // Trouver les liens connectés au nœud actif
  linkSel.attr('opacity', d => {
    const sid = typeof d.source === 'object' ? d.source.id : d.source;
    const tid = typeof d.target === 'object' ? d.target.id : d.target;
    return (sid === activeId || tid === activeId) ? 0.65 : 0.05;
  });
  nodeSel.select('rect').attr('opacity', d => {
    if (d.id === activeId) return 1;
    // Voisins
    const connected = d.sourceLinks?.some(l => {
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      return tid === activeId;
    }) || d.targetLinks?.some(l => {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      return sid === activeId;
    });
    return connected ? 0.85 : 0.2;
  });
}

// Init : construire le Sankey si l'onglet est déjà actif au chargement
// (normalement non, mais au cas où)
window.buildSankey = buildSankey;
