/* ══════════════════════════════════════════════════════════════════════════
   SANKEY — Groupes → Députés → Sociétés (valeur en M€)
   Répond aux filtres globaux (groupe, député, société, bourse).
   Cliquer un nœud → filtre global sur tout le dashboard.
   ══════════════════════════════════════════════════════════════════════════ */

function rebuildSankey() {
  buildSankey();
}
window.rebuildSankey = rebuildSankey;

// Retourne les députés bruts filtrés par les filtres globaux actifs
function _sankeySource() {
  let base = allData;
  if (activeDepute) return allData.filter(d => d.url === activeDepute.url);
  if (activeGroupe) return allData.filter(d => d.groupe === activeGroupe);
  if (typeof excludedGroupes !== 'undefined' && excludedGroupes.size > 0) {
    base = base.filter(d => !excludedGroupes.has(d.groupe));
  }
  if (activeSocietes && activeSocietes.size > 0) {
    base = base.filter(d =>
      filterParticipations(d.participations).some(p =>
        !isNonPublic(p.societe) && activeSocietes.has(normalizeSearch(p.societe))
      )
    );
  }
  return base;
}

function buildSankey() {
  const topN   = parseInt(document.getElementById('sankey-top-n')?.value    || '9999', 10);
  const minVal = parseInt(document.getElementById('sankey-min-val')?.value  || '0', 10);
  const maxVal = parseInt(document.getElementById('sankey-max-val')?.value  || '9999999999', 10);

  const wrap = document.getElementById('sankey-wrap');
  if (!wrap || !allData || !allData.length) return;
  wrap.innerHTML = '';

  // ── 1. Source : filtres globaux ───────────────────────────────────────────
  const source = _sankeySource();

  // ── 2. Agrégat sociétés pour top N ───────────────────────────────────────
  const socTotal = {};
  for (const d of source) {
    for (const p of filterParticipations(d.participations)) {
      if (isNonPublic(p.societe) || !p.evaluation || p.evaluation < minVal || p.evaluation > maxVal) continue;
      const key = p.societe.toUpperCase();
      socTotal[key] = (socTotal[key] || 0) + p.evaluation;
    }
  }

  const sorted = Object.entries(socTotal).sort((a, b) => b[1] - a[1]);
  const topSocSet = new Set(
    (topN >= 9999 ? sorted : sorted.slice(0, topN)).map(([k]) => k)
  );

  if (!topSocSet.size) {
    wrap.innerHTML = '<div class="empty-state">Aucune donnée avec ces filtres. Essayez de baisser la valeur minimale.</div>';
    return;
  }

  // ── 3. Nœuds & liens ─────────────────────────────────────────────────────
  const nodeMap = {};
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

    for (const p of filterParticipations(d.participations)) {
      if (isNonPublic(p.societe) || !p.evaluation || p.evaluation < minVal || p.evaluation > maxVal) continue;
      const key = p.societe.toUpperCase();
      if (!topSocSet.has(key)) continue;

      const iG   = getNode('groupe',  g,        shortGroupe(g), gC,                                   { fullName: g });
      const iDep = getNode('depute',  d.url,    depName,        d3.color(gC)?.brighter(0.5) ?? gC,   { url: d.url, groupe: g, prenom: d.prenom, nom: d.nom });
      const iSoc = getNode('societe', key,      p.societe,      '#6fa8bf',                            { fullName: p.societe, key });

      const lgd = links.findIndex(l => l.source === iG && l.target === iDep);
      if (lgd === -1) links.push({ source: iG, target: iDep, value: p.evaluation, _groupe: g });
      else links[lgd].value += p.evaluation;

      const lds = links.findIndex(l => l.source === iDep && l.target === iSoc);
      if (lds === -1) links.push({ source: iDep, target: iSoc, value: p.evaluation, _groupe: g });
      else links[lds].value += p.evaluation;
    }
  }

  if (!links.length) {
    wrap.innerHTML = '<div class="empty-state">Aucun lien avec ces filtres.</div>';
    return;
  }

  // ── 4. Layout Sankey ─────────────────────────────────────────────────────
  const W = Math.max(wrap.clientWidth || 900, 700);
  const H = Math.max(nodes.length * 16, 500, 600);
  const margin = { top: 28, right: 200, bottom: 20, left: 170 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;

  const sankey = d3.sankey()
    .nodeWidth(12)
    .nodePadding(topN >= 9999 ? 5 : 8)
    .extent([[0, 0], [innerW, innerH]])
    .nodeSort((a, b) => b.value - a.value);

  const graph = sankey({
    nodes: nodes.map(n => ({ ...n })),
    links: links.map(l => ({ ...l })),
  });

  // ── 5. SVG ───────────────────────────────────────────────────────────────
  const svg = d3.select('#sankey-wrap').append('svg')
    .attr('width', W)
    .attr('height', H + margin.top + margin.bottom)
    .attr('viewBox', `0 0 ${W} ${H + margin.top + margin.bottom}`);

  const root = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  // ── 6. Liens ─────────────────────────────────────────────────────────────
  const linkPath = d3.sankeyLinkHorizontal();

  root.append('g').selectAll('path')
    .data(graph.links)
    .join('path')
    .attr('class', 'sankey-link')
    .attr('d', linkPath)
    .attr('stroke', d => {
      const srcNode = d.source;
      if (srcNode.type === 'groupe') return srcNode.color;
      if (srcNode.type === 'depute') return gColor(srcNode.meta?.groupe || '');
      return '#6fa8bf';
    })
    .attr('stroke-width', d => Math.max(1.5, d.width || 1))
    .attr('opacity', 0.18)
    .on('mouseover', function (event, d) {
      d3.select(this).attr('opacity', 0.62);
      showTip(`<strong>${d.source.name}</strong> → <strong>${d.target.name}</strong><br>${formatM(d.value)}`, event);
    })
    .on('mousemove', moveTip)
    .on('mouseleave', function () { d3.select(this).attr('opacity', 0.18); hideTip(); });

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
      if (d.type === 'groupe')  html += `<br><span style="color:var(--text-dim)">Groupe politique</span><br>Total : <strong>${formatM(val)}</strong><br><em style="color:rgba(113,156,175,0.8)">Cliquer pour filtrer</em>`;
      if (d.type === 'depute')  html += `<br><span style="color:var(--text-dim)">${d.meta?.groupe || ''}</span><br>Total : <strong>${formatM(val)}</strong><br><em style="color:rgba(113,156,175,0.8)">Cliquer pour filtrer</em>`;
      if (d.type === 'societe') html += `<br><span style="color:var(--text-dim)">Société</span><br>Total détenu : <strong>${formatM(val)}</strong><br><em style="color:rgba(113,156,175,0.8)">Cliquer pour filtrer</em>`;
      showTip(html, event);
    })
    .on('mousemove', moveTip)
    .on('mouseleave', () => hideTip())
    .on('click', function (event, d) {
      hideTip();
      if (d.type === 'groupe') {
        // Toggle : si déjà actif, on efface
        setFilter(activeGroupe === d.meta.fullName ? null : d.meta.fullName);
      } else if (d.type === 'depute') {
        if (activeDepute && activeDepute.url === d.meta.url) {
          clearDeputeFilter();
        } else {
          setDeputeFilter({ url: d.meta.url, prenom: d.meta.prenom, nom: d.meta.nom, groupe: d.meta.groupe });
        }
      } else if (d.type === 'societe') {
        selectSocieteFromChart(d.meta.fullName);
      }
    });

  nodeSel.append('rect')
    .attr('x', d => d.x0)
    .attr('y', d => d.y0)
    .attr('height', d => Math.max(2, d.y1 - d.y0))
    .attr('width', d => d.x1 - d.x0)
    .attr('fill', d => d.color)
    .attr('rx', 3)
    .attr('opacity', d => {
      if (activeGroupe && d.type === 'groupe') return d.meta.fullName === activeGroupe ? 1 : 0.35;
      if (activeDepute && d.type === 'depute') return d.meta.url === activeDepute.url ? 1 : 0.35;
      return 0.92;
    });

  // ── 8. Labels ────────────────────────────────────────────────────────────
  const light = isLight();
  const labelColor    = light ? 'rgba(57,62,65,0.75)'  : 'rgba(200,215,225,0.75)';
  const labelColorDim = light ? 'rgba(57,62,65,0.45)'  : 'rgba(200,215,225,0.40)';
  const groupeLabelColor = light ? '#1a2224' : '#dde4ea';

  nodeSel.append('text')
    .attr('class', 'sankey-label')
    .attr('x', d => d.x0 < innerW / 2 ? d.x1 + 8 : d.x0 - 8)
    .attr('y', d => (d.y0 + d.y1) / 2)
    .attr('dy', '0.35em')
    .attr('text-anchor', d => d.x0 < innerW / 2 ? 'start' : 'end')
    .each(function(d) {
      const totalIn  = d.targetLinks?.reduce((s, l) => s + l.value, 0) || 0;
      const totalOut = d.sourceLinks?.reduce((s, l) => s + l.value, 0) || 0;
      const val      = Math.max(totalIn, totalOut);
      const label    = d.name.length > 30 ? d.name.slice(0, 28) + '…' : d.name;
      const maxLen   = d.type === 'groupe' ? 20 : 26;
      const shortLabel = label.length > maxLen ? label.slice(0, maxLen - 1) + '…' : label;

      const el = d3.select(this);
      el.style('font-size',   d.type === 'groupe' ? '11px' : d.type === 'depute' ? '9px' : '10px')
        .style('font-weight', d.type === 'groupe' ? '600' : '400')
        .style('fill',        d.type === 'groupe' ? groupeLabelColor : d.type === 'societe' ? labelColor : labelColorDim);

      el.append('tspan').text(shortLabel);
      el.append('tspan')
        .attr('dx', '4')
        .style('fill', labelColorDim)
        .style('font-size', '9px')
        .style('font-weight', '300')
        .text(formatM(val));
    });

  // ── 9. Titres colonnes ───────────────────────────────────────────────────
  const colLabelColor = light ? 'rgba(57,62,65,0.35)' : 'rgba(180,200,215,0.4)';
  const colLabels = [
    { text: 'GROUPE POLITIQUE', x: 0,        anchor: 'start'  },
    { text: 'DÉPUTÉ',           x: innerW/2,  anchor: 'middle' },
    { text: 'SOCIÉTÉ',          x: innerW,    anchor: 'end'    },
  ];
  svg.append('g').attr('transform', `translate(${margin.left},10)`)
    .selectAll('text').data(colLabels).join('text')
    .attr('x', d => d.x)
    .attr('y', 0)
    .attr('text-anchor', d => d.anchor)
    .style('fill', colLabelColor)
    .style('font-size', '9px')
    .style('font-weight', '600')
    .style('letter-spacing', '0.10em')
    .style('font-family', 'Inter, sans-serif')
    .text(d => d.text);

  // ── 10. Ligne séparatrice ────────────────────────────────────────────────
  root.append('line')
    .attr('x1', innerW/2).attr('x2', innerW/2)
    .attr('y1', 0).attr('y2', innerH)
    .attr('stroke', light ? 'rgba(57,62,65,0.06)' : 'rgba(255,255,255,0.05)')
    .attr('stroke-width', 1)
    .attr('stroke-dasharray', '4,4');
}

window.buildSankey = buildSankey;
