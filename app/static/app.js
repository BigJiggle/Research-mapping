/* Research Map front end: Cytoscape graph + details / AI chat / dose calculator panels. */
"use strict";

// ---------------------------------------------------------------- constants

const TYPE_STYLE = {
  drug:        { color: "#2f6fde", shape: "round-rectangle", label: "Drugs / compounds" },
  target:      { color: "#8e44ad", shape: "ellipse",         label: "Targets (genes, proteins, receptors)" },
  pathway:     { color: "#e67e22", shape: "hexagon",         label: "Pathways / processes" },
  disease:     { color: "#d64545", shape: "diamond",         label: "Diseases / conditions" },
  effect:      { color: "#16a085", shape: "round-triangle",  label: "Effects / outcomes" },
  formulation: { color: "#b8860b", shape: "round-tag",       label: "Formulations" },
  other:       { color: "#8a94a3", shape: "ellipse",         label: "Other" },
  article:     { color: "#5d6d7e", shape: "rectangle",       label: "Articles" },
};
const ENTITY_TYPES = ["drug", "target", "pathway", "disease", "effect", "formulation", "other"];

const REL_STYLE = {
  inhibits:        { color: "#d64545", arrow: "tee" },
  activates:       { color: "#2b9348", arrow: "triangle" },
  upregulates:     { color: "#52b788", arrow: "triangle" },
  downregulates:   { color: "#e07a5f", arrow: "tee" },
  binds:           { color: "#3a86ff", arrow: "circle" },
  agonist_of:      { color: "#06a77d", arrow: "triangle" },
  antagonist_of:   { color: "#ef476f", arrow: "tee" },
  modulates:       { color: "#9b5de5", arrow: "diamond" },
  part_of:         { color: "#9aa5b1", arrow: "triangle", dashed: true },
  treats:          { color: "#118ab2", arrow: "triangle" },
  causes:          { color: "#f4a261", arrow: "triangle" },
  increases:       { color: "#2a9d8f", arrow: "triangle" },
  decreases:       { color: "#c8553d", arrow: "tee" },
  substrate_of:    { color: "#8d99ae", arrow: "triangle", dashed: true },
  metabolized_by:  { color: "#8d99ae", arrow: "triangle", dashed: true },
  associated_with: { color: "#adb5bd", arrow: "none", dashed: true },
};
const LAYER_COL = { article: 0, formulation: 1, drug: 1, target: 2, pathway: 3, other: 3.5, effect: 4, disease: 5 };

// ---------------------------------------------------------------- state & helpers

