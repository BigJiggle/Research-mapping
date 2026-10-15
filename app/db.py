"""SQLite storage for articles, entities (drugs, targets, pathways, ...) and relations."""

import json
import os
import sqlite3
import threading
from contextlib import contextmanager

DB_PATH = os.environ.get("RESEARCH_MAP_DB", os.path.join(os.path.dirname(__file__), "..", "data", "research_map.db"))

ENTITY_TYPES = ["drug", "target", "pathway", "disease", "effect", "formulation", "other"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT UNIQUE,
    pmid TEXT,
    doi TEXT,
    url TEXT,
    title TEXT,
    authors TEXT,
    journal TEXT,
    year TEXT,
    abstract TEXT,
    full_text TEXT,
    mesh TEXT,
    summary TEXT,
    key_findings TEXT,
    study_type TEXT,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    norm TEXT NOT NULL,
    type TEXT NOT NULL,
    aliases TEXT DEFAULT '[]',
    short_info TEXT,
    description TEXT,
    UNIQUE(norm, type)
);
CREATE TABLE IF NOT EXISTS article_entities (
    article_id INTEGER REFERENCES articles(id) ON DELETE CASCADE,
    entity_id INTEGER REFERENCES entities(id) ON DELETE CASCADE,
    context TEXT,
    PRIMARY KEY (article_id, entity_id)
);
CREATE TABLE IF NOT EXISTS relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER REFERENCES entities(id) ON DELETE CASCADE,
    target_id INTEGER REFERENCES entities(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    mechanism TEXT,
    dose TEXT,
    model_system TEXT,
    evidence TEXT,
    confidence TEXT,
    article_id INTEGER REFERENCES articles(id) ON DELETE CASCADE,
    manual INTEGER DEFAULT 0
);
"""

_lock = threading.Lock()


def norm(name: str) -> str:
    return " ".join(name.lower().replace("-", " ").replace("_", " ").split())


@contextmanager
def connect():
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    with _lock:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def init():
    with connect() as c:
        c.executescript(SCHEMA)


def rows(cur):
    return [dict(r) for r in cur.fetchall()]


# ---------- entities ----------

def upsert_entity(c, name: str, etype: str, short_info: str | None = None, aliases=None) -> int:
    etype = etype if etype in ENTITY_TYPES else "other"
    name = name.strip()
    n = norm(name)
    row = c.execute("SELECT id, aliases, short_info FROM entities WHERE norm=? AND type=?", (n, etype)).fetchone()
    if row is None:
        # match on alias too
        for r in c.execute("SELECT id, aliases, short_info FROM entities WHERE type=?", (etype,)):
            if n in [norm(a) for a in json.loads(r["aliases"] or "[]")]:
                row = r
                break
    if row:
        if aliases:
            existing = json.loads(row["aliases"] or "[]")
            merged = sorted(set(existing) | {a for a in aliases if a and norm(a) != n})
            c.execute("UPDATE entities SET aliases=? WHERE id=?", (json.dumps(merged), row["id"]))
        if short_info and not row["short_info"]:
            c.execute("UPDATE entities SET short_info=? WHERE id=?", (short_info, row["id"]))
        return row["id"]
    cur = c.execute(
        "INSERT INTO entities(name, norm, type, aliases, short_info) VALUES (?,?,?,?,?)",
        (name, n, etype, json.dumps(sorted(set(aliases or []))), short_info),
    )
    return cur.lastrowid


def get_entity(entity_id: int):
    with connect() as c:
        e = c.execute("SELECT * FROM entities WHERE id=?", (entity_id,)).fetchone()
        if not e:
            return None
        e = dict(e)
        e["aliases"] = json.loads(e["aliases"] or "[]")
        e["relations"] = rows(c.execute(
            """SELECT r.*, s.name AS source_name, s.type AS source_type, t.name AS target_name, t.type AS target_type,
                      a.title AS article_title, a.pmid AS article_pmid
               FROM relations r JOIN entities s ON s.id=r.source_id JOIN entities t ON t.id=r.target_id
               LEFT JOIN articles a ON a.id=r.article_id
               WHERE r.source_id=? OR r.target_id=?""", (entity_id, entity_id)))
        e["articles"] = rows(c.execute(
            """SELECT a.id, a.title, a.pmid, a.doi, a.url, a.year, a.journal, ae.context FROM article_entities ae
               JOIN articles a ON a.id=ae.article_id WHERE ae.entity_id=?""", (entity_id,)))
        return e


def update_entity(entity_id: int, **fields):
    allowed = {k: v for k, v in fields.items() if k in ("name", "type", "description", "short_info") and v is not None}
    if "name" in allowed:
        allowed["norm"] = norm(allowed["name"])
    if not allowed:
        return
    with connect() as c:
        sets = ", ".join(f"{k}=?" for k in allowed)
        c.execute(f"UPDATE entities SET {sets} WHERE id=?", (*allowed.values(), entity_id))


def delete_entity(entity_id: int):
    with connect() as c:
        c.execute("DELETE FROM entities WHERE id=?", (entity_id,))


def merge_entities(keep_id: int, merge_id: int):
    """Fold merge_id into keep_id (relations, article links, aliases)."""
    if keep_id == merge_id:
        return
    with connect() as c:
        keep = c.execute("SELECT * FROM entities WHERE id=?", (keep_id,)).fetchone()
        other = c.execute("SELECT * FROM entities WHERE id=?", (merge_id,)).fetchone()
        if not keep or not other:
            raise ValueError("entity not found")
        aliases = set(json.loads(keep["aliases"] or "[]")) | set(json.loads(other["aliases"] or "[]")) | {other["name"]}
        aliases.discard(keep["name"])
        c.execute("UPDATE entities SET aliases=?, short_info=COALESCE(short_info, ?), description=COALESCE(description, ?) WHERE id=?",
                  (json.dumps(sorted(aliases)), other["short_info"], other["description"], keep_id))
        c.execute("UPDATE relations SET source_id=? WHERE source_id=?", (keep_id, merge_id))
        c.execute("UPDATE relations SET target_id=? WHERE target_id=?", (keep_id, merge_id))
        c.execute("DELETE FROM relations WHERE source_id=target_id")
        c.execute("INSERT OR IGNORE INTO article_entities(article_id, entity_id, context) "
                  "SELECT article_id, ?, context FROM article_entities WHERE entity_id=?", (keep_id, merge_id))
        c.execute("DELETE FROM entities WHERE id=?", (merge_id,))


# ---------- articles ----------

def find_article(source_key: str):
    with connect() as c:
        r = c.execute("SELECT * FROM articles WHERE source_key=?", (source_key,)).fetchone()
        return dict(r) if r else None


def save_article(meta: dict) -> int:
    cols = ["source_key", "pmid", "doi", "url", "title", "authors", "journal", "year", "abstract", "full_text", "mesh"]
    with connect() as c:
        cur = c.execute(
            f"INSERT INTO articles({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
            tuple(json.dumps(meta.get(k)) if k == "mesh" else meta.get(k) for k in cols),
        )
        return cur.lastrowid


def get_article(article_id: int):
    with connect() as c:
        a = c.execute("SELECT * FROM articles WHERE id=?", (article_id,)).fetchone()
        if not a:
            return None
        a = dict(a)
        a["mesh"] = json.loads(a["mesh"] or "null") or []
        a["key_findings"] = json.loads(a["key_findings"] or "null") or []
        a["entities"] = rows(c.execute(
            "SELECT e.id, e.name, e.type, ae.context FROM article_entities ae JOIN entities e ON e.id=ae.entity_id WHERE ae.article_id=?",
            (article_id,)))
        a["relations"] = rows(c.execute(
            """SELECT r.*, s.name AS source_name, t.name AS target_name FROM relations r
               JOIN entities s ON s.id=r.source_id JOIN entities t ON t.id=r.target_id WHERE r.article_id=?""",
            (article_id,)))
        return a


def list_articles():
    with connect() as c:
        return rows(c.execute("SELECT id, title, pmid, doi, url, year, journal, study_type, created_at FROM articles ORDER BY id DESC"))


def update_article(article_id: int, **fields):
    allowed = {k: (json.dumps(v) if k == "key_findings" else v) for k, v in fields.items()
               if k in ("summary", "key_findings", "study_type", "notes", "title") and v is not None}
    if not allowed:
        return
    with connect() as c:
        sets = ", ".join(f"{k}=?" for k in allowed)
        c.execute(f"UPDATE articles SET {sets} WHERE id=?", (*allowed.values(), article_id))


def delete_article(article_id: int):
    with connect() as c:
        c.execute("DELETE FROM articles WHERE id=?", (article_id,))
        # drop entities no longer linked to anything
        c.execute("""DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM article_entities)
                     AND id NOT IN (SELECT source_id FROM relations) AND id NOT IN (SELECT target_id FROM relations)""")


def store_extraction(article_id: int, extraction: dict):
    """Persist AI (or fallback) extraction: entities + relations for one article."""
    with connect() as c:
        ids = {}
        for ent in extraction.get("entities", []):
            if not ent.get("name"):
                continue
            eid = upsert_entity(c, ent["name"], ent.get("type", "other"), ent.get("short_info"), ent.get("aliases"))
            ids[norm(ent["name"])] = (eid, ent.get("type"))
            c.execute("INSERT OR IGNORE INTO article_entities(article_id, entity_id, context) VALUES (?,?,?)",
                      (article_id, eid, ent.get("role_in_study")))
        for rel in extraction.get("relations", []):
            s, t = rel.get("source"), rel.get("target")
            if not s or not t:
                continue
            sid = ids.get(norm(s), (None,))[0] or upsert_entity(c, s, rel.get("source_type", "other"))
            tid = ids.get(norm(t), (None,))[0] or upsert_entity(c, t, rel.get("target_type", "other"))
            if sid == tid:
                continue
            for eid in (sid, tid):
                c.execute("INSERT OR IGNORE INTO article_entities(article_id, entity_id) VALUES (?,?)", (article_id, eid))
            c.execute(
                """INSERT INTO relations(source_id, target_id, relation, mechanism, dose, model_system, evidence, confidence, article_id)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (sid, tid, rel.get("relation", "associated_with"), rel.get("mechanism"), rel.get("dose"),
                 rel.get("model_system"), rel.get("evidence"), rel.get("confidence"), article_id),
            )


