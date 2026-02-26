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
  const source = filterG
    ? allData.filter(d => (d.groupe || 'Inconnu') === filterG)
    : allData;

  // Agrégat par société pour trouver le top N
  const socTotal = {};
  for (const d of source) {
    for (const p of d.participations) {
      if (isNonPublic(p.societe) || !p.evaluation || p.evaluation < minVal) continue;
      const key = p.societe.toUpperCase();
      socTotal[key] = (socTotal[key] || 0) + p.evaluation;
    }
  }

  // Top N (9999 = toutes)
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

    for (const p of d.participations) {
      if (isNonPublic(p.societe) || !p.evaluation || p.evaluation < minVal) continue;
      const key = p.societe.toUpperCase();
      if (!topSocSet.has(key)) continue;

      const iG   = getNode('groupe',  g,        shortGroupe(g), gC, { fullName: g });
      const iDep = getNode('depute',  depName,  depName,        d3.color(gC)?.brighter(0.5) ?? gC, { url: d.url, groupe: g });
      const iSoc = getNode('societe', key,      p.societe,      '#6fa8bf', { fullName: p.societe });

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
    wrap.innerHTML = '<div class="empty-state">Aucun lien avec ces filtres.</div>';
    return;
  }

  // ── 4. Layout Sankey ─────────────────────────────────────────────────────
  const W = Math.max(wrap.clientWidth || 900, 700);
  // Hauteur dynamique selon le nombre de nœuds, avec un minimum raisonnable
  const H = Math.max(nodes.length * 16, 500, 600);
  const margin = { top: 28, right: 200, bottom: 20, left: 170 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;

  const sankey = d3.sankey()
    .nodeWidth(12)
    .nodePadding(topN >= 9999 ? 5 : 8)
    .extent([[0, 0], [innerW, innerH]])
    .nodeSort(null);

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

  const linkSel = root.append('g').selectAll('path')
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
      showTip(
        `<strong>${d.source.name}</strong> → <strong>${d.target.name}</strong><br>${formatM(d.value)}`,
        event
      );
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
      if (d.type === 'groupe')  html += `<br><span style="color:var(--text-dim)">Groupe politique</span><br>Total : <strong>${formatM(val)}</strong>`;
      if (d.type === 'depute')  html += `<br><span style="color:var(--text-dim)">${d.meta?.groupe || ''}</span><br>Total : <strong>${formatM(val)}</strong>`;
      if (d.type === 'societe') html += `<br><span style="color:var(--text-dim)">Société</span><br>Total détenu : <strong>${formatM(val)}</strong>`;
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
    .attr('height', d => Math.max(2, d.y1 - d.y0))
    .attr('width', d => d.x1 - d.x0)
    .attr('fill', d => d.color)
    .attr('rx', 3)
    .attr('opacity', 0.92);

  // ── 8. Labels ────────────────────────────────────────────────────────────
  const light = isLight();
  const labelColor = light ? 'rgba(57,62,65,0.75)' : 'rgba(200,215,225,0.75)';
  const labelColorDim = light ? 'rgba(57,62,65,0.45)' : 'rgba(200,215,225,0.40)';
  const groupeLabelColor = light ? '#2c3234' : '#dde4ea';

  nodeSel.append('text')
    .attr('class', 'sankey-label')
    .attr('x', d => d.x0 < innerW / 2 ? d.x1 + 8 : d.x0 - 8)
    .attr('y', d => (d.y0 + d.y1) / 2)
    .attr('dy', '0.35em')
    .attr('text-anchor', d => d.x0 < innerW / 2 ? 'start' : 'end')
    .each(function(d) {
      const totalIn  = d.targetLinks?.reduce((s, l) => s + l.value, 0) || 0;
      const totalOut = d.sourceLinks?.reduce((s, l) => s + l.value, 0) || 0;
      const val = Math.max(totalIn, totalOut);
      const label = d.name.length > 30 ? d.name.slice(0, 28) + '…' : d.name;
      const valStr = formatM(val);

      // Tronquer le label si trop grand
      const maxLabelLen = d.type === 'groupe' ? 20 : 26;
      const shortLabel = label.length > maxLabelLen ? label.slice(0, maxLabelLen - 1) + '…' : label;

      const el = d3.select(this);
      el.style('font-size', d.type === 'groupe' ? '11px' : d.type === 'depute' ? '9px' : '10px')
        .style('font-weight', d.type === 'groupe' ? '600' : '400')
        .style('fill', d.type === 'groupe' ? groupeLabelColor : d.type === 'societe' ? labelColor : labelColorDim);

      // Tspan nom
      el.append('tspan').text(shortLabel);
      // Tspan valeur (plus discret)
      el.append('tspan')
        .attr('dx', '4')
        .style('fill', labelColorDim)
        .style('font-size', '9px')
        .style('font-weight', '300')
        .text(valStr);
    });

  // ── 9. Titres colonnes ───────────────────────────────────────────────────
  const colLabelColor = light ? 'rgba(57,62,65,0.35)' : 'rgba(180,200,215,0.4)';
  const colLabels = [
    { text: 'GROUPE POLITIQUE', x: 0, anchor: 'start' },
    { text: 'DÉPUTÉ',           x: innerW / 2, anchor: 'middle' },
    { text: 'SOCIÉTÉ',          x: innerW, anchor: 'end' },
  ];
  svg.append('g').attr('transform', `translate(${margin.left},10)`)
    .selectAll('text')
    .data(colLabels)
    .join('text')
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
  [innerW / 2].forEach(x => {
    root.append('line')
      .attr('x1', x).attr('x2', x)
      .attr('y1', 0).attr('y2', innerH)
      .attr('stroke', light ? 'rgba(57,62,65,0.06)' : 'rgba(255,255,255,0.05)')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '4,4');
  });
}

function highlightSankey(linkSel, nodeSel, activeId) {
  if (!activeId) {
    linkSel.transition().duration(200).attr('opacity', 0.18);
    nodeSel.select('rect').transition().duration(200).attr('opacity', 0.92);
    return;
  }

  linkSel.transition().duration(180).attr('opacity', d => {
    const sid = typeof d.source === 'object' ? d.source.id : d.source;
    const tid = typeof d.target === 'object' ? d.target.id : d.target;
    return (sid === activeId || tid === activeId) ? 0.72 : 0.04;
  });

  nodeSel.select('rect').transition().duration(180).attr('opacity', d => {
    if (d.id === activeId) return 1;
    const connected = d.sourceLinks?.some(l => {
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      return tid === activeId;
    }) || d.targetLinks?.some(l => {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      return sid === activeId;
    });
    return connected ? 0.85 : 0.15;
  });
}

window.buildSankey = buildSankey;