const state = {
  data: null,
  selected: null,           // {kind: 'entity'|'article'|'relation', id}
  hiddenTypes: new Set(),
  hiddenRels: new Set(),
  showArticles: false,
  hideIsolated: false,
  depth: 2,
  linkMode: null,           // null | {source: id|null}
  chat: { messages: [], mode: "", focus: null, busy: false },
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const md = (s) => DOMPurify.sanitize(marked.parse(s || ""));
const relLabel = (r) => r.replace(/_/g, " ");
const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches;

async function api(path, opts = {}) {
  // The iPad / browser-only build supplies an in-page backend instead of the Python server.
  if (window.LocalBackend) return window.LocalBackend.api(path, opts);
  const res = await fetch(path, {
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {},
    ...opts,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error((data && data.detail) || `Request failed (${res.status})`);
  return data;
}

/** POST and consume a text/event-stream response, calling onEvent(event, data). */
async function streamSSE(path, body, onEvent) {
  if (window.LocalBackend) return window.LocalBackend.stream(path, body, onEvent);
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message", data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      onEvent(event, data ? JSON.parse(data) : null);
    }
  }
}

let toastTimer;
function toast(msg, type = "", ms = 4000) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + type;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

// ---------------------------------------------------------------- graph

cytoscape.use(cytoscapeFcose);

const cy = cytoscape({
  container: $("#cy"),
  wheelSensitivity: 0.3,
  minZoom: 0.1,
  maxZoom: 4,
  style: graphStyle(),
});

function graphStyle() {
  const text = isDark() ? "#e5e9f0" : "#1c2330";
  const outline = isDark() ? "#12151b" : "#ffffff";
  const styles = [
    { selector: "node", style: {
      "label": "data(label)", "font-size": 11, "color": text, "text-valign": "bottom", "text-margin-y": 4,
      "text-wrap": "wrap", "text-max-width": 120, "text-outline-color": outline, "text-outline-width": 2,
      "width": "data(size)", "height": "data(size)", "border-width": 2, "border-color": outline,
    } },
    { selector: "edge", style: {
      "width": "data(weight)", "curve-style": "bezier", "target-arrow-shape": "triangle", "arrow-scale": 1.1, "opacity": 0.85,
      "font-size": 9, "color": text, "text-outline-color": outline, "text-outline-width": 2, "text-rotation": "autorotate",
    } },
    { selector: "edge.show-label", style: { "label": "data(label)" } },
    { selector: "edge.mention", style: { "width": 1, "line-style": "dotted", "line-color": "#9aa5b1", "target-arrow-shape": "none", "opacity": 0.5 } },
    { selector: ".faded", style: { "opacity": 0.12, "text-opacity": 0.1 } },
    { selector: "node.focus", style: { "border-color": "#ffd166", "border-width": 4 } },
    { selector: "edge.focus", style: { "opacity": 1, "label": "data(label)" } },
    { selector: ".filtered", style: { "display": "none" } },
    { selector: "node.ring-guide", style: {
      "background-opacity": 0, "border-width": 1.5, "border-style": "dashed", "border-color": isDark() ? "#3a4352" : "#cfd5de",
      "label": "", "events": "no", "z-index": 0, "z-compound-depth": "bottom", "width": "data(size)", "height": "data(size)", "shape": "ellipse",
    } },
    { selector: "node.new-node", style: { "border-color": "#ffd166", "border-width": 6 } },
    { selector: "node.link-source", style: { "border-color": "#ffd166", "border-width": 5 } },
  ];
  for (const [t, s] of Object.entries(TYPE_STYLE)) {
    styles.push({ selector: `node[type="${t}"]`, style: { "background-color": s.color, "shape": s.shape } });
  }
  for (const [r, s] of Object.entries(REL_STYLE)) {
    styles.push({ selector: `edge[rel="${r}"]`, style: {
      "line-color": s.color, "target-arrow-color": s.color, "target-arrow-shape": s.arrow,
      "line-style": s.dashed ? "dashed" : "solid",
    } });
  }
  styles.push({ selector: "edge[?manual]", style: { "line-style": "dashed" } });
  return styles;
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => cy.style(graphStyle()));

function buildElements(data) {
  const els = [];
  const degree = {};
  for (const r of data.relations) {
    degree[r.source_id] = (degree[r.source_id] || 0) + 1;
    degree[r.target_id] = (degree[r.target_id] || 0) + 1;
  }
  for (const e of data.entities) {
    els.push({ group: "nodes", data: {
      id: "e" + e.id, eid: e.id, label: e.name, type: e.type, kind: "entity",
      size: 22 + Math.min(34, (degree[e.id] || 0) * 4 + e.article_count * 2),
    } });
  }
  for (const a of data.articles) {
    const short = (a.title || "Article").slice(0, 48) + ((a.title || "").length > 48 ? "…" : "");
    els.push({ group: "nodes", classes: "article-node", data: {
      id: "a" + a.id, aid: a.id, label: short + (a.year ? ` (${a.year})` : ""), type: "article", kind: "article", size: 18,
    } });
  }
  // one edge per (source, relation, target); several supporting articles make it thicker
  const groups = new Map();
  for (const r of data.relations) {
    const key = `${r.source_id}|${r.relation}|${r.target_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const [key, rs] of groups) {
    const r = rs[0];
    els.push({ group: "edges", data: {
      id: "g" + key.replace(/\|/g, "_"), rids: rs.map((x) => x.id), source: "e" + r.source_id, target: "e" + r.target_id,
      rel: r.relation, label: relLabel(r.relation) + (rs.length > 1 ? ` ×${rs.length}` : ""), manual: rs.every((x) => x.manual),
      kind: "relation", weight: Math.min(7, 2 + (rs.length - 1) * 1.5),
    } });
  }
  for (const l of data.article_links) {
    els.push({ group: "edges", classes: "mention", data: {
      id: `m${l.article_id}_${l.entity_id}`, source: "a" + l.article_id, target: "e" + l.entity_id, kind: "mention",
    } });
  }
  return els;
}

async function loadGraph({ relayout = false } = {}) {
  const data = await api("/api/graph");
  const oldPositions = {};
  cy.nodes().forEach((n) => { oldPositions[n.id()] = { ...n.position() }; });
  const isNew = cy.elements().length === 0;
  state.data = data;
  cy.elements().remove();
  cy.add(buildElements(data));
  const added = cy.collection();
  cy.nodes().forEach((n) => {
    if (oldPositions[n.id()]) n.position(oldPositions[n.id()]);
    else added.merge(n);
  });
  applyFilters();
  renderArticleList();
  $("#empty-state").classList.toggle("hidden", data.articles.length + data.entities.length > 0);
  if (isNew || relayout) {
    await runLayout({ fresh: true });
  } else if (added.nonempty()) {
    seedNewNodes(added);
    await runLayout({ newNodes: added });
  }
  if (state.selected) reselect();
}

/** Start each new node beside the already-placed nodes it connects to, so the optimizer only has local work to do. */
function seedNewNodes(added) {
  const placed = cy.nodes().not(added).not(".ring-guide");
  const bb = placed.nonempty() ? placed.boundingBox() : { x1: 0, y1: 0, x2: 0, y2: 0 };
  const pending = added.toArray();
  for (let pass = 0; pass < 3 && pending.length; pass++) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const n = pending[i];
      const anchors = n.neighborhood("node").filter((m) => !pending.includes(m));
      if (anchors.empty() && pass < 2) continue;
      let x, y;
      if (anchors.nonempty()) {
        x = anchors.reduce((s, m) => s + m.position("x"), 0) / anchors.length;
        y = anchors.reduce((s, m) => s + m.position("y"), 0) / anchors.length;
      } else {  // unconnected to anything placed: start just outside the current map
        x = bb.x2 + 120;
        y = (bb.y1 + bb.y2) / 2;
      }
      const a = Math.random() * 2 * Math.PI;
      n.position({ x: x + Math.cos(a) * 60, y: y + Math.sin(a) * 60 });
      pending.splice(i, 1);
    }
  }
}

function applyFilters() {
  cy.batch(() => {
    cy.elements().removeClass("filtered");
    cy.nodes().forEach((n) => {
      const t = n.data("type");
      if ((t === "article" && !state.showArticles) || state.hiddenTypes.has(t)) n.addClass("filtered");
    });
    cy.edges().forEach((e) => {
      if (e.data("kind") === "mention" && !state.showArticles) e.addClass("filtered");
      if (e.data("kind") === "relation" && state.hiddenRels.has(e.data("rel"))) e.addClass("filtered");
      if (e.source().hasClass("filtered") || e.target().hasClass("filtered")) e.addClass("filtered");
    });
    if (state.hideIsolated) {
      cy.nodes().forEach((n) => {
        if (n.hasClass("filtered") || n.hasClass("ring-guide") || n.data("type") === "article") return;
        const visibleEdges = n.connectedEdges().filter((e) => !e.hasClass("filtered"));
        if (visibleEdges.length === 0) n.addClass("filtered");
      });
    }
    // labels on edges only when the graph is small enough to read them
    const visibleEdges = cy.edges().filter((e) => !e.hasClass("filtered") && e.data("kind") === "relation");
    visibleEdges.toggleClass("show-label", visibleEdges.length <= 60);
  });
}

// ----- layout engine

const LAYOUT_ANIM_MS = 650;

function fcoseOptions(randomize) {
  const n = cy.nodes().filter((x) => !x.hasClass("filtered")).length;
  return {
    name: "fcose", quality: "proof", randomize, animate: false, fit: false,
    nodeDimensionsIncludeLabels: true, packComponents: true, tile: true,
    nodeSeparation: 90, uniformNodeDimensions: false,
    idealEdgeLength: (e) => (e.data("kind") === "mention" ? 140 : 110),
    edgeElasticity: (e) => (e.data("kind") === "mention" ? 0.2 : 0.45),
    nodeRepulsion: () => 9000 + Math.min(20000, n * 120),
    gravity: 0.25, gravityRange: 3.8, numIter: 5000,
    tilingPaddingVertical: 30, tilingPaddingHorizontal: 30,
  };
}

/** Run a layout without animation and return the resulting positions (restoring the current ones). */
function computePositions(eles, opts) {
  const before = {};
  eles.nodes().forEach((n) => { before[n.id()] = { ...n.position() }; });
  eles.layout(opts).run();
  const after = {};
  eles.nodes().forEach((n) => { after[n.id()] = { ...n.position() }; n.position(before[n.id()]); });
  return after;
}

/** Lower is better: edge crossings, node/label overlaps, uneven edge lengths, and sprawl. */
function scoreLayout(eles, pos) {
  const nodes = eles.nodes().toArray();
  const edges = eles.edges().toArray().filter((e) => pos[e.source().id()] && pos[e.target().id()]);
  const P = (n) => pos[n.id()];
  const ccw = (a, b, c) => (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
  let crossings = 0;
  const cap = Math.min(edges.length, 600);
  for (let i = 0; i < cap; i++) {
    const a = P(edges[i].source()), b = P(edges[i].target());
    for (let j = i + 1; j < cap; j++) {
      const s = edges[j].source(), t = edges[j].target();
      if ([s, t].some((x) => x === edges[i].source() || x === edges[i].target())) continue;
      const c = P(s), d = P(t);
      if (ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d)) crossings++;
    }
  }
  let overlaps = 0;
  for (let i = 0; i < nodes.length; i++) {
    const p = P(nodes[i]), wi = nodes[i].outerWidth() / 2 + 40;  // + label allowance
    for (let j = i + 1; j < nodes.length; j++) {
      const q = P(nodes[j]), wj = nodes[j].outerWidth() / 2 + 40;
      if (Math.abs(p.x - q.x) < wi + wj - 30 && Math.abs(p.y - q.y) < (wi + wj) / 2) overlaps++;
    }
  }
  // edges that run straight through a node they don't belong to
  let throughNodes = 0;
  for (const e of edges) {
    const a = P(e.source()), b = P(e.target());
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
    for (const n of nodes) {
      if (n === e.source() || n === e.target()) continue;
      const c = P(n);
      const t = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / L2));
      if (Math.hypot(a.x + t * dx - c.x, a.y + t * dy - c.y) < n.outerWidth() / 2 + 6) throughNodes++;
    }
  }
  const lens = edges.map((e) => Math.hypot(P(e.source()).x - P(e.target()).x, P(e.source()).y - P(e.target()).y));
  const mean = lens.reduce((s, l) => s + l, 0) / (lens.length || 1);
  const sd = Math.sqrt(lens.reduce((s, l) => s + (l - mean) ** 2, 0) / (lens.length || 1));
  const xs = nodes.map((n) => P(n).x), ys = nodes.map((n) => P(n).y);
  const area = nodes.length ? (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1) : 0;
  const sprawl = Math.sqrt(area / Math.max(1, nodes.length)) / 150;
  return { total: crossings * 3 + overlaps * 5 + throughNodes * 4 + (sd / (mean || 1)) * 4 + sprawl, crossings, overlaps, throughNodes };
}

/** Layered view: columns by type, rows ordered by neighbour barycenters to cut crossings. */
function layeredPositions(eles) {
  const cols = {};
  eles.nodes().forEach((n) => { const c = LAYER_COL[n.data("type")] ?? 3; (cols[c] = cols[c] || []).push(n); });
  const keys = Object.keys(cols).map(Number).sort((a, b) => a - b);
  const rank = {};
  for (const k of keys) {
    cols[k].sort((a, b) => a.data("label").localeCompare(b.data("label")));
    cols[k].forEach((n, i) => { rank[n.id()] = i; });
  }
  const visible = (n) => n.neighborhood("node").filter((m) => eles.contains(m));
  for (let sweep = 0; sweep < 8; sweep++) {
    const order = sweep % 2 === 0 ? keys : [...keys].reverse();
    for (const k of order) {
      const bary = (n) => {
        const nb = visible(n);
        return nb.length ? nb.reduce((s, m) => s + rank[m.id()] / Math.max(1, cols[LAYER_COL[m.data("type")] ?? 3].length), 0) / nb.length : rank[n.id()] / cols[k].length;
      };
      const b = new Map(cols[k].map((n) => [n, bary(n)]));
      cols[k].sort((x, y) => b.get(x) - b.get(y));
      cols[k].forEach((n, i) => { rank[n.id()] = i; });
    }
  }
  // transpose pass: swap neighbours in a column whenever that lowers the crossing score
  const place = () => {
    const pos = {};
    for (const k of keys) cols[k].forEach((n, i) => { pos[n.id()] = { x: k * 260, y: (i - (cols[k].length - 1) / 2) * 70 }; });
    return pos;
  };
  let best = scoreLayout(eles, place()).crossings;
  for (let round = 0; round < 6; round++) {
    let improved = false;
    for (const k of keys) {
      const col = cols[k];
      for (let i = 0; i + 1 < col.length; i++) {
        [col[i], col[i + 1]] = [col[i + 1], col[i]];
        const c = scoreLayout(eles, place()).crossings;
        if (c < best) { best = c; improved = true; } else { [col[i], col[i + 1]] = [col[i + 1], col[i]]; }
      }
    }
    if (!improved) break;
  }
  return place();
}

/** Circular view: concentric rings by type (drugs inside, outcomes outside), each ring ordered to cut crossings. */
const RING = { drug: 0, formulation: 0, target: 1, pathway: 2, other: 2, effect: 3, disease: 3, article: 4 };
const RING_GAP = 170, MIN_ARC = 95;

function radialPositions(eles, keepOrder = false) {
  const byRing = {};
  eles.nodes().forEach((n) => { const r = RING[n.data("type")] ?? 2; (byRing[r] = byRing[r] || []).push(n); });
  const rings = Object.keys(byRing).map(Number).sort((a, b) => a - b).map((r) => byRing[r]);
  const ringOf = new Map();
  rings.forEach((ring, i) => ring.forEach((n) => ringOf.set(n.id(), i)));

  // radii: each ring big enough for its nodes, and clear of the ring inside it
  const radii = [];
  rings.forEach((ring, i) => {
    const needed = (ring.length * MIN_ARC) / (2 * Math.PI);
    radii.push(i === 0 ? (ring.length === 1 ? 0 : Math.max(110, needed)) : Math.max(radii[i - 1] + RING_GAP, needed));
  });

  let angle = new Map();
  // small rings sit in an arc (a pair spread 180° apart would send their link straight through the centre)
  const stepOf = (ring) => (ring.length <= 3 ? Math.min((2 * Math.PI) / ring.length, Math.PI / 2) : (2 * Math.PI) / ring.length);
  const spread = (ring, offset = 0) => ring.forEach((n, i) => angle.set(n.id(), offset - Math.PI / 2 + stepOf(ring) * i));

  const circMean = (as) => Math.atan2(as.reduce((s, a) => s + Math.sin(a), 0), as.reduce((s, a) => s + Math.cos(a), 0));
  const neighbourAngles = (n) => n.neighborhood("node")
    .filter((m) => eles.contains(m) && ringOf.get(m.id()) !== ringOf.get(n.id()) && radii[ringOf.get(m.id())] > 0)  // a lone centre node has no direction
    .map((m) => angle.get(m.id()));

  const place = () => {
    const pos = {};
    rings.forEach((ring, i) => ring.forEach((n) => {
      const a = angle.get(n.id());
      pos[n.id()] = { x: radii[i] * Math.cos(a), y: radii[i] * Math.sin(a) };
    }));
    return pos;
  };

  // several starting orders (alphabetical + seeded shuffles); keep the arrangement with the fewest crossings
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const E = eles.edges().length;
  const restarts = E <= 30 ? 10 : E <= 80 ? 4 : E <= 200 ? 2 : 1;  // keep re-arranging under ~1 s, even on an iPad
  let bestPos = null, bestScore = Infinity;
  // attempt -1 starts from the current on-screen order, and wins ties so imports don't reshuffle the rings
  const curAngle = (n) => Math.atan2(n.position("y"), n.position("x"));
  for (let attempt = keepOrder ? -1 : 0; attempt < restarts; attempt++) {
    angle = new Map();
    rings.forEach((ring) => {
      if (attempt === -1) ring.sort((a, b) => curAngle(a) - curAngle(b));
      else ring.sort((a, b) => a.data("label").localeCompare(b.data("label")));
      if (attempt > 0) for (let k = ring.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [ring[k], ring[j]] = [ring[j], ring[k]]; }
      spread(ring, attempt > 0 ? rand() * 2 * Math.PI : 0);
    });
    const pos = optimiseRings();
    const sc = scoreLayout(eles, pos);
    const total = (sc.crossings * 3 + sc.overlaps * 5 + sc.throughNodes * 4) * (attempt === -1 ? 0.85 : 1);
    if (total < bestScore) { bestScore = total; bestPos = pos; }
  }
  return bestPos;

  function optimiseRings() {
  // barycentric sweeps: pull each node toward the angular mean of its neighbours in other rings
  const order = rings.map((_, i) => i);
  for (let sweep = 0; sweep < 8; sweep++) {
    for (const i of sweep % 2 === 0 ? order : [...order].reverse()) {
      const ring = rings[i];
      if (ring.length < 2) continue;
      const target = new Map(ring.map((n) => {
        const nb = neighbourAngles(n);
        return [n, nb.length ? circMean(nb) : angle.get(n.id())];
      }));
      const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      ring.sort((a, b) => norm(target.get(a) + Math.PI / 2) - norm(target.get(b) + Math.PI / 2));
      // rotate the evenly spaced slots so they line up with where the nodes want to be
      const offset = circMean(ring.map((n, k) => target.get(n) - (-Math.PI / 2 + stepOf(ring) * k)));
      spread(ring, offset);
    }
  }

  // transpose pass: swap angular neighbours whenever it removes crossings (skipped on very large maps)
  if (eles.edges().length <= 400) {
    const cost = () => { const sc = scoreLayout(eles, place()); return sc.crossings * 3 + sc.throughNodes * 4; };
    let best = cost();
    for (let round = 0; round < 4 && best > 0; round++) {
      let improved = false;
      for (const ring of rings) {
        for (let k = 0; k < ring.length && ring.length > 2; k++) {
          const a = ring[k], b = ring[(k + 1) % ring.length];
          const [ta, tb] = [angle.get(a.id()), angle.get(b.id())];
          angle.set(a.id(), tb); angle.set(b.id(), ta);
          const c = cost();
          if (c < best) { best = c; improved = true; [ring[k], ring[(k + 1) % ring.length]] = [b, a]; }
          else { angle.set(a.id(), ta); angle.set(b.id(), tb); }
        }
      }
      if (!improved) break;
    }
  }
  return place();
  }
}

/** Faint guide circles behind the circular view so the ring structure reads at a glance. */
function drawRingGuides(eles, pos) {
  cy.remove(".ring-guide");
  if (!pos) return;
  const radii = new Map();
  eles.nodes().forEach((n) => {
    const p = pos[n.id()];
    if (!p) return;
    const r = Math.round(Math.hypot(p.x, p.y));
    if (r > 5) radii.set(RING[n.data("type")] ?? 2, r);
  });
  cy.add([...new Set(radii.values())].map((r) => ({
    group: "nodes", classes: "ring-guide", data: { id: `ring-${r}`, size: 2 * r, kind: "guide" },
    position: { x: 0, y: 0 }, selectable: false, grabbable: false, locked: true,
  })));
}

function animateTo(eles, pos) {
  return new Promise((resolve) => {
    const l = eles.layout({ name: "preset", positions: (n) => pos[n.id()] || n.position(), animate: true,
                            animationDuration: LAYOUT_ANIM_MS, fit: true, padding: 40 });
    l.one("layoutstop", resolve);
    l.run();
  });
}

let layoutRunning = Promise.resolve();

/**
 * Re-optimize node positions.
 *  fresh:    ignore current positions (first load, "Re-arrange", layout switch)
 *  newNodes: nodes just added by an import - highlighted after the move
 */
function runLayout({ fresh = false, newNodes = null } = {}) {
  layoutRunning = layoutRunning.then(() => doLayout(fresh, newNodes)).catch((e) => console.error("layout failed", e));
  return layoutRunning;
}

async function doLayout(fresh, newNodes) {
  const name = $("#layout-select").value;
  const eles = cy.elements().filter((e) => !e.hasClass("filtered") && !e.hasClass("ring-guide"));
  if (eles.nodes().empty()) return;
  if (name !== "radial") cy.remove(".ring-guide");
  let pos;
  if (name === "fcose") {
    // Candidate 1 refines the current arrangement (keeps your mental map); candidate 2 starts from scratch.
    // Keep whichever scores better, preferring the familiar one unless the fresh one is clearly better.
    const candidates = [];
    if (!fresh) candidates.push({ pos: computePositions(eles, fcoseOptions(false)), bias: 0.9 });
    candidates.push({ pos: computePositions(eles, fcoseOptions(true)), bias: 1 });
    if (fresh) candidates.push({ pos: computePositions(eles, fcoseOptions(true)), bias: 1 });
    let best = null;
    for (const c of candidates) {
      c.score = scoreLayout(eles, c.pos);
      if (!best || c.score.total * c.bias < best.score.total * best.bias) best = c;
    }
    state.layoutScore = best.score;
    pos = best.pos;
  } else if (name === "layered") {
    pos = layeredPositions(eles);
  } else if (name === "radial") {
    pos = radialPositions(eles, !fresh);
    drawRingGuides(eles, pos);
  } else {
    pos = computePositions(eles, { name, animate: false, fit: false, avoidOverlap: true, nodeDimensionsIncludeLabels: true });
  }
  await animateTo(eles, pos);
  if (newNodes && newNodes.nonempty()) {
    newNodes.addClass("new-node");
    setTimeout(() => newNodes.removeClass("new-node"), 2500);
  }
}

// ----- selection & focus

function clearFocus() {
  cy.elements().removeClass("faded focus");
}

function focusOn(ele) {
  clearFocus();
  let hood = ele.isNode() ? ele : ele.union(ele.connectedNodes());
  if (ele.isNode()) {
    for (let i = 0; i < state.depth; i++) hood = hood.union(hood.neighborhood().filter((x) => !x.hasClass("filtered")));
  }
  cy.elements().not(hood).addClass("faded");
  hood.edges().addClass("focus");
  ele.addClass("focus");
}

function elementFor(kind, id) {
  if (kind === "relation") return cy.edges().filter((e) => (e.data("rids") || []).includes(id));
  return cy.getElementById((kind === "entity" ? "e" : "a") + id);
}

function select(kind, id, { center = false } = {}) {
  state.selected = { kind, id };
  const ele = elementFor(kind, id);
  if (ele.nonempty()) {
    focusOn(ele);
    if (center && ele.isNode()) cy.animate({ center: { eles: ele }, zoom: Math.max(cy.zoom(), 1) }, { duration: 400 });
  }
  setFocusChip();
  showTab("details");
  renderDetails();
}

function reselect() {
  const { kind, id } = state.selected;
  const ele = elementFor(kind, id);
  if (ele.empty()) { state.selected = null; clearFocus(); renderEmptyDetails(); setFocusChip(); return; }
  focusOn(ele);
  renderDetails();
}

cy.on("tap", "node", (evt) => {
  const n = evt.target;
  if (state.linkMode) return handleLinkTap(n);
  if (n.data("kind") === "article") select("article", n.data("aid"));
  else select("entity", n.data("eid"));
});
cy.on("tap", "edge", (evt) => {
  const e = evt.target;
  if (e.data("kind") === "relation") select("relation", e.data("rids")[0]);
});
cy.on("tap", (evt) => {
  if (evt.target === cy && !state.linkMode) {
    state.selected = null;
    clearFocus();
    renderEmptyDetails();
    setFocusChip();
  }
});
cy.on("mouseover", "node", (evt) => { $("#cy").style.cursor = "pointer"; evt.target.addClass("hover"); });
cy.on("mouseout", "node", () => { $("#cy").style.cursor = ""; });

// ---------------------------------------------------------------- sidebar

function renderFilters() {
  $("#type-filters").innerHTML = ENTITY_TYPES.map((t) => `
    <label class="check"><input type="checkbox" data-type="${t}" ${state.hiddenTypes.has(t) ? "" : "checked"}>
      <span class="swatch" style="background:${TYPE_STYLE[t].color}"></span>${esc(TYPE_STYLE[t].label)}</label>`).join("");
  $$("#type-filters input").forEach((cb) => cb.addEventListener("change", () => {
    cb.checked ? state.hiddenTypes.delete(cb.dataset.type) : state.hiddenTypes.add(cb.dataset.type);
    applyFilters();
  }));
  $("#rel-legend").innerHTML = Object.entries(REL_STYLE).map(([r, s]) => `
    <div class="legend-item" data-rel="${r}" title="Click to show/hide">
      <span class="legend-line" style="background:${s.color};${s.dashed ? "opacity:.6" : ""}"></span>${esc(relLabel(r))}
      <span class="muted">${s.arrow === "tee" ? "⊣" : s.arrow === "none" ? "—" : "→"}</span></div>`).join("");
  $$("#rel-legend .legend-item").forEach((el) => el.addEventListener("click", () => {
    const r = el.dataset.rel;
    state.hiddenRels.has(r) ? state.hiddenRels.delete(r) : state.hiddenRels.add(r);
    el.classList.toggle("off", state.hiddenRels.has(r));
    applyFilters();
  }));
}

function renderArticleList() {
  const arts = [...state.data.articles].sort((a, b) => b.id - a.id);
  $("#article-count").textContent = `(${arts.length})`;
  $("#article-list").innerHTML = arts.map((a) => `
    <li data-id="${a.id}">${esc(a.title || "Untitled")}<div class="meta">${a.pmid ? "PMID " + esc(a.pmid) : ""} ${esc(a.year || "")}</div></li>`).join("")
    || `<li class="muted" style="cursor:default">No articles yet</li>`;
  $$("#article-list li[data-id]").forEach((li) => li.addEventListener("click", () => select("article", Number(li.dataset.id), { center: true })));
}

$("#show-articles").addEventListener("change", (e) => { state.showArticles = e.target.checked; applyFilters(); runLayout(); });
$("#arrange-btn").addEventListener("click", () => runLayout({ fresh: true }));
$("#hide-isolated").addEventListener("change", (e) => { state.hideIsolated = e.target.checked; applyFilters(); });
$("#depth").addEventListener("input", (e) => {
  state.depth = Number(e.target.value);
  $("#depth-val").textContent = `${state.depth} hop${state.depth > 1 ? "s" : ""}`;
  if (state.selected) reselect();
});
$("#layout-select").addEventListener("change", () => runLayout({ fresh: true }));
$("#fit-btn").addEventListener("click", () => cy.animate({ fit: { eles: cy.elements().filter((e) => !e.hasClass("filtered")), padding: 40 } }, { duration: 300 }));

let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim().toLowerCase();
  searchTimer = setTimeout(() => {
    if (!q) { if (!state.selected) clearFocus(); return; }
    const hits = cy.nodes().filter((n) => (n.data("label") || "").toLowerCase().includes(q));
    clearFocus();
    if (hits.empty()) return;
    cy.elements().not(hits.union(hits.connectedEdges())).addClass("faded");
    hits.addClass("focus");
    cy.animate({ fit: { eles: hits, padding: 120 } }, { duration: 300 });
  }, 200);
});
$("#search").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = e.target.value.trim().toLowerCase();
  const hit = cy.nodes().filter((n) => (n.data("label") || "").toLowerCase().includes(q))[0];
  if (hit) hit.data("kind") === "article" ? select("article", hit.data("aid"), { center: true }) : select("entity", hit.data("eid"), { center: true });
});

// ---------------------------------------------------------------- details panel

function renderEmptyDetails() {
  $("#details").innerHTML = `<p class="muted">Click a node or link in the map to see details.</p>`;
}

function typeBadge(t) {
  return `<span class="type-badge" style="background:${TYPE_STYLE[t]?.color || "#888"}">${esc(t)}</span>`;
}

function entityLink(id, name) {
  return `<a class="node-link" data-entity="${id}">${esc(name)}</a>`;
}

function relationItem(r, perspectiveId) {
  const outgoing = r.source_id === perspectiveId;
  const other = outgoing ? entityLink(r.target_id, r.target_name) : entityLink(r.source_id, r.source_name);
  const head = outgoing ? `<span class="rel" style="color:${REL_STYLE[r.relation]?.color}">${esc(relLabel(r.relation))}</span> ${other}`
                        : `${other} <span class="rel" style="color:${REL_STYLE[r.relation]?.color}">${esc(relLabel(r.relation))}</span> this`;
  const subs = [
    r.mechanism && `<div class="sub"><b>How:</b> ${esc(r.mechanism)}</div>`,
    r.dose && `<div class="sub"><b>Dose:</b> ${esc(r.dose)}</div>`,
    r.model_system && `<div class="sub"><b>Model:</b> ${esc(r.model_system)}</div>`,
    r.article_title ? `<div class="sub"><a data-article="${r.article_id}">${esc(r.article_title.slice(0, 90))}</a>${r.confidence ? ` · ${esc(r.confidence)} confidence` : ""}</div>`
                    : r.manual ? `<div class="sub">added manually</div>` : "",
  ].filter(Boolean).join("");
  return `<li>${head}${subs}<div class="sub"><a data-relation="${r.id}">details</a></div></li>`;
}

function wireDetailLinks(root) {
  $$("[data-entity]", root).forEach((a) => a.addEventListener("click", () => select("entity", Number(a.dataset.entity), { center: true })));
  $$("[data-article]", root).forEach((a) => a.addEventListener("click", () => select("article", Number(a.dataset.article), { center: true })));
  $$("[data-relation]", root).forEach((a) => a.addEventListener("click", () => select("relation", Number(a.dataset.relation))));
}

async function renderDetails() {
  const sel = state.selected;
  if (!sel) return renderEmptyDetails();
  const box = $("#details");
  try {
    if (sel.kind === "entity") await renderEntity(box, sel.id);
    else if (sel.kind === "article") await renderArticle(box, sel.id);
    else await renderRelation(box, sel.id);
  } catch (err) {
    box.innerHTML = `<p class="msg error">${esc(err.message)}</p>`;
  }
  wireDetailLinks(box);
}

async function renderEntity(box, id) {
  const e = await api(`/api/entities/${id}`);
  const out = e.relations.filter((r) => r.source_id === id);
  const inc = e.relations.filter((r) => r.target_id === id);
  box.innerHTML = `
    <h2>${esc(e.name)}</h2>
    <div>${typeBadge(e.type)} ${e.aliases.length ? `<span class="muted">aka ${esc(e.aliases.join(", "))}</span>` : ""}</div>
    ${e.short_info ? `<p class="muted">${esc(e.short_info)}</p>` : ""}
    <div class="actions">
      <button class="primary" id="gen-desc">${e.description ? "Regenerate" : "Generate"} AI description</button>
      <button id="ask-about">Ask AI about this</button>
      <button id="edit-ent">Edit</button>
      <button id="merge-ent">Merge…</button>
      <button id="del-ent" class="danger">Delete</button>
    </div>
    <div id="desc" class="ai-box md ${e.description ? "" : "hidden"}">${md(e.description)}</div>
    <h4>Acts on (${out.length})</h4>
    <ul class="rel-list">${out.map((r) => relationItem(r, id)).join("") || `<li class="muted">—</li>`}</ul>
    <h4>Acted on by (${inc.length})</h4>
    <ul class="rel-list">${inc.map((r) => relationItem(r, id)).join("") || `<li class="muted">—</li>`}</ul>
    <h4>Articles (${e.articles.length})</h4>
    <ul class="rel-list">${e.articles.map((a) => `<li><a data-article="${a.id}">${esc(a.title)}</a>
      <div class="sub">${esc(a.journal || "")} ${esc(a.year || "")}${a.context ? " · " + esc(a.context) : ""}</div></li>`).join("") || `<li class="muted">—</li>`}</ul>`;

  $("#gen-desc").addEventListener("click", () => streamInto(`/api/describe/entity/${id}`, $("#desc"), $("#gen-desc")));
  $("#ask-about").addEventListener("click", () => askAbout({ type: "entity", id, label: e.name }, e.type));
  $("#edit-ent").addEventListener("click", async () => {
    const name = prompt("Name", e.name);
    if (name === null) return;
    const type = prompt(`Type (${ENTITY_TYPES.join(", ")})`, e.type);
    if (type === null || !ENTITY_TYPES.includes(type)) return toast("Unknown type", "error");
    try { await api(`/api/entities/${id}`, { method: "PATCH", body: { name, type } }); await loadGraph(); }
    catch (err) { toast(err.message, "error"); }
  });
  $("#merge-ent").addEventListener("click", () => openMerge(e));
  $("#del-ent").addEventListener("click", async () => {
    if (!confirm(`Delete "${e.name}" and all its links?`)) return;
    await api(`/api/entities/${id}`, { method: "DELETE" });
    state.selected = null;
    await loadGraph();
    renderEmptyDetails();
  });
}

async function renderArticle(box, id) {
  const a = await api(`/api/articles/${id}`);
  const links = [
    a.pmid && `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(a.pmid)}/" target="_blank" rel="noopener">PubMed</a>`,
    a.doi && `<a href="https://doi.org/${esc(a.doi)}" target="_blank" rel="noopener">DOI</a>`,
    a.url && !a.pmid && `<a href="${esc(a.url)}" target="_blank" rel="noopener">Source</a>`,
  ].filter(Boolean).join(" · ");
  box.innerHTML = `
    <h2>${esc(a.title)}</h2>
    <div class="muted">${esc(a.authors || "")}</div>
    <div class="muted">${esc(a.journal || "")} ${esc(a.year || "")} ${a.study_type ? "· " + esc(a.study_type) : ""} ${links ? "· " + links : ""}</div>
    <div class="actions">
      <button class="primary" id="art-sum">AI structured summary</button>
      <button id="art-ask">Ask AI about this</button>
      <button id="art-re" title="Run extraction again (replaces this article's AI links)">Re-extract</button>
      <button id="art-del" class="danger">Delete</button>
    </div>
    <div id="art-summary" class="ai-box md ${a.summary ? "" : "hidden"}">${md(a.summary)}</div>
    ${a.key_findings.length ? `<h4>Key findings</h4><ul>${a.key_findings.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>` : ""}
    <h4>Mechanisms extracted (${a.relations.length})</h4>
    <ul class="rel-list">${a.relations.map((r) => `<li>${entityLink(r.source_id, r.source_name)}
      <span class="rel" style="color:${REL_STYLE[r.relation]?.color}">${esc(relLabel(r.relation))}</span> ${entityLink(r.target_id, r.target_name)}
      ${r.mechanism ? `<div class="sub"><b>How:</b> ${esc(r.mechanism)}</div>` : ""}
      ${r.dose ? `<div class="sub"><b>Dose:</b> ${esc(r.dose)}</div>` : ""}
      ${r.model_system ? `<div class="sub"><b>Model:</b> ${esc(r.model_system)}</div>` : ""}</li>`).join("") || `<li class="muted">None yet${state.aiReady ? "" : " — enable AI to extract mechanisms"}</li>`}</ul>
    <h4>Entities (${a.entities.length})</h4>
    <div class="chips">${a.entities.map((e) => `<button class="chip" data-entity="${e.id}" style="border-color:${TYPE_STYLE[e.type]?.color}">${esc(e.name)}</button>`).join("")}</div>
    ${a.abstract ? `<h4>Abstract</h4><div class="md">${md(a.abstract)}</div>` : ""}
    <h4>Your notes</h4>
    <textarea id="art-notes" class="notes" placeholder="Notes are saved automatically">${esc(a.notes || "")}</textarea>`;

  $("#art-sum").addEventListener("click", () => streamInto(`/api/describe/article/${id}`, $("#art-summary"), $("#art-sum")));
  $("#art-ask").addEventListener("click", () => askAbout({ type: "article", id, label: a.title.slice(0, 40) }));
  $("#art-re").addEventListener("click", async (ev) => {
    const btn = ev.target;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Extracting…`;
    try {
      const r = await api(`/api/articles/${id}/reextract`, { method: "POST" });
      toast(`Re-extracted: ${r.entities} entities, ${r.relations} links`);
      await loadGraph();
    } catch (err) { toast(err.message, "error"); btn.disabled = false; btn.textContent = "Re-extract"; }
  });
  $("#art-del").addEventListener("click", async () => {
    if (!confirm("Remove this article (and links that only it supports)?")) return;
    await api(`/api/articles/${id}`, { method: "DELETE" });
    state.selected = null;
    await loadGraph();
    renderEmptyDetails();
  });
  $("#art-notes").addEventListener("change", (e) => api(`/api/articles/${id}`, { method: "PATCH", body: { notes: e.target.value } }).then(() => toast("Notes saved", "", 1500)));
}

async function renderRelation(box, id) {
  const r = state.data.relations.find((x) => x.id === id);
  if (!r) return renderEmptyDetails();
  const group = state.data.relations.filter((x) => x.source_id === r.source_id && x.target_id === r.target_id && x.relation === r.relation);
  const name = (eid) => state.data.entities.find((e) => e.id === eid)?.name || "?";
  const art = r.article_id && state.data.articles.find((a) => a.id === r.article_id);
  const evidence = (x) => {
    const art = x.article_id && state.data.articles.find((a) => a.id === x.article_id);
    return `<li><dl>
      ${x.mechanism ? `<dt class="muted">Mechanism</dt><dd>${esc(x.mechanism)}</dd>` : ""}
      ${x.dose ? `<dt class="muted">Dose</dt><dd>${esc(x.dose)}</dd>` : ""}
      ${x.model_system ? `<dt class="muted">Model system</dt><dd>${esc(x.model_system)}</dd>` : ""}
      ${x.evidence ? `<dt class="muted">Evidence</dt><dd>${esc(x.evidence)}</dd>` : ""}
      ${x.confidence ? `<dt class="muted">Confidence</dt><dd>${esc(x.confidence)}</dd>` : ""}
      <dt class="muted">Source</dt><dd>${art ? `<a data-article="${art.id}">${esc(art.title)}</a>` : x.manual ? "Added manually" : "—"}</dd>
    </dl><button class="link danger" data-del-rel="${x.id}">Delete this link</button></li>`;
  };
  box.innerHTML = `
    <h2>${entityLink(r.source_id, name(r.source_id))}
      <span style="color:${REL_STYLE[r.relation]?.color}">${esc(relLabel(r.relation))}</span>
      ${entityLink(r.target_id, name(r.target_id))}</h2>
    <p class="muted">Supported by ${group.length} source${group.length > 1 ? "s" : ""}.</p>
    <div class="actions"><button id="rel-ask">Ask AI to explain this link</button></div>
    <ul class="rel-list">${group.map(evidence).join("")}</ul>`;
  $("#rel-ask").addEventListener("click", () => {
    showTab("chat");
    sendChat(`Explain the mechanism by which ${name(r.source_id)} ${relLabel(r.relation)} ${name(r.target_id)}` +
             `${r.mechanism ? ` (recorded mechanism: ${r.mechanism})` : ""}. How strong is the evidence, and what's downstream?`);
  });
  $$("[data-del-rel]", box).forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this link?")) return;
    await api(`/api/relations/${b.dataset.delRel}`, { method: "DELETE" });
    state.selected = null;
    await loadGraph();
    renderEmptyDetails();
  }));
}