def add_manual_relation(source_id, target_id, relation, mechanism=None, dose=None):
    with connect() as c:
        cur = c.execute("INSERT INTO relations(source_id, target_id, relation, mechanism, dose, manual) VALUES (?,?,?,?,?,1)",
                        (source_id, target_id, relation, mechanism, dose))
        return cur.lastrowid


def add_manual_entity(name, etype, short_info=None):
    with connect() as c:
        return upsert_entity(c, name, etype, short_info)


def delete_relation(rel_id: int):
    with connect() as c:
        c.execute("DELETE FROM relations WHERE id=?", (rel_id,))


# ---------- graph ----------

def graph():
    with connect() as c:
        ents = rows(c.execute(
            """SELECT e.id, e.name, e.type, e.short_info, e.description IS NOT NULL AS has_description,
                      (SELECT COUNT(*) FROM article_entities ae WHERE ae.entity_id=e.id) AS article_count
               FROM entities e"""))
        rels = rows(c.execute("SELECT id, source_id, target_id, relation, mechanism, dose, model_system, evidence, confidence, article_id, manual FROM relations"))
        arts = rows(c.execute("SELECT id, title, pmid, year FROM articles"))
        links = rows(c.execute("SELECT article_id, entity_id FROM article_entities"))
    return {"entities": ents, "relations": rels, "articles": arts, "article_links": links}


