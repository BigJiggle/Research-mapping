/* Research Map - browser-only backend for the iPad / offline build.
 *
 * Implements the same /api/* routes the Python server provides, entirely in the page:
 *  - storage in IndexedDB (same table shapes as the SQLite export, so maps move between versions)
 *  - article lookup straight from NCBI E-utilities / Crossref; sites that block browser access are
 *    read through Claude's web_fetch tool
 *  - Claude calls through the official Anthropic SDK (bundled), using the user's own API key
 *  - the same deterministic dose calculators
 */
"use strict";

(() => {
  // ================================================================ settings

  const LS = {
    get(k, d = "") { try { return localStorage.getItem("rm_" + k) ?? d; } catch { return d; } },
    set(k, v) { try { v ? localStorage.setItem("rm_" + k, v) : localStorage.removeItem("rm_" + k); } catch {} },
  };
  const settings = () => ({
    apiKey: LS.get("api_key"),
    model: LS.get("model", "claude-opus-5-5"),
    chatEffort: LS.get("chat_effort", "high"),
    extractEffort: LS.get("extract_effort", "medium"),
    ncbiKey: LS.get("ncbi_key"),
  });

  // ================================================================ storage (IndexedDB)

  const DB_NAME = "research-map", STORE = "kv";
  let idb = null;
  function openIdb() {
    if (idb) return idb;
    idb = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return idb;
  }
  async function idbGet(key) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbPut(key, value) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      value === undefined ? tx.objectStore(STORE).delete(key) : tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  let M = null;  // the map: {articles, entities, article_entities, relations}
  async function load() {
    if (M) return M;
    M = (await idbGet("map")) || { articles: [], entities: [], article_entities: [], relations: [] };
    return M;
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => idbPut("map", M).catch((e) => console.error("save failed", e)), 50);
  }
  const nextId = (rows) => rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const norm = (s) => String(s).toLowerCase().replace(/[-_]/g, " ").split(/\s+/).filter(Boolean).join(" ");
  const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
  const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
  const ENTITY_TYPES = ["drug", "target", "pathway", "disease", "effect", "formulation", "other"];

  // ----- entities

  function upsertEntity(name, type, shortInfo = null, aliases = null) {
    type = ENTITY_TYPES.includes(type) ? type : "other";
    name = String(name).trim();
    const n = norm(name);
    let row = M.entities.find((e) => e.norm === n && e.type === type)
      || M.entities.find((e) => e.type === type && J(e.aliases, []).some((a) => norm(a) === n));
    if (row) {
      if (aliases && aliases.length) {
        const merged = new Set([...J(row.aliases, []), ...aliases.filter((a) => a && norm(a) !== n)]);
        row.aliases = JSON.stringify([...merged].sort());
      }
      if (shortInfo && !row.short_info) row.short_info = shortInfo;
      return row.id;
    }
    row = { id: nextId(M.entities), name, norm: n, type, aliases: JSON.stringify([...new Set(aliases || [])].sort()), short_info: shortInfo || null, description: null };
    M.entities.push(row);
    return row.id;
  }

  const entityById = (id) => M.entities.find((e) => e.id === id);
  const articleById = (id) => M.articles.find((a) => a.id === id);

  function relationView(r) {
    const s = entityById(r.source_id), t = entityById(r.target_id), a = r.article_id && articleById(r.article_id);
    return { ...r, source_name: s?.name, source_type: s?.type, target_name: t?.name, target_type: t?.type,
             article_title: a ? a.title : null, article_pmid: a ? a.pmid : null };
  }

  function getEntity(id) {
    const e = entityById(id);
    if (!e) return null;
    return {
      ...e, aliases: J(e.aliases, []),
      relations: M.relations.filter((r) => r.source_id === id || r.target_id === id).map(relationView),
      articles: M.article_entities.filter((l) => l.entity_id === id).map((l) => {
        const a = articleById(l.article_id);
        return a && { id: a.id, title: a.title, pmid: a.pmid, doi: a.doi, url: a.url, year: a.year, journal: a.journal, context: l.context };
      }).filter(Boolean),
    };
  }

  function deleteOrphans() {
    const used = new Set([...M.article_entities.map((l) => l.entity_id), ...M.relations.flatMap((r) => [r.source_id, r.target_id])]);
    M.entities = M.entities.filter((e) => used.has(e.id));
  }

  function mergeEntities(keepId, mergeId) {
    if (keepId === mergeId) return;
    const keep = entityById(keepId), other = entityById(mergeId);
    if (!keep || !other) throw new Error("entity not found");
    const aliases = new Set([...J(keep.aliases, []), ...J(other.aliases, []), other.name]);
    aliases.delete(keep.name);
    keep.aliases = JSON.stringify([...aliases].sort());
    keep.short_info = keep.short_info || other.short_info;
    keep.description = keep.description || other.description;
    for (const r of M.relations) {
      if (r.source_id === mergeId) r.source_id = keepId;
      if (r.target_id === mergeId) r.target_id = keepId;
    }
    M.relations = M.relations.filter((r) => r.source_id !== r.target_id);
    for (const l of M.article_entities.filter((x) => x.entity_id === mergeId)) {
      if (!M.article_entities.some((x) => x.entity_id === keepId && x.article_id === l.article_id)) {
        M.article_entities.push({ article_id: l.article_id, entity_id: keepId, context: l.context });
      }
    }
    M.article_entities = M.article_entities.filter((x) => x.entity_id !== mergeId);
    M.entities = M.entities.filter((e) => e.id !== mergeId);
  }

  // ----- articles

  function linkArticle(articleId, entityId, context = null) {
    if (!M.article_entities.some((l) => l.article_id === articleId && l.entity_id === entityId)) {
      M.article_entities.push({ article_id: articleId, entity_id: entityId, context });
    }
  }

  function storeExtraction(articleId, x) {
    const ids = new Map();
    for (const ent of x.entities || []) {
      if (!ent.name) continue;
      const id = upsertEntity(ent.name, ent.type || "other", ent.short_info || null, ent.aliases || null);
      ids.set(norm(ent.name), id);
      linkArticle(articleId, id, ent.role_in_study || null);
    }
    for (const rel of x.relations || []) {
      if (!rel.source || !rel.target) continue;
      const sid = ids.get(norm(rel.source)) || upsertEntity(rel.source, rel.source_type || "other");
      const tid = ids.get(norm(rel.target)) || upsertEntity(rel.target, rel.target_type || "other");
      if (sid === tid) continue;
      linkArticle(articleId, sid);
      linkArticle(articleId, tid);
      M.relations.push({
        id: nextId(M.relations), source_id: sid, target_id: tid, relation: rel.relation || "associated_with",
        mechanism: rel.mechanism || null, dose: rel.dose || null, model_system: rel.model_system || null,
        evidence: rel.evidence || null, confidence: rel.confidence || null, article_id: articleId, manual: 0,
      });
    }
  }

  function saveArticle(meta) {
    const row = {
      id: nextId(M.articles), source_key: meta.source_key, pmid: meta.pmid || null, doi: meta.doi || null, url: meta.url || null,
      title: meta.title, authors: meta.authors || null, journal: meta.journal || null, year: meta.year || null,
      abstract: meta.abstract || null, full_text: meta.full_text || null, mesh: meta.mesh ? JSON.stringify(meta.mesh) : null,
      summary: null, key_findings: null, study_type: null, notes: null, created_at: now(),
    };
    M.articles.push(row);
    return row.id;
  }

  function updateArticle(id, f) {
    const a = articleById(id);
    if (!a) return;
    for (const k of ["summary", "study_type", "notes", "title"]) if (f[k] != null) a[k] = f[k];
    if (f.key_findings != null) a.key_findings = JSON.stringify(f.key_findings);
  }

  function getArticle(id) {
    const a = articleById(id);
    if (!a) return null;
    return {
      ...a, mesh: J(a.mesh, []) || [], key_findings: J(a.key_findings, []) || [],
      entities: M.article_entities.filter((l) => l.article_id === id).map((l) => {
        const e = entityById(l.entity_id);
        return e && { id: e.id, name: e.name, type: e.type, context: l.context };
      }).filter(Boolean),
      relations: M.relations.filter((r) => r.article_id === id).map(relationView),
    };
  }

  function graph() {
    const count = {};
    for (const l of M.article_entities) count[l.entity_id] = (count[l.entity_id] || 0) + 1;
    return {
      entities: M.entities.map((e) => ({ id: e.id, name: e.name, type: e.type, short_info: e.short_info,
                                         has_description: e.description ? 1 : 0, article_count: count[e.id] || 0 })),
      relations: M.relations.map((r) => ({ ...r })),
      articles: M.articles.map((a) => ({ id: a.id, title: a.title, pmid: a.pmid, year: a.year })),
      article_links: M.article_entities.map((l) => ({ article_id: l.article_id, entity_id: l.entity_id })),
    };
  }

  function searchEntities(q, limit = 20) {
    const n = norm(q);
    return M.entities.filter((e) => e.norm.includes(n) || (e.aliases || "").toLowerCase().includes(q.toLowerCase()))
      .slice(0, limit).map((e) => ({ id: e.id, name: e.name, type: e.type, short_info: e.short_info }));
  }

  // ----- context dossiers for the AI (mirror app/db.py)

  function entityContextText(id, maxChars = 12000) {
    const e = getEntity(id);
    if (!e) return "";
    const lines = [`ENTITY: ${e.name} (type: ${e.type})`];
    if (e.aliases.length) lines.push("Aliases: " + e.aliases.join(", "));
    if (e.short_info) lines.push("Note: " + e.short_info);
    if (e.description) lines.push("Saved description: " + e.description.slice(0, 2000));
    lines.push("\nRELATIONS IN THE USER'S MAP:");
    for (const r of e.relations) {
      const src = r.article_title ? ` [article: ${r.article_title}${r.article_pmid ? " PMID " + r.article_pmid : ""}]` : " [manual]";
      const bits = [`- ${r.source_name} --${r.relation}--> ${r.target_name}`];
      for (const k of ["mechanism", "dose", "model_system", "evidence"]) if (r[k]) bits.push(`${k}: ${r[k]}`);
      lines.push(bits.join("; ") + src);
    }
    lines.push("\nARTICLES MENTIONING IT:");
    for (const a of e.articles) {
      const full = articleById(a.id);
      lines.push(`- ${a.title} (${a.journal || ""} ${a.year || ""}; PMID ${a.pmid || "n/a"})`);
      if (a.context) lines.push(`  role: ${a.context}`);
      if (full && (full.summary || full.abstract)) lines.push("  " + (full.summary || full.abstract).slice(0, 1200));
    }
    return lines.join("\n").slice(0, maxChars);
  }

  function articleContextText(id, maxChars = 60000) {
    const a = getArticle(id);
    if (!a) return "";
    const parts = [`TITLE: ${a.title}`, `AUTHORS: ${a.authors || ""}`, `JOURNAL/YEAR: ${a.journal || ""} ${a.year || ""}`,
                   `PMID: ${a.pmid || "n/a"}  DOI: ${a.doi || "n/a"}`, `ABSTRACT: ${a.abstract || ""}`];
    if (a.full_text) parts.push("FULL TEXT (may be truncated):\n" + a.full_text);
    parts.push("EXTRACTED RELATIONS: " + a.relations.map((r) => `${r.source_name} ${r.relation} ${r.target_name}`).join("; "));
    return parts.join("\n").slice(0, maxChars);
  }

  function mapOverviewText(maxChars = 15000) {
    const g = graph();
    const names = Object.fromEntries(g.entities.map((e) => [e.id, e.name]));
    const lines = [`The user's map has ${g.articles.length} articles, ${g.entities.length} entities, ${g.relations.length} relations.`];
    const byType = {};
    for (const e of g.entities) (byType[e.type] = byType[e.type] || []).push(e.name);
    for (const [t, ns] of Object.entries(byType)) lines.push(`${t}: ` + ns.sort().slice(0, 80).join(", "));
    lines.push("Relations:");
    for (const r of g.relations.slice(0, 300)) lines.push(`- ${names[r.source_id]} ${r.relation} ${names[r.target_id]}` + (r.mechanism ? ` (${r.mechanism})` : ""));
    lines.push("Articles: " + g.articles.slice(0, 60).map((a) => `${a.title} (${a.year || ""})`).join("; "));
    return lines.join("\n").slice(0, maxChars);
  }

  // ================================================================ sources

  const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
  const FULL_TEXT_LIMIT = 80000;
  class SourceError extends Error {}
  class BlockedError extends SourceError {}

  async function get(url, accept) {
    let res;
    try {
      res = await fetch(url, { headers: accept ? { Accept: accept } : {} });
    } catch {
      throw new BlockedError(`Couldn't reach ${new URL(url).host} from the browser`);
    }
    if (!res.ok) throw new SourceError(`HTTP ${res.status} fetching ${new URL(url).host}`);
    return res.text();
  }
  function eutil(path, params) {
    const p = new URLSearchParams({ tool: "research-map", ...params });
    if (settings().ncbiKey) p.set("api_key", settings().ncbiKey);
    return get(`${EUTILS}/${path}?${p}`);
  }
  const xml = (text) => new DOMParser().parseFromString(text, "application/xml");
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const kids = (el, sel) => (el ? [...el.querySelectorAll(sel)] : []);

  function classify(raw) {
    const s = raw.trim();
    let m;
    if (/^(pmid:?\s*)?\d{1,9}$/i.test(s)) return ["pmid", s.replace(/\D/g, "")];
    if (/^pmc\d+$/i.test(s)) return ["pmcid", s.toUpperCase()];
    if ((m = s.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/) || s.match(/ncbi\.nlm\.nih\.gov\/pubmed\/(\d+)/))) return ["pmid", m[1]];
    if ((m = s.match(/\/pmc\/articles\/(PMC\d+)/i) || s.match(/pmc\.ncbi\.nlm\.nih\.gov\/articles\/(PMC\d+)/i))) return ["pmcid", m[1].toUpperCase()];
    if ((m = s.match(/arxiv\.org\/(?:abs|pdf)\/([\w.\-/]+?)(?:v\d+)?(?:\.pdf)?$/) || s.match(/^arxiv:\s*([\d.]+)$/i))) return ["arxiv", m[1]];
    if ((m = s.match(/(10\.\d{4,9}\/[^\s?#]+)/)) && (s.includes("doi.org") || !s.startsWith("http") || /biorxiv|medrxiv/.test(s))) {
      let doi = m[1].replace(/\.$/, "");
      if (/biorxiv|medrxiv/.test(s)) doi = doi.replace(/(v\d+)?(\.full(\.pdf)?|\.abstract)?$/, "");
      return ["doi", doi];
    }
    if (/^https?:\/\//.test(s)) return ["url", s];
    throw new SourceError("Couldn't recognise that input. Use a PMID, PMCID, DOI, or an article URL.");
  }

  function parsePubmed(text) {
    const doc = xml(text);
    const art = doc.querySelector("PubmedArticle");
    if (!art) throw new SourceError("PubMed returned no article for that ID.");
    const cit = art.querySelector("MedlineCitation"), a = cit.querySelector("Article");
    const pmid = txt(cit.querySelector(":scope > PMID"));
    const abstract = kids(a, "Abstract > AbstractText").map((p) => (p.getAttribute("Label") ? `${p.getAttribute("Label")}: ${txt(p)}` : txt(p))).join("\n");
    const authors = kids(a, "AuthorList > Author").map((au) => au.querySelector("LastName")
      ? `${txt(au.querySelector("LastName"))} ${txt(au.querySelector("Initials"))}`.trim() : txt(au.querySelector("CollectiveName"))).filter(Boolean);
    const ids = kids(art, "PubmedData ArticleIdList > ArticleId");
    const idOf = (t) => txt(ids.find((x) => x.getAttribute("IdType") === t)) || null;
    return {
      pmid, doi: idOf("doi"), pmcid: idOf("pmc"), title: txt(a.querySelector("ArticleTitle")),
      authors: authors.slice(0, 12).join(", ") + (authors.length > 12 ? " et al." : ""),
      journal: txt(a.querySelector("Journal > ISOAbbreviation")) || txt(a.querySelector("Journal > Title")),
      year: txt(a.querySelector("JournalIssue PubDate Year")) || txt(a.querySelector("JournalIssue PubDate MedlineDate")).slice(0, 4),
      abstract,
      mesh: { terms: kids(cit, "MeshHeadingList DescriptorName").map(txt), chemicals: kids(cit, "ChemicalList NameOfSubstance").map(txt),
              keywords: kids(cit, "KeywordList Keyword").map(txt) },
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    };
  }

  async function fetchPubmed(pmid) {
    const meta = parsePubmed(await eutil("efetch.fcgi", { db: "pubmed", id: pmid, retmode: "xml" }));
    if (meta.pmcid) {
      try { meta.full_text = (await fetchPmc(meta.pmcid)).full_text; } catch {}
    }
    return meta;
  }

  async function fetchPmc(pmcid) {
    const doc = xml(await eutil("efetch.fcgi", { db: "pmc", id: pmcid.replace(/^PMC/i, ""), retmode: "xml" }));
    const front = doc.querySelector("front");
    const idOf = (t) => txt(kids(front, "article-id").find((x) => x.getAttribute("pub-id-type") === t)) || null;
    const chunks = [];
    for (const el of kids(doc.querySelector("body"), "title, p")) chunks.push(el.tagName === "title" ? "\n## " + txt(el) : txt(el));
    const authors = kids(front, "contrib[contrib-type=author] name").map((n) => `${txt(n.querySelector("surname"))} ${txt(n.querySelector("given-names")).slice(0, 1)}`.trim());
    return {
      pmid: idOf("pmid"), doi: idOf("doi"), title: txt(front?.querySelector("article-title")),
      authors: authors.slice(0, 12).join(", "), journal: txt(front?.querySelector("journal-title")),
      year: txt(front?.querySelector("pub-date year")), abstract: txt(front?.querySelector("abstract")),
      full_text: chunks.join("\n").slice(0, FULL_TEXT_LIMIT) || null, url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
    };
  }

  async function pmidForDoi(doi) {
    const doc = xml(await eutil("esearch.fcgi", { db: "pubmed", term: `${doi}[doi]`, retmode: "xml" }));
    const ids = kids(doc, "IdList > Id").map(txt);
    return ids.length === 1 ? ids[0] : null;
  }

  async function fetchCrossref(doi) {
    const d = JSON.parse(await get("https://api.crossref.org/works/" + encodeURIComponent(doi))).message;
    let year = null;
    for (const k of ["published-print", "published-online", "issued", "posted"]) if (d[k]?.["date-parts"]) { year = String(d[k]["date-parts"][0][0]); break; }
    const authors = (d.author || []).map((a) => `${a.family || ""} ${(a.given || "").slice(0, 1)}`.trim());
    const tmp = document.createElement("div");
    tmp.innerHTML = DOMPurify.sanitize(d.abstract || "");
    return {
      doi, title: ((d.title || [""])[0] || "").replace(/\s+/g, " "), authors: authors.slice(0, 12).join(", ") + (authors.length > 12 ? " et al." : ""),
      journal: (d["container-title"] || [""])[0] || (d.institution?.[0]?.name ?? ""), year,
      abstract: tmp.textContent.replace(/\s+/g, " ").trim(), url: `https://doi.org/${doi}`,
    };
  }

  async function fetchArxiv(id) {
    const doc = xml(await get("https://export.arxiv.org/api/query?id_list=" + encodeURIComponent(id)));
    const entry = doc.querySelector("entry");
    if (!entry || !entry.querySelector("title")) throw new SourceError("arXiv returned no entry.");
    return {
      title: txt(entry.querySelector("title")), abstract: txt(entry.querySelector("summary")),
      authors: kids(entry, "author > name").slice(0, 12).map(txt).join(", "), journal: "arXiv",
      year: txt(entry.querySelector("published")).slice(0, 4), url: `https://arxiv.org/abs/${id}`,
    };
  }

  async function fetchUrl(url) {
    const page = new DOMParser().parseFromString(await get(url, "text/html"), "text/html");
    const meta = (k) => page.querySelector(`meta[name="${k}"], meta[property="${k}"]`)?.getAttribute("content") || null;
    if (meta("citation_pmid")) return resolve(meta("citation_pmid"));
    if (meta("citation_doi")) { try { return await resolve(meta("citation_doi").replace("doi:", "")); } catch {} }
    page.querySelectorAll("script, style, nav, footer, header, noscript").forEach((n) => n.remove());
    const body = (page.body?.textContent || "").replace(/\s+/g, " ").trim();
    return {
      title: meta("citation_title") || meta("og:title") || page.title || url,
      authors: [...page.querySelectorAll('meta[name="citation_author"]')].slice(0, 12).map((m) => m.content).join(", "),
      journal: meta("citation_journal_title") || meta("og:site_name") || new URL(url).host,
      year: (meta("citation_publication_date") || meta("citation_date") || "").slice(0, 4),
      abstract: meta("citation_abstract") || meta("description") || meta("og:description") || body.slice(0, 1500),
      full_text: body.slice(0, FULL_TEXT_LIMIT), url,
    };
  }

  async function resolve(raw) {
    const [kind, id] = classify(raw);
    let meta;
    if (kind === "pmid") meta = await fetchPubmed(id);
    else if (kind === "pmcid") {
      const pmc = await fetchPmc(id);
      meta = pmc.pmid ? { ...(await fetchPubmed(pmc.pmid)), full_text: pmc.full_text } : pmc;
    } else if (kind === "doi") {
      let pmid = null;
      try { pmid = await pmidForDoi(id); } catch {}
      meta = pmid ? await fetchPubmed(pmid) : await fetchCrossref(id);
    } else if (kind === "arxiv") {
      try { meta = await fetchArxiv(id); } catch (e) {
        if (e instanceof BlockedError) meta = await fetchViaClaude(`https://arxiv.org/abs/${id}`); else throw e;
      }
    } else {
      try { meta = await fetchUrl(id); } catch (e) {
        if (e instanceof BlockedError || e instanceof SourceError) meta = await fetchViaClaude(id); else throw e;
      }
    }
    meta.source_key = meta.pmid ? `pmid:${meta.pmid}` : meta.doi ? `doi:${meta.doi.toLowerCase()}` : `url:${meta.url || raw.trim()}`;
    return meta;
  }

  // ================================================================ dosing (mirror of app/dosing.py)

  const KM = { human: 37, human_child: 25, mouse: 3, hamster: 5, rat: 6, ferret: 7, guinea_pig: 8, rabbit: 12, dog: 20,
               monkey: 12, rhesus: 12, marmoset: 6, squirrel_monkey: 7, baboon: 20, micropig: 27, minipig: 35 };
  const rnd = (x, n) => Math.round(x * 10 ** n) / 10 ** n;
  const FUNCS = { sqrt: Math.sqrt, log: Math.log, ln: Math.log, log10: Math.log10, exp: Math.exp, round: Math.round,
                  abs: Math.abs, min: Math.min, max: Math.max, pow: Math.pow };
  const CONSTS = { pi: Math.PI, e: Math.E };

  /** Arithmetic parser (no eval): + - * / % ^ ** ( ) unary minus, functions and constants. */
  function safeCalc(expr) {
    expr = String(expr);
    if (expr.length > 300) throw new Error("expression too long");
    const toks = expr.replace(/\*\*/g, "^").match(/\d*\.?\d+(?:e[+-]?\d+)?|[a-z_][a-z0-9_]*|[-+*/%^(),]|\S/gi) || [];
    let i = 0;
    const peek = () => toks[i], take = () => toks[i++];
    const expect = (t) => { if (take() !== t) throw new Error(`expected '${t}'`); };
    function primary() {
      const t = take();
      if (t === undefined) throw new Error("unexpected end of expression");
      if (t === "(") { const v = sum(); expect(")"); return v; }
      if (t === "-") return -power();
      if (t === "+") return power();
      if (/^\d|^\./.test(t)) return parseFloat(t);
      const name = t.toLowerCase();
      if (name in FUNCS) {
        expect("(");
        const args = [];
        if (peek() !== ")") { args.push(sum()); while (peek() === ",") { take(); args.push(sum()); } }
        expect(")");
        return FUNCS[name](...args);
      }
      if (name in CONSTS) return CONSTS[name];
      throw new Error(`unsupported token '${t}'`);
    }
    function power() {
      const base = primary();
      if (peek() === "^") { take(); const e = power(); if (Math.abs(e) > 100) throw new Error("exponent too large"); return base ** e; }
      return base;
    }
    function product() {
      let v = power();
      while (["*", "/", "%"].includes(peek())) {
        const op = take(), r = power();
        if (op !== "*" && r === 0) throw new Error("division by zero");
        v = op === "*" ? v * r : op === "/" ? v / r : v % r;
      }
      return v;
    }
    function sum() {
      let v = product();
      while (["+", "-"].includes(peek())) v = take() === "+" ? v + product() : v - product();
      return v;
    }
    const v = sum();
    if (i < toks.length) throw new Error(`unexpected '${toks[i]}'`);
    if (!Number.isFinite(v)) throw new Error("result is not a finite number");
    return v;
  }

  const num = (v, name) => {
    const x = Number(v);
    if (v === undefined || v === null || v === "" || !Number.isFinite(x)) throw new Error(`${name} must be a number`);
    return x;
  };
  const opt = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

  const CALC = {
    calculate: (p) => ({ expression: p.expression, result: safeCalc(p.expression ?? "") }),
    bsa: (p) => {
      const w = num(p.weight_kg, "weight_kg"), h = num(p.height_cm, "height_cm");
      return { mosteller_m2: rnd(Math.sqrt((w * h) / 3600), 3), dubois_m2: rnd(0.007184 * w ** 0.425 * h ** 0.725, 3),
               formula_note: "Mosteller: sqrt(W*H/3600). DuBois: 0.007184*W^0.425*H^0.725" };
    },
    hed: (p) => {
      const d = num(p.dose_mg_per_kg, "dose_mg_per_kg");
      const f = String(p.from_species || "").toLowerCase().replace(/ /g, "_"), t = String(p.to_species || "human").toLowerCase().replace(/ /g, "_");
      if (!(f in KM) || !(t in KM)) throw new Error(`species must be one of ${Object.keys(KM).sort().join(", ")}`);
      const out = (d * KM[f]) / KM[t];
      const res = { input: `${d} mg/kg in ${f}`, km_from: KM[f], km_to: KM[t], equivalent_dose_mg_per_kg: rnd(out, 4),
                    formula: `${d} x (${KM[f]} / ${KM[t]})`, mg_per_m2: rnd(d * KM[f], 3) };
      const bw = opt(p.body_weight_kg);
      if (bw) { res.total_dose_mg = rnd(out * bw, 3); res.body_weight_kg = bw; }
      if (t.startsWith("human")) {
        res.mrsd_with_10x_safety_factor_mg_per_kg = rnd(out / 10, 4);
        res.caveat = "FDA BSA scaling is for estimating a starting dose from NOAEL in toxicology; it is not a therapeutic-dose predictor and ignores PK differences.";
      }
      return res;
    },
    weight_dose: (p) => {
      const total = num(p.dose_mg_per_kg, "dose_mg_per_kg") * num(p.weight_kg, "weight_kg");
      const res = { dose_per_administration_mg: rnd(total, 4), daily_total_mg: rnd(total * (opt(p.doses_per_day) || 1), 4) };
      const c = opt(p.concentration_mg_per_ml);
      if (c) res.volume_per_administration_ml = rnd(total / c, 4);
      return res;
    },
    molar: (p) => {
      const mw = num(p.mw_g_per_mol, "mw_g_per_mol");
      let mass = opt(p.mass_mg), vol = opt(p.volume_ml), conc = opt(p.concentration_mM);
      if ([mass, vol, conc].filter((x) => x === null).length !== 1) throw new Error("provide exactly two of mass_mg, volume_ml, concentration_mM");
      if (mass === null) mass = conc * (vol / 1000) * mw;
      else if (vol === null) vol = (mass / mw / conc) * 1000;
      else conc = mass / mw / (vol / 1000);
      return { mass_mg: rnd(mass, 6), volume_ml: rnd(vol, 6), concentration_mM: rnd(conc, 6), concentration_uM: rnd(conc * 1000, 4),
               concentration_mg_per_ml: rnd(mass / vol, 6), mw_g_per_mol: mw };
    },
    dilution: (p) => {
      const v = { c1: opt(p.c1), v1: opt(p.v1), c2: opt(p.c2), v2: opt(p.v2) };
      const missing = Object.keys(v).filter((k) => v[k] === null);
      if (missing.length !== 1) throw new Error("provide exactly three of c1, v1, c2, v2 (same units on each side)");
      ({ c1: () => (v.c1 = (v.c2 * v.v2) / v.v1), v1: () => (v.v1 = (v.c2 * v.v2) / v.c1),
         c2: () => (v.c2 = (v.c1 * v.v1) / v.v2), v2: () => (v.v2 = (v.c1 * v.v1) / v.c2) })[missing[0]]();
      const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rnd(x, 6)]));
      out.diluent_to_add = rnd(v.v2 - v.v1, 6);
      return out;
    },
    reconstitution: (p) => {
      const vial = num(p.vial_mg, "vial_mg"), dil = num(p.diluent_ml, "diluent_ml"), dose = num(p.dose_mcg, "dose_mcg");
      const units = opt(p.syringe_units_per_ml) || 100;
      const conc = (vial * 1000) / dil, vol = dose / conc;
      return { concentration_mg_per_ml: rnd(vial / dil, 5), concentration_mcg_per_ml: rnd(conc, 3), volume_per_dose_ml: rnd(vol, 5),
               syringe_units_per_dose: rnd(vol * units, 2), doses_per_vial: rnd((vial * 1000) / dose, 2),
               syringe_note: `Units assume a U-${units} syringe (${units} units = 1 mL).` };
    },
  };

  // ================================================================ Claude (mirror of app/ai.py)

  const FALLBACK_BETA = "server-side-fallback-2026-07-01";
  let useFallbacks = true;
  let client = null, clientKey = null;
  class AIUnavailable extends Error {}

  function claude() {
    const key = settings().apiKey;
    if (!key) throw new AIUnavailable("Add your Claude API key in Settings to use AI features.");
    if (!client || clientKey !== key) {
      // The key stays on this device; requests go straight from the browser to api.anthropic.com.
      client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
      clientKey = key;
    }
    return client;
  }

  /** Server-side refusal fallback ("default" routing) - re-runs a declined request on Anthropic's recommended model. */
  const withFallback = (body) => (useFallbacks ? { ...body, fallbacks: "default" } : body);
  const fallbackOpts = () => (useFallbacks ? { headers: { "anthropic-beta": FALLBACK_BETA } } : {});
  function disableFallbacksIf(err) {
    if (useFallbacks && err instanceof Anthropic.BadRequestError && /fallback/i.test(String(err.message))) {
      useFallbacks = false;
      return true;
    }
    return false;
  }

  function friendly(err) {
    if (err instanceof AIUnavailable || err instanceof SourceError) return err.message;
    if (err instanceof Anthropic.AuthenticationError) return "Your Claude API key was rejected. Check it in Settings.";
    if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API - wait a moment and try again.";
    if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Claude API (check your connection).";
    if (err instanceof Anthropic.APIError) return `Claude API error (${err.status}): ${err.message}`;
    return `AI error: ${err.message || err}`;
  }

  /** stream() + finalMessage(), retrying once without fallbacks if the account doesn't accept them. */
  async function runStream(body, onEvent) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const stream = claude().messages.stream(withFallback(body), fallbackOpts());
        if (onEvent) for await (const ev of stream) onEvent(ev);
        return await stream.finalMessage();
      } catch (e) {
        if (attempt === 0 && disableFallbacksIf(e)) continue;
        throw e;
      }
    }
  }

  const ENTITY_ENUM = ["drug", "target", "pathway", "disease", "effect", "formulation", "other"];
  const RELATION_ENUM = ["inhibits", "activates", "upregulates", "downregulates", "binds", "agonist_of", "antagonist_of",
    "modulates", "part_of", "treats", "causes", "increases", "decreases", "substrate_of", "metabolized_by", "associated_with"];
  const obj = (props) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
  const str = (description) => (description ? { type: "string", description } : { type: "string" });
  const EXTRACTION_SCHEMA = obj({
    title: str(), authors: str(), journal: str(), year: str(),
    abstract: str("The article abstract (verbatim if available, else a faithful summary)"),
    summary: str("3-5 sentence plain-language summary of what was done and found"),
    study_type: str("e.g. 'in vitro', 'animal', 'RCT', 'review', 'meta-analysis', 'observational'"),
    key_findings: { type: "array", items: str() },
    entities: { type: "array", items: obj({
      name: str("Canonical name, e.g. 'Rapamycin', 'mTORC1', 'PI3K/AKT/mTOR signaling'"),
      type: { type: "string", enum: ENTITY_ENUM }, aliases: { type: "array", items: str() },
      short_info: str("One short line: what it is (class, gene family, etc.)"), role_in_study: str("What this entity does in THIS article"),
    }) },
    relations: { type: "array", items: obj({
      source: str("Must exactly match an entity name"), source_type: { type: "string", enum: ENTITY_ENUM },
      target: str("Must exactly match an entity name"), target_type: { type: "string", enum: ENTITY_ENUM },
      relation: { type: "string", enum: RELATION_ENUM },
      mechanism: str("How it acts, e.g. 'allosteric inhibition via FKBP12 binding'"),
      dose: str("Dose/concentration/route/duration if reported, else empty string"),
      model_system: str("e.g. 'C57BL/6 mice', 'HEK293 cells', 'phase II RCT (n=120)'; empty if unknown"),
      evidence: str("Short quote or paraphrase of the supporting finding"),
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    }) },
  });

  const EXTRACT_SYSTEM = `You extract a mechanistic knowledge graph from biomedical research articles.

Entity types:
- drug: drugs, research compounds, peptides, supplements, biologics, investigational agents
- target: genes, proteins, receptors, enzymes, transporters, ion channels, cell types
- pathway: signaling/metabolic pathways and biological processes (e.g. "mTOR signaling", "autophagy", "NF-kB pathway")
- disease: diseases, conditions, phenotypes being studied
- effect: physiological/clinical outcomes (e.g. "body weight", "insulin sensitivity", "tumor growth")
- formulation: delivery forms / vehicles / excipients when they matter (e.g. "liposomal formulation", "subcutaneous depot")

Rules:
- Capture how each drug acts on targets and pathways: direction (inhibits/activates/up/downregulates), binding,
  agonism/antagonism, and the downstream pathway/effect chain (drug -> target -> pathway -> effect/disease).
- Use canonical, widely recognised names so the same entity merges across articles (e.g. "AMPK" not
  "AMP-activated protein kinase alpha 1 subunit activity"); put other spellings in aliases.
- Only include relations supported by the text. Record doses, routes, model systems and evidence when stated.
- Mark findings reported only as hypotheses or from background/intro as low confidence.
- Every relation's source and target must appear in the entities list with the same name.
- If bibliographic fields are unknown, use empty strings.`;

  async function extract(meta, pdfBase64 = null) {
    let text = `Title: ${meta.title || ""}\nAuthors: ${meta.authors || ""}\nJournal: ${meta.journal || ""} ${meta.year || ""}\n` +
               `PMID: ${meta.pmid || ""} DOI: ${meta.doi || ""}\n\nAbstract:\n${meta.abstract || "(none)"}\n`;
    const mesh = typeof meta.mesh === "string" ? J(meta.mesh, null) : meta.mesh;
    if (mesh) text += `\nMeSH / indexed chemicals: ${JSON.stringify(mesh)}\n`;
    if (meta.full_text) text += `\nFull text:\n${meta.full_text}\n`;
    const content = [];
    if (pdfBase64) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } });
    content.push({ type: "text", text: text + "\nExtract the knowledge graph for this article." });
    let msg;
    try {
      msg = await runStream({
        model: settings().model, max_tokens: 32000, system: EXTRACT_SYSTEM,
        output_config: { effort: settings().extractEffort, format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
        messages: [{ role: "user", content }],
      });
    } catch (e) { throw new AIUnavailable(friendly(e)); }
    if (msg.stop_reason === "refusal") throw new AIUnavailable("Claude declined to process this article.");
    if (msg.stop_reason === "max_tokens") throw new AIUnavailable("Extraction was too long and got cut off; try an article with less text.");
    const raw = msg.content.find((b) => b.type === "text")?.text || "";
    return JSON.parse(raw);
  }

  /** For sites that block browser requests (CORS): let Claude fetch the page server-side with web_fetch. */
  async function fetchViaClaude(url) {
    if (!settings().apiKey) throw new SourceError("This site can't be read directly from the browser. Add your Claude API key in Settings (Claude will fetch it), or use More… to paste the text.");
    const messages = [{ role: "user", content:
      `Fetch ${url} with the web_fetch tool and report the research article on it. Reply in plain text with these labelled lines:\n` +
      "TITLE:\nAUTHORS:\nJOURNAL:\nYEAR:\nDOI:\nPMID:\nABSTRACT: (verbatim)\nTEXT: (as much of the methods and results as you can, verbatim where possible, up to ~6000 words)\n" +
      "Write UNKNOWN for anything not on the page." }];
    let msg;
    try {
      for (let turn = 0; turn < 4; turn++) {
        msg = await runStream({ model: settings().model, max_tokens: 32000, output_config: { effort: "low" },
                                tools: [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 }], messages });
        if (msg.stop_reason !== "pause_turn") break;
        messages.push({ role: "assistant", content: msg.content });
      }
    } catch (e) { throw new SourceError(friendly(e)); }
    const out = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const fields = {};
    let cur = null;
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*\**(TITLE|AUTHORS|JOURNAL|YEAR|DOI|PMID|ABSTRACT|TEXT)\**:\s*(.*)$/);
      if (m) { cur = m[1]; fields[cur] = m[2]; } else if (cur) fields[cur] += "\n" + line;
    }
    const field = (k) => {
      const v = (fields[k] || "").trim();
      return v && !/^unknown$/i.test(v) ? v : null;
    };
    if (!field("TITLE") && !field("ABSTRACT")) throw new SourceError("Couldn't read an article from that page. Try More… to paste its text.");
    const pmid = (field("PMID") || "").match(/\d+/)?.[0] || null;
    return { title: field("TITLE") || url, authors: field("AUTHORS"), journal: field("JOURNAL"), year: (field("YEAR") || "").slice(0, 4),
             doi: field("DOI"), pmid, abstract: field("ABSTRACT"), full_text: (field("TEXT") || "").slice(0, FULL_TEXT_LIMIT), url };
  }

  function fallbackExtraction(meta) {
    const mesh = (typeof meta.mesh === "string" ? J(meta.mesh, null) : meta.mesh) || {};
    const skip = ["humans", "animals", "male", "female", "mice", "rats", "adult", "middle aged", "aged"];
    const ents = (mesh.chemicals || []).slice(0, 15).map((c) => ({ name: c, type: "drug", short_info: "PubMed indexed substance" }));
    for (const t of (mesh.terms || []).slice(0, 10)) {
      if (skip.includes(t.toLowerCase())) continue;
      ents.push({ name: t, type: /disease|neoplasm|syndrome|diabetes|obesity|cancer/i.test(t) ? "disease" : "other", short_info: "MeSH term" });
    }
    return { summary: null, key_findings: [], study_type: null, entities: ents, relations: [] };
  }

  const DESCRIBE_SYSTEM = `You write concise, accurate research briefs for a scientist's pathway-mapping tool.
Use Markdown with short headings and bullets. Ground statements in the user's map data when provided (cite PMIDs as
[PMID 123]) and clearly label anything from general knowledge as such. Be precise about mechanism and direction of
effect. Don't invent doses or citations. Keep it under ~400 words.`;

  const DESCRIBE_TEMPLATES = {
    drug: "Write a brief on this drug/compound: class & origin, primary targets and mechanism of action, pathways it acts on (and direction), key findings from the mapped articles, reported doses/routes/model systems, known PK/formulation notes, safety/limitations, and open questions.",
    target: "Write a brief on this molecular target: what it is, its role in signaling, upstream regulators and downstream effects, drugs in the map that act on it (and how), and relevance to diseases in the map.",
    pathway: "Write a brief on this pathway: core components and flow of signaling, what activates/inhibits it, outputs, drugs in the map acting on it and where they hit, and links to diseases/effects in the map.",
    default: "Write a brief on this entity: what it is, how it connects to the other entities in the map, key findings, and open questions.",
  };

  const CHAT_SYSTEM = `You are a research assistant inside "Research Map", a local tool where a scientist maps research articles,
drugs/research compounds, molecular targets and pathways.

How to answer:
- Ground answers in the user's map first (use the map tools to look up entities and articles); cite articles as
  [PMID 12345] or by title. Say clearly when you go beyond the map using general knowledge.
- Explain mechanisms concretely: drug -> target -> pathway -> downstream effect, with direction (activates/inhibits).
- Formulation questions: discuss solubility, stability, vehicles, routes, bioavailability, excipients and storage, and
  flag uncertainty.
- Dose calculations: ALWAYS use the calculator tools for arithmetic (never compute in your head). Show inputs, formula,
  and result with units. For species conversion use human_equivalent_dose (FDA BSA/Km method) and note its limits.
  Make units explicit (mg vs mcg, mL, mM).
- This is a research and education tool. For anything involving dosing a human, note that results are for research
  planning and that clinical use needs a qualified clinician. Don't refuse reasonable research questions.
- Use Markdown. Be concise and direct.`;

  const MODE_HINTS = {
    pathway: "Focus: pathway biology - components, regulation, crosstalk, and which mapped drugs act where.",
    drug: "Focus: the drug/research compound - mechanism, targets, pathways, evidence, doses used in studies, safety.",
    formulation: "Focus: formulation - solubility, vehicle/excipients, route, stability, bioavailability, reconstitution and storage.",
    dose: "Focus: dose calculation - use calculator tools for every number, show formulas and units, state assumptions.",
  };

  const schema = (props, required = Object.keys(props)) => ({ type: "object", properties: props, required });
  const n_ = (description) => (description ? { type: "number", description } : { type: "number" });
  const TOOLS = [
    { name: "search_map", description: "Search the user's research map for entities (drugs, targets, pathways, diseases, effects) by name or alias. Returns ids, names and types.", input_schema: schema({ query: str() }) },
    { name: "get_entity_details", description: "Get everything the map knows about one entity: its relations (with mechanism, dose, model system, evidence, source article) and the articles mentioning it.", input_schema: schema({ entity_id: { type: "integer" } }) },
    { name: "get_article", description: "Get an article in the map (title, abstract, full text if available, extracted relations) by its article id.", input_schema: schema({ article_id: { type: "integer" } }) },
    { name: "list_articles", description: "List all articles in the map with ids, titles, PMIDs and years.", input_schema: schema({}) },
    { name: "calculate", description: "Evaluate an arithmetic expression exactly (supports + - * / ^ ( ), sqrt, log, ln, log10, exp, round, min, max, pi). Use for ALL arithmetic.", input_schema: schema({ expression: str() }) },
    { name: "human_equivalent_dose", description: "Convert a mg/kg dose between species using FDA body-surface-area Km factors. Species: " + Object.keys(KM).sort().join(", ") + ".",
      input_schema: schema({ dose_mg_per_kg: n_(), from_species: str(), to_species: str("default human"), body_weight_kg: n_("optional, target body weight for total dose") }, ["dose_mg_per_kg", "from_species"]) },
    { name: "body_surface_area", description: "Body surface area (Mosteller and DuBois) from weight and height.", input_schema: schema({ weight_kg: n_(), height_cm: n_() }) },
    { name: "weight_based_dose", description: "mg/kg x body weight, optional daily frequency and volume at a given concentration.",
      input_schema: schema({ dose_mg_per_kg: n_(), weight_kg: n_(), doses_per_day: { type: "integer" }, concentration_mg_per_ml: n_() }, ["dose_mg_per_kg", "weight_kg"]) },
    { name: "molar_conversion", description: "Solve mass (mg) / volume (mL) / concentration (mM) for a compound of given molecular weight. Provide exactly two of the three.",
      input_schema: schema({ mw_g_per_mol: n_(), mass_mg: n_(), volume_ml: n_(), concentration_mM: n_() }, ["mw_g_per_mol"]) },
    { name: "dilution", description: "C1V1 = C2V2. Provide exactly three of c1, v1, c2, v2 (consistent units).", input_schema: schema({ c1: n_(), v1: n_(), c2: n_(), v2: n_() }, []) },
    { name: "reconstitution", description: "Lyophilized vial reconstitution: concentration, volume per dose, syringe units, doses per vial.",
      input_schema: schema({ vial_mg: n_(), diluent_ml: n_(), dose_mcg: n_(), syringe_units_per_ml: n_("default 100 (U-100)") }, ["vial_mg", "diluent_ml", "dose_mcg"]) },
  ].map((t) => ({ ...t, eager_input_streaming: true }));
  const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 5 };
  const TOOL_CALC = { human_equivalent_dose: "hed", body_surface_area: "bsa", weight_based_dose: "weight_dose",
                      molar_conversion: "molar", dilution: "dilution", reconstitution: "reconstitution" };

  function runTool(name, args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("tool input must be an object");
    if (name === "search_map") return JSON.stringify(searchEntities(String(args.query ?? "")));
    if (name === "get_entity_details") return entityContextText(Number(args.entity_id)) || "No such entity.";
    if (name === "get_article") return articleContextText(Number(args.article_id), 40000) || "No such article.";
    if (name === "list_articles") return JSON.stringify(M.articles.map((a) => ({ id: a.id, title: a.title, pmid: a.pmid, year: a.year })));
    if (name === "calculate") return JSON.stringify(CALC.calculate(args));
    if (TOOL_CALC[name]) return JSON.stringify(CALC[TOOL_CALC[name]](name === "human_equivalent_dose" ? { to_species: "human", ...args } : args));
    throw new Error(`unknown tool ${name}`);
  }

  function contextBlock(focus, mode) {
    const parts = ["<map_overview>\n" + mapOverviewText() + "\n</map_overview>"];
    if (focus?.type === "entity") parts.push("<focused_entity>\n" + entityContextText(Number(focus.id)) + "\n</focused_entity>");
    else if (focus?.type === "article") parts.push("<focused_article>\n" + articleContextText(Number(focus.id), 40000) + "\n</focused_article>");
    if (MODE_HINTS[mode]) parts.push(MODE_HINTS[mode]);
    return parts.join("\n\n");
  }

  async function chat({ messages: history, focus, mode, web_search }, emit) {
    claude();
    const system = [
      { type: "text", text: CHAT_SYSTEM, cache_control: { type: "ephemeral" } },
      { type: "text", text: contextBlock(focus, mode) },
    ];
    const messages = history.filter((m) => ["user", "assistant"].includes(m.role) && m.content).map((m) => ({ role: m.role, content: m.content }));
    const tools = web_search ? [...TOOLS, WEB_SEARCH_TOOL] : TOOLS;
    let jsonRetries = 0;
    for (let turn = 0; turn < 12; turn++) {
      let response;
      try {
        response = await runStream({
          model: settings().model, max_tokens: 64000, system, tools, messages,
          thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: settings().chatEffort },
        }, (ev) => {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") emit("text", ev.delta.text);
          else if (ev.type === "content_block_delta" && ev.delta.type === "thinking_delta") emit("thinking", ev.delta.thinking);
          else if (ev.type === "content_block_start" && ev.content_block.type === "server_tool_use") emit("tool", { name: ev.content_block.name, status: "running" });
        });
      } catch (e) {
        if (e instanceof Anthropic.APIError || e instanceof AIUnavailable) { emit("error", friendly(e)); return; }
        if (e instanceof SyntaxError && jsonRetries++ < 2) continue;  // unparseable streamed tool JSON: re-issue the turn
        emit("error", friendly(e));
        return;
      }
      jsonRetries = 0;
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason === "refusal") { emit("text", "\n\n*Claude declined to answer this request.*"); break; }
      const toolUses = response.content.filter((b) => b.type === "tool_use");
      if (!toolUses.length) break;
      if (response.stop_reason === "max_tokens") { emit("error", "Response was cut off (max tokens)."); break; }
      const results = [];
      for (const b of toolUses) {
        emit("tool", { name: b.name, input: b.input, status: "running" });
        try {
          const out = runTool(b.name, b.input);
          results.push({ type: "tool_result", tool_use_id: b.id, content: out });
          emit("tool", { name: b.name, input: b.input, output: out.slice(0, 2000), status: "done" });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: `Error: ${e.message}` });
          emit("tool", { name: b.name, input: b.input, output: `Error: ${e.message}`, status: "error" });
        }
      }
      messages.push({ role: "user", content: results });
    }
    emit("done", null);
  }

  async function streamDescription(prompt, emit, saveFn) {
    let text = "";
    try {
      const msg = await runStream({ model: settings().model, max_tokens: 16000, system: DESCRIBE_SYSTEM,
                                    output_config: { effort: "medium" }, messages: [{ role: "user", content: prompt }] },
        (ev) => { if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") { text += ev.delta.text; emit("text", ev.delta.text); } });
      if (msg.stop_reason === "refusal") emit("text", "\n\n*Claude declined to answer this request.*");
      saveFn(text);
      save();
      emit("done", null);
    } catch (e) { emit("error", friendly(e)); }
  }

  // ================================================================ ingestion

  async function pdfStore(id, b64) { await idbPut("pdf:" + id, b64); }
  const pdfLoad = (id) => idbGet("pdf:" + id);

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16);
  }

  async function ingest(meta, useAi, pdfB64 = null) {
    let warning = null, x = null;
    if (useAi) {
      try { x = await extract(meta, pdfB64); } catch (e) { warning = `AI extraction skipped: ${e.message}`; }
    }
    if (x) for (const k of ["title", "authors", "journal", "year", "abstract"]) if (!meta[k] && x[k]) meta[k] = x[k];
    meta.title = meta.title || "Untitled article";
    if (pdfB64 && !meta.source_key) meta.source_key = `pdf:${meta.title.slice(0, 200)}`;
    const existing = M.articles.find((a) => a.source_key === meta.source_key);
    if (existing) return { article_id: existing.id, duplicate: true, warning: "Already in your map." };
    const id = saveArticle(meta);
    if (pdfB64) await pdfStore(id, pdfB64);
    x = x || fallbackExtraction(meta);
    storeExtraction(id, x);
    updateArticle(id, { summary: x.summary, key_findings: x.key_findings, study_type: x.study_type });
    save();
    return { article_id: id, warning, entities: (x.entities || []).length, relations: (x.relations || []).length };
  }

  const fileToBase64 = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });

  // ================================================================ router

  const fail = (msg) => { throw new Error(msg); };

  async function apiRoute(path, opts = {}) {
    await load();
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body;
    const url = new URL(path, "http://local");
    const p = url.pathname;
    let m;

    if (p === "/api/status") return { ai: { configured: !!settings().apiKey, model: settings().model,
                                            label: "AI: add API key", hint: "Tap to add your Claude API key" } };
    if (p === "/api/graph") return graph();
    if (p === "/api/species") return { ...KM };
    if (p === "/api/search") return searchEntities(url.searchParams.get("q") || "");

    if (p === "/api/articles" && method === "POST") {
      try { classify(body.input); } catch (e) { fail(e.message); }
      let meta;
      try { meta = await resolve(body.input); } catch (e) { fail(e.message); }
      const dup = M.articles.find((a) => a.source_key === meta.source_key);
      if (dup) return { article_id: dup.id, duplicate: true, warning: "Already in your map." };
      return ingest(meta, body.use_ai !== false);
    }
    if (p === "/api/articles" && method === "GET") return M.articles.map(({ id, title, pmid, doi, url, year, journal, study_type, created_at }) => ({ id, title, pmid, doi, url, year, journal, study_type, created_at }));
    if (p === "/api/articles/text" && method === "POST") {
      if ((body.text || "").trim().length < 50) fail("Paste at least an abstract's worth of text.");
      const meta = { title: (body.title || "").trim(), abstract: body.text.slice(0, 3000), full_text: body.text.slice(0, FULL_TEXT_LIMIT), url: body.url || null };
      meta.source_key = body.url ? `url:${body.url}` : `text:${hashStr(body.text)}`;
      return ingest(meta, body.use_ai !== false);
    }
    if (p === "/api/articles/pdf" && method === "POST") {
      const file = body.get("file");
      if (!file) fail("Choose a PDF.");
      if (file.size > 30 * 1024 * 1024) fail("PDF too large (30 MB max).");
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (String.fromCharCode(...head) !== "%PDF") fail("That file isn't a PDF.");
      if (!settings().apiKey) fail("PDF import needs AI (Claude reads the PDF). Add your API key in Settings.");
      return ingest({ title: "", url: null }, true, await fileToBase64(file));
    }
    if ((m = p.match(/^\/api\/articles\/(\d+)\/reextract$/))) {
      const id = Number(m[1]), a = articleById(id);
      if (!a) fail("Not found");
      let x;
      try { x = await extract(a, await pdfLoad(id)); } catch (e) { fail(e.message); }
      M.relations = M.relations.filter((r) => !(r.article_id === id && !r.manual));
      M.article_entities = M.article_entities.filter((l) => l.article_id !== id);
      storeExtraction(id, x);
      updateArticle(id, { summary: x.summary, key_findings: x.key_findings, study_type: x.study_type });
      deleteOrphans();
      save();
      return { ok: true, entities: x.entities.length, relations: x.relations.length };
    }
    if ((m = p.match(/^\/api\/articles\/(\d+)$/))) {
      const id = Number(m[1]);
      if (method === "GET") {
        const a = getArticle(id) || fail("Not found");
        delete a.full_text;
        a.has_pdf = !!(await pdfLoad(id));
        return a;
      }
      if (method === "PATCH") { updateArticle(id, body || {}); save(); return { ok: true }; }
      if (method === "DELETE") {
        M.relations = M.relations.filter((r) => r.article_id !== id);
        M.article_entities = M.article_entities.filter((l) => l.article_id !== id);
        M.articles = M.articles.filter((a) => a.id !== id);
        deleteOrphans();
        await idbPut("pdf:" + id, undefined);
        save();
        return { ok: true };
      }
    }

    if (p === "/api/entities" && method === "POST") { const id = upsertEntity(body.name, body.type, body.short_info); save(); return { id }; }
    if (p === "/api/entities/merge" && method === "POST") { mergeEntities(body.keep_id, body.merge_id); save(); return { ok: true }; }
    if ((m = p.match(/^\/api\/entities\/(\d+)$/))) {
      const id = Number(m[1]);
      if (method === "GET") return getEntity(id) || fail("Not found");
      if (method === "PATCH") {
        const e = entityById(id) || fail("Not found");
        for (const k of ["name", "type", "description", "short_info"]) if (body[k] != null) e[k] = body[k];
        if (body.name != null) e.norm = norm(body.name);
        save();
        return { ok: true };
      }
      if (method === "DELETE") {
        M.entities = M.entities.filter((e) => e.id !== id);
        M.relations = M.relations.filter((r) => r.source_id !== id && r.target_id !== id);
        M.article_entities = M.article_entities.filter((l) => l.entity_id !== id);
        save();
        return { ok: true };
      }
    }

    if (p === "/api/relations" && method === "POST") {
      const id = nextId(M.relations);
      M.relations.push({ id, source_id: body.source_id, target_id: body.target_id, relation: body.relation, mechanism: body.mechanism || null,
                         dose: body.dose || null, model_system: null, evidence: null, confidence: null, article_id: null, manual: 1 });
      save();
      return { id };
    }
    if ((m = p.match(/^\/api\/relations\/(\d+)$/)) && method === "DELETE") {
      M.relations = M.relations.filter((r) => r.id !== Number(m[1]));
      save();
      return { ok: true };
    }

    if ((m = p.match(/^\/api\/calc\/(\w+)$/))) {
      const fn = CALC[m[1]] || fail("Unknown calculator");
      const clean = Object.fromEntries(Object.entries(body || {}).filter(([, v]) => v !== null && v !== ""));
      return m[1] === "calculate" ? { result: safeCalc(clean.expression ?? "") } : fn(clean);
    }

    if (p === "/api/export") return JSON.parse(JSON.stringify(M));
    if (p === "/api/import" && method === "POST") {
      const tables = ["articles", "entities", "article_entities", "relations"];
      if (!tables.every((t) => Array.isArray(body?.[t]))) fail("Not a Research Map export file.");
      M = Object.fromEntries(tables.map((t) => [t, body[t]]));
      save();
      return { ok: true };
    }
    fail(`Unknown route ${method} ${p}`);
  }

  async function streamRoute(path, body, onEvent) {
    await load();
    let m;
    if ((m = path.match(/^\/api\/describe\/entity\/(\d+)$/))) {
      const id = Number(m[1]), e = entityById(id) || fail("Not found");
      try { claude(); } catch (err) { return onEvent("error", err.message); }
      const tmpl = DESCRIBE_TEMPLATES[e.type] || DESCRIBE_TEMPLATES.default;
      return streamDescription(`${tmpl}\n\n<map_data>\n${entityContextText(id)}\n</map_data>`, onEvent, (t) => { e.description = t; });
    }
    if ((m = path.match(/^\/api\/describe\/article\/(\d+)$/))) {
      const id = Number(m[1]);
      articleById(id) || fail("Not found");
      try { claude(); } catch (err) { return onEvent("error", err.message); }
      const prompt = "Write a structured summary of this article: Objective, Methods (model system, doses, routes), Key results " +
        "(with numbers), Mechanism (drug -> target -> pathway -> effect), Limitations, and Relevance.\n\n<article>\n" + articleContextText(id) + "\n</article>";
      return streamDescription(prompt, onEvent, (t) => updateArticle(id, { summary: t }));
    }
    if (path === "/api/chat") {
      const hist = (body.messages || []).filter((x) => ["user", "assistant"].includes(x.role) && typeof x.content === "string");
      if (!hist.length || hist[hist.length - 1].role !== "user") fail("Last message must be from the user.");
      try { return await chat({ ...body, messages: hist }, onEvent); } catch (e) { return onEvent("error", friendly(e)); }
    }
    fail(`Unknown stream ${path}`);
  }

  // ================================================================ settings UI (iPad build only)

  function settingsUi() {
    const bar = document.querySelector(".topbar");
    const pill = document.getElementById("ai-status");
    const btn = document.createElement("button");
    btn.id = "settings-btn";
    btn.textContent = "Settings";
    bar.appendChild(btn);
    const filters = document.createElement("button");
    filters.id = "filters-btn";
    filters.textContent = "☰ Filters";
    bar.insertBefore(filters, bar.firstChild);
    filters.addEventListener("click", () => document.body.classList.toggle("sidebar-open"));
    document.querySelector(".canvas-wrap").addEventListener("pointerdown", () => document.body.classList.remove("sidebar-open"));

    const dlg = document.createElement("dialog");
    dlg.id = "settings-dialog";
    dlg.innerHTML = `
      <form method="dialog" class="dialog-body">
        <h3>Settings</h3>
        <label>Claude API key<input id="set-key" type="password" autocomplete="off" placeholder="sk-ant-..."></label>
        <p class="muted small-note">Stored only on this iPad, in this browser. Requests go directly from here to api.anthropic.com. Get a key at console.anthropic.com.</p>
        <label>Model<select id="set-model">
          <option value="claude-opus-5-5">Claude Opus 5.5 (default)</option>
          <option value="claude-sonnet-5-5">Claude Sonnet 5.5</option>
          <option value="claude-haiku-5-5">Claude Haiku 5.5</option>
          <option value="claude-fable-5-1">Claude Fable 5.1</option>
        </select></label>
        <div class="row">
          <label style="flex:1">Chat effort<select id="set-chat-effort"><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option></select></label>
          <label style="flex:1">Extraction effort<select id="set-extract-effort"><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option></select></label>
        </div>
        <label>NCBI API key (optional)<input id="set-ncbi" autocomplete="off" placeholder="raises PubMed rate limits"></label>
        <p id="set-test-out" class="muted small-note"></p>
        <div class="row end">
          <button type="button" id="set-test">Test key</button>
          <button value="cancel">Cancel</button>
          <button class="primary" value="save">Save</button>
        </div>
        <hr>
        <p class="muted small-note">Your map is saved in this browser on this device. Use Export to back it up or move it to the desktop app (Import accepts files from either version).</p>
      </form>`;
    document.body.appendChild(dlg);
    const open = () => {
      const s = settings();
      dlg.querySelector("#set-key").value = s.apiKey;
      dlg.querySelector("#set-model").value = s.model;
      dlg.querySelector("#set-chat-effort").value = s.chatEffort;
      dlg.querySelector("#set-extract-effort").value = s.extractEffort;
      dlg.querySelector("#set-ncbi").value = s.ncbiKey;
      dlg.querySelector("#set-test-out").textContent = "";
      dlg.showModal();
    };
    btn.addEventListener("click", open);
    pill.style.cursor = "pointer";
    pill.addEventListener("click", open);
    dlg.querySelector("#set-test").addEventListener("click", async () => {
      const out = dlg.querySelector("#set-test-out");
      out.textContent = "Testing…";
      try {
        const c = new Anthropic({ apiKey: dlg.querySelector("#set-key").value.trim(), dangerouslyAllowBrowser: true });
        await c.models.retrieve(dlg.querySelector("#set-model").value);
        out.textContent = "✓ Key works and the model is available.";
      } catch (e) { out.textContent = "✗ " + friendly(e); }
    });
    dlg.addEventListener("close", () => {
      if (dlg.returnValue !== "save") return;
      LS.set("api_key", dlg.querySelector("#set-key").value.trim());
      LS.set("model", dlg.querySelector("#set-model").value);
      LS.set("chat_effort", dlg.querySelector("#set-chat-effort").value);
      LS.set("extract_effort", dlg.querySelector("#set-extract-effort").value);
      LS.set("ncbi_key", dlg.querySelector("#set-ncbi").value.trim());
      const s = settings();
      pill.textContent = s.apiKey ? `AI: ${s.model}` : "AI: add API key";
      pill.className = "pill " + (s.apiKey ? "ok" : "bad");
    });
    if (!settings().apiKey) {
      pill.textContent = "AI: add API key";
      pill.title = "Tap to add your Claude API key";
    }
  }

  // ask the browser not to evict the map under storage pressure
  try { navigator.storage?.persist?.(); } catch {}

  window.LocalBackend = {
    api: apiRoute,
    stream: streamRoute,
    _internals: { classify, parsePubmed, safeCalc, CALC, upsertEntity, storeExtraction, load, EXTRACTION_SCHEMA },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", settingsUi);
  else settingsUi();
})();