async function streamInto(url, box, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Writing…`;
  box.classList.remove("hidden");
  box.innerHTML = "";
  let text = "";
  try {
    await streamSSE(url, {}, (ev, data) => {
      if (ev === "text") { text += data; box.innerHTML = md(text); }
      else if (ev === "error") { box.innerHTML = `<p class="msg error">${esc(data)}</p>`; }
    });
    if (state.selected?.kind === "entity") {
      const ent = state.data.entities.find((e) => e.id === state.selected.id);
      if (ent) ent.has_description = 1;
    }
  } catch (err) {
    box.innerHTML = `<p class="msg error">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = label.replace(/^Generate/, "Regenerate");
  }
}

// ----- merge dialog

function openMerge(keep) {
  const dlg = $("#merge-dialog");
  $("#merge-keep").textContent = keep.name;
  $("#merge-search").value = "";
  $("#merge-results").innerHTML = "";
  dlg.showModal();
  $("#merge-search").oninput = async (ev) => {
    const q = ev.target.value.trim();
    if (!q) return ($("#merge-results").innerHTML = "");
    const hits = (await api(`/api/search?q=${encodeURIComponent(q)}`)).filter((h) => h.id !== keep.id);
    $("#merge-results").innerHTML = hits.map((h) => `<li data-id="${h.id}">${typeBadge(h.type)} ${esc(h.name)}</li>`).join("") || `<li class="muted">No matches</li>`;
    $$("#merge-results li[data-id]").forEach((li) => li.addEventListener("click", async () => {
      await api("/api/entities/merge", { method: "POST", body: { keep_id: keep.id, merge_id: Number(li.dataset.id) } });
      dlg.close();
      toast("Merged");
      await loadGraph();
    }));
  };
}