def search_entities(q: str, limit=20):
    with connect() as c:
        like = f"%{norm(q)}%"
        return rows(c.execute("SELECT id, name, type, short_info FROM entities WHERE norm LIKE ? OR aliases LIKE ? LIMIT ?",
                              (like, f"%{q}%", limit)))


def entity_context_text(entity_id: int, max_chars=12000) -> str:
    """Plain-text dossier on an entity, used to ground AI answers."""
    e = get_entity(entity_id)
    if not e:
        return ""
    lines = [f"ENTITY: {e['name']} (type: {e['type']})"]
    if e["aliases"]:
        lines.append("Aliases: " + ", ".join(e["aliases"]))
    if e.get("short_info"):
        lines.append("Note: " + e["short_info"])
    if e.get("description"):
        lines.append("Saved description: " + e["description"][:2000])
    lines.append("\nRELATIONS IN THE USER'S MAP:")
    for r in e["relations"]:
        src = f" [article: {r['article_title']}{' PMID ' + r['article_pmid'] if r['article_pmid'] else ''}]" if r.get("article_title") else " [manual]"
        bits = [f"- {r['source_name']} --{r['relation']}--> {r['target_name']}"]
        for k in ("mechanism", "dose", "model_system", "evidence"):
            if r.get(k):
                bits.append(f"{k}: {r[k]}")
        lines.append("; ".join(bits) + src)
    lines.append("\nARTICLES MENTIONING IT:")
    with connect() as c:
        for a in e["articles"]:
            full = c.execute("SELECT abstract, summary FROM articles WHERE id=?", (a["id"],)).fetchone()
            lines.append(f"- {a['title']} ({a.get('journal') or ''} {a.get('year') or ''}; PMID {a.get('pmid') or 'n/a'})")
            if a.get("context"):
                lines.append(f"  role: {a['context']}")
            if full and (full["summary"] or full["abstract"]):
                lines.append("  " + (full["summary"] or full["abstract"])[:1200])
    return "\n".join(lines)[:max_chars]