// ---------------------------------------------------------------- adding articles

async function addArticles(lines) {
  const btn = $("#add-btn");
  btn.disabled = true;
  const useAi = $("#use-ai").checked;
  let added = 0;
  const failures = [];
  for (let i = 0; i < lines.length; i++) {
    btn.innerHTML = `<span class="spinner"></span> ${lines.length > 1 ? `${i + 1}/${lines.length}` : "Adding…"}`;
    toast(useAi ? `Reading article ${i + 1}/${lines.length} and mapping mechanisms… (this can take a minute)` : `Fetching ${i + 1}/${lines.length}…`, "", 0);
    try {
      const r = await api("/api/articles", { method: "POST", body: { input: lines[i], use_ai: useAi } });
      if (r.warning) failures.push(`${lines[i]}: ${r.warning}`);
      if (!r.duplicate) added++;
      await loadGraph();
      if (i === lines.length - 1) select("article", r.article_id);
    } catch (err) {
      failures.push(`${lines[i]}: ${err.message}`);
    }
  }
  btn.disabled = false;
  btn.textContent = "Add to map";
  if (failures.length) toast(failures.join("\n"), "error", 9000);
  else toast(`Added ${added} article${added === 1 ? "" : "s"}`);
}

$("#add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const lines = $("#add-input").value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return;
  $("#add-input").value = "";
  addArticles(lines);
});
$("#add-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#add-form").requestSubmit(); }
});

$("#more-btn").addEventListener("click", () => $("#more-dialog").showModal());
$("#text-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value === "cancel") return;
  const pdf = $("#pdf-file").files[0];
  const useAi = $("#use-ai").checked;
  toast(pdf ? "Claude is reading the PDF… (this can take a minute)" : "Adding…", "", 0);
  try {
    let r;
    if (pdf) {
      const fd = new FormData();
      fd.append("file", pdf);
      fd.append("use_ai", String(useAi));
      r = await api("/api/articles/pdf", { method: "POST", body: fd });
    } else {
      r = await api("/api/articles/text", { method: "POST", body: { title: $("#text-title").value, url: $("#text-url").value, text: $("#text-body").value, use_ai: useAi } });
    }
    toast(r.warning || "Added");
    $("#pdf-file").value = ""; $("#text-title").value = ""; $("#text-url").value = ""; $("#text-body").value = "";
    await loadGraph();
    select("article", r.article_id);
  } catch (err) { toast(err.message, "error", 8000); }
});

// ---------------------------------------------------------------- manual nodes & links

$("#node-type").innerHTML = ENTITY_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("");
$("#edge-rel").innerHTML = Object.keys(REL_STYLE).map((r) => `<option value="${r}">${relLabel(r)}</option>`).join("");