def article_context_text(article_id: int, max_chars=60000) -> str:
    a = get_article(article_id)
    if not a:
        return ""
    with connect() as c:
        full = c.execute("SELECT full_text FROM articles WHERE id=?", (article_id,)).fetchone()["full_text"]
    parts = [f"TITLE: {a['title']}", f"AUTHORS: {a.get('authors') or ''}", f"JOURNAL/YEAR: {a.get('journal') or ''} {a.get('year') or ''}",
             f"PMID: {a.get('pmid') or 'n/a'}  DOI: {a.get('doi') or 'n/a'}", f"ABSTRACT: {a.get('abstract') or ''}"]
    if full:
        parts.append("FULL TEXT (may be truncated):\n" + full)
    parts.append("EXTRACTED RELATIONS: " + "; ".join(f"{r['source_name']} {r['relation']} {r['target_name']}" for r in a["relations"]))
    return "\n".join(parts)[:max_chars]


def map_overview_text(max_chars=15000) -> str:
    g = graph()
    names = {e["id"]: e["name"] for e in g["entities"]}
    lines = [f"The user's map has {len(g['articles'])} articles, {len(g['entities'])} entities, {len(g['relations'])} relations."]
    by_type = {}
    for e in g["entities"]:
        by_type.setdefault(e["type"], []).append(e["name"])
    for t, ns in by_type.items():
        lines.append(f"{t}: " + ", ".join(sorted(ns)[:80]))
    lines.append("Relations:")
    for r in g["relations"][:300]:
        lines.append(f"- {names.get(r['source_id'])} {r['relation']} {names.get(r['target_id'])}" + (f" ({r['mechanism']})" if r.get("mechanism") else ""))
    lines.append("Articles: " + "; ".join(f"{a['title']} ({a['year'] or ''})" for a in g["articles"][:60]))
    return "\n".join(lines)[:max_chars]