$("#add-node-btn").addEventListener("click", () => { $("#node-name").value = ""; $("#node-info").value = ""; $("#node-dialog").showModal(); });
$("#node-dialog").addEventListener("close", async () => {
  if ($("#node-dialog").returnValue !== "ok" || !$("#node-name").value.trim()) return;
  const r = await api("/api/entities", { method: "POST", body: { name: $("#node-name").value, type: $("#node-type").value, short_info: $("#node-info").value || null } });
  state.hideIsolated = false; $("#hide-isolated").checked = false;
  await loadGraph();
  select("entity", r.id, { center: true });
});

$("#add-edge-btn").addEventListener("click", () => {
  state.linkMode = { source: null };
  $("#link-hint").classList.remove("hidden");
});
$("#cancel-link").addEventListener("click", (e) => { e.preventDefault(); endLinkMode(); });
function endLinkMode() {
  state.linkMode = null;
  cy.nodes().removeClass("link-source");
  $("#link-hint").classList.add("hidden");
}
function handleLinkTap(node) {
  if (node.data("kind") !== "entity") return toast("Links connect entities, not articles");
  if (!state.linkMode.source) {
    state.linkMode.source = node;
    node.addClass("link-source");
    return;
  }
  const src = state.linkMode.source;
  if (src.id() === node.id()) return;
  $("#edge-desc").textContent = `${src.data("label")} → ${node.data("label")}`;
  $("#edge-mech").value = ""; $("#edge-dose").value = "";
  const dlg = $("#edge-dialog");
  dlg.onclose = async () => {
    const ok = dlg.returnValue === "ok";
    endLinkMode();
    if (!ok) return;
    await api("/api/relations", { method: "POST", body: {
      source_id: src.data("eid"), target_id: node.data("eid"), relation: $("#edge-rel").value,
      mechanism: $("#edge-mech").value || null, dose: $("#edge-dose").value || null } });
    await loadGraph();
  };
  dlg.showModal();
}

// ---------------------------------------------------------------- export / import

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("#png-btn").addEventListener("click", () => {
  const bg = getComputedStyle(document.body).backgroundColor;
  download("research-map.png", cy.png({ full: true, scale: 2, bg, output: "blob" }));
});
$("#export-btn").addEventListener("click", async () => {
  const data = await api("/api/export");
  download(`research-map-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
});
$("#import-btn").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (!confirm("Importing replaces your current map. Continue?")) return (e.target.value = "");
  try {
    await api("/api/import", { method: "POST", body: JSON.parse(await f.text()) });
    state.selected = null;
    cy.elements().remove();
    await loadGraph({ relayout: true });
    toast("Map imported");
  } catch (err) { toast(err.message, "error"); }
  e.target.value = "";
});

// ---------------------------------------------------------------- tabs

function showTab(name) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------------------------------------------------------------- chat

function setFocusChip() {
  const sel = state.selected;
  let focus = null;
  if (sel?.kind === "entity") {
    const e = state.data?.entities.find((x) => x.id === sel.id);
    if (e) focus = { type: "entity", id: e.id, label: e.name };
  } else if (sel?.kind === "article") {
    const a = state.data?.articles.find((x) => x.id === sel.id);
    if (a) focus = { type: "article", id: a.id, label: (a.title || "").slice(0, 40) };
  }
  state.chat.focus = focus;
  renderFocusChip();
}
function renderFocusChip() {
  const chip = $("#focus-chip");
  const f = state.chat.focus;
  chip.classList.toggle("hidden", !f);
  if (!f) return;
  chip.innerHTML = `Focus: <b>${esc(f.label)}</b><button title="Remove focus">×</button>`;
  $("button", chip).addEventListener("click", () => { state.chat.focus = null; renderFocusChip(); });
}

function setMode(mode) {
  state.chat.mode = mode;
  $$("#modes .chip").forEach((c) => c.classList.toggle("active", c.dataset.mode === mode));
}
$$("#modes .chip").forEach((c) => c.addEventListener("click", () => setMode(c.dataset.mode)));

function askAbout(focus, entityType) {
  state.chat.focus = focus;
  renderFocusChip();
  if (entityType === "drug") setMode("drug");
  else if (entityType === "pathway" || entityType === "target") setMode("pathway");
  else if (entityType === "formulation") setMode("formulation");
  showTab("chat");
  $("#chat-input").focus();
  $("#chat-input").placeholder = `Ask about ${focus.label}…`;
}

$("#clear-chat").addEventListener("click", () => {
  state.chat.messages = [];
  $("#chat-log").innerHTML = `<div class="msg system">Chat cleared.</div>`;
});

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#chat-input").value.trim();
  if (text) { $("#chat-input").value = ""; sendChat(text); }
});
$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chat-form").requestSubmit(); }
});

const TOOL_LABELS = {
  search_map: "Searched your map", get_entity_details: "Looked up entity", get_article: "Read article",
  list_articles: "Listed articles", calculate: "Calculated", human_equivalent_dose: "Species dose conversion",
  body_surface_area: "Body surface area", weight_based_dose: "Weight-based dose", molar_conversion: "Molar conversion",
  dilution: "Dilution (C1V1=C2V2)", reconstitution: "Reconstitution", web_search: "Searched the web",
};

async function sendChat(text) {
  if (state.chat.busy) return toast("Wait for the current answer to finish");
  state.chat.busy = true;
  $("#chat-send").disabled = true;
  const log = $("#chat-log");
  const userEl = document.createElement("div");
  userEl.className = "msg user";
  userEl.textContent = text;
  log.appendChild(userEl);
  state.chat.messages.push({ role: "user", content: text });

  const bot = document.createElement("div");
  bot.className = "msg assistant";
  bot.innerHTML = `<details class="thinking hidden"><summary>Reasoning</summary><div></div></details><div class="steps"></div><div class="md body"><span class="spinner"></span></div>`;
  log.appendChild(bot);
  log.scrollTop = log.scrollHeight;
  const thinkingEl = $(".thinking", bot), stepsEl = $(".steps", bot), bodyEl = $(".body", bot);
  let answer = "", thinking = "";
  const tools = {};

  try {
    await streamSSE("/api/chat", {
      messages: state.chat.messages, focus: state.chat.focus, mode: state.chat.mode || null,
      web_search: $("#web-search").checked,
    }, (ev, data) => {
      if (ev === "text") {
        answer += data;
        bodyEl.innerHTML = md(answer);
      } else if (ev === "thinking") {
        thinking += data;
        thinkingEl.classList.remove("hidden");
        $("div", thinkingEl).textContent = thinking;
      } else if (ev === "tool") {
        const key = data.name + JSON.stringify(data.input || {});
        let el = tools[key];
        if (!el) {
          if (answer && !answer.endsWith("\n")) answer += "\n\n";
          el = tools[key] = document.createElement("details");
          el.className = "tool-call";
          stepsEl.appendChild(el);
        }
        const inputs = data.input && Object.keys(data.input).length ? `<pre>${esc(JSON.stringify(data.input, null, 1))}</pre>` : "";
        const output = data.output ? `<pre>${esc(prettyJSON(data.output))}</pre>` : "";
        el.innerHTML = `<summary>${data.status === "running" ? '<span class="spinner"></span> ' : data.status === "error" ? "⚠ " : "✓ "}${esc(TOOL_LABELS[data.name] || data.name)}</summary>${inputs}${output}`;
      } else if (ev === "error") {
        const err = document.createElement("div");
        err.className = "msg error";
        err.textContent = data;
        bot.appendChild(err);
      }
      log.scrollTop = log.scrollHeight;
    });
  } catch (err) {
    const el = document.createElement("div");
    el.className = "msg error";
    el.textContent = err.message;
    bot.appendChild(el);
  }
  if (!answer) bodyEl.innerHTML = "";
  if (answer) state.chat.messages.push({ role: "assistant", content: answer });
  else state.chat.messages.pop();  // keep history alternating if nothing came back
  state.chat.busy = false;
  $("#chat-send").disabled = false;
}

function prettyJSON(s) {
  try { return JSON.stringify(JSON.parse(s), null, 1); } catch { return s; }
}

// ---------------------------------------------------------------- dose calculators

const CALCS = [
  { id: "hed", title: "Species dose conversion (HED)", desc: "FDA body-surface-area (Km) scaling between species, e.g. mouse mg/kg → human mg/kg.",
    fields: [["dose_mg_per_kg", "Dose (mg/kg)"], ["from_species", "From species", "species", "mouse"], ["to_species", "To species", "species", "human"], ["body_weight_kg", "Target body weight (kg, optional)"]] },
  { id: "weight_dose", title: "Weight-based dose", desc: "mg/kg × body weight, with optional volume at a stock concentration.",
    fields: [["dose_mg_per_kg", "Dose (mg/kg)"], ["weight_kg", "Body weight (kg)"], ["doses_per_day", "Doses per day", "int", "1"], ["concentration_mg_per_ml", "Stock (mg/mL, optional)"]] },
  { id: "reconstitution", title: "Vial reconstitution", desc: "Lyophilized powder + diluent → concentration, volume and syringe units per dose.",
    fields: [["vial_mg", "Vial content (mg)"], ["diluent_ml", "Diluent added (mL)"], ["dose_mcg", "Desired dose (mcg)"], ["syringe_units_per_ml", "Syringe units/mL", "num", "100"]] },
  { id: "molar", title: "Molarity / stock solution", desc: "Leave exactly one of mass, volume or concentration blank to solve for it.",
    fields: [["mw_g_per_mol", "Molecular weight (g/mol)"], ["mass_mg", "Mass (mg)"], ["volume_ml", "Volume (mL)"], ["concentration_mM", "Concentration (mM)"]] },
  { id: "dilution", title: "Dilution C1V1 = C2V2", desc: "Leave one blank. Use the same units on both sides.",
    fields: [["c1", "C1 (stock conc.)"], ["v1", "V1 (stock volume)"], ["c2", "C2 (final conc.)"], ["v2", "V2 (final volume)"]] },
  { id: "bsa", title: "Body surface area", desc: "Mosteller and DuBois formulas.",
    fields: [["weight_kg", "Weight (kg)"], ["height_cm", "Height (cm)"]] },
  { id: "calculate", title: "Calculator", desc: "Any arithmetic: + − × ÷ ^ sqrt() log() ln() exp().",
    fields: [["expression", "Expression", "text"]] },
];

async function renderCalcs() {
  const species = Object.keys(await api("/api/species"));
  $("#calc").innerHTML = CALCS.map((c) => `
    <form class="calc-card" data-calc="${c.id}">
      <h4>${esc(c.title)}</h4><p class="desc">${esc(c.desc)}</p>
      <div class="calc-grid" ${c.id === "calculate" ? 'style="grid-template-columns:1fr"' : ""}>
        ${c.fields.map(([name, label, kind, def]) => `<label>${esc(label)}${
          kind === "species" ? `<select name="${name}">${species.map((s) => `<option ${s === def ? "selected" : ""}>${s}</option>`).join("")}</select>`
          : `<input name="${name}" ${kind === "text" ? 'type="text" placeholder="e.g. 0.25 * 70 / 2"' : 'type="number" step="any"'} value="${def ?? ""}">`}</label>`).join("")}
      </div>
      <div class="row" style="margin-top:8px"><button class="primary">Calculate</button><button type="button" class="link explain">Explain with AI</button></div>
      <dl class="calc-out"></dl>
    </form>`).join("");
  $$("#calc form").forEach((f) => {
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const params = {};
      for (const el of f.elements) {
        if (!el.name || el.value === "") continue;
        params[el.name] = el.type === "number" ? Number(el.value) : el.value;
      }
      if (params.doses_per_day) params.doses_per_day = Math.round(params.doses_per_day);
      const out = $(".calc-out", f);
      try {
        const res = await api(`/api/calc/${f.dataset.calc}`, { method: "POST", body: params });
        out.innerHTML = Object.entries(res).map(([k, v]) => `<dt>${esc(k.replace(/_/g, " "))}</dt><dd>${esc(v)}</dd>`).join("");
      } catch (err) {
        out.innerHTML = `<dd class="msg error">${esc(err.message)}</dd>`;
      }
    });
    $(".explain", f).addEventListener("click", () => {
      const vals = [...f.elements].filter((el) => el.name && el.value !== "").map((el) => `${el.name} = ${el.value}`).join(", ");
      const title = CALCS.find((c) => c.id === f.dataset.calc).title;
      setMode("dose");
      showTab("chat");
      sendChat(`Using the calculator tools, work through a "${title}" calculation with: ${vals || "(no inputs yet — tell me what you need)"}. Show the formula, each step, the result with units, and any caveats.`);
    });
  });
}

// ---------------------------------------------------------------- boot

async function boot() {
  renderFilters();
  renderCalcs();
  try {
    const s = await api("/api/status");
    state.aiReady = s.ai.configured;
    const pill = $("#ai-status");
    pill.textContent = s.ai.configured ? `AI: ${s.ai.model}` : s.ai.label || "AI: no API key";
    pill.className = "pill " + (s.ai.configured ? "ok" : "bad");
    pill.title = s.ai.configured ? "Claude is configured" : s.ai.hint || "Set ANTHROPIC_API_KEY and restart to enable AI extraction, descriptions and chat";
  } catch {}
  await loadGraph();
}
boot();
