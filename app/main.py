"""Research Map - local web app. Run with:  python run.py   (then open http://127.0.0.1:8000)"""

import json
import os

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ai, db, dosing, sources

STATIC = os.path.join(os.path.dirname(__file__), "static")
PDF_DIR = os.path.join(os.path.dirname(os.path.abspath(db.DB_PATH)), "pdfs")

app = FastAPI(title="Research Map")
db.init()


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/api/status")
def status():
    return {"ai": ai.status()}


@app.get("/api/graph")
def graph():
    return db.graph()


# ------------------------------------------------------------------ articles

class ArticleIn(BaseModel):
    input: str
    use_ai: bool = True


class TextArticleIn(BaseModel):
    title: str = ""
    text: str
    url: str = ""
    use_ai: bool = True


def _ingest(meta: dict, use_ai: bool, pdf_bytes: bytes | None = None) -> dict:
    warning = None
    extraction = None
    if use_ai:
        try:
            extraction = ai.extract(meta, pdf_bytes)
        except ai.AIUnavailable as e:
            warning = f"AI extraction skipped: {e}"
    if extraction:
        for k in ("title", "authors", "journal", "year", "abstract"):
            if not meta.get(k) and extraction.get(k):
                meta[k] = extraction[k]
    meta["title"] = meta.get("title") or "Untitled article"
    if pdf_bytes and not meta.get("source_key"):
        meta["source_key"] = f"pdf:{meta['title'][:200]}"
    existing = db.find_article(meta["source_key"])
    if existing:
        return {"article_id": existing["id"], "duplicate": True, "warning": "Already in your map."}
    article_id = db.save_article(meta)
    if pdf_bytes:
        os.makedirs(PDF_DIR, exist_ok=True)
        with open(os.path.join(PDF_DIR, f"{article_id}.pdf"), "wb") as f:
            f.write(pdf_bytes)
    if not extraction:
        extraction = ai.fallback_extraction(meta)
    db.store_extraction(article_id, extraction)
    db.update_article(article_id, summary=extraction.get("summary"), key_findings=extraction.get("key_findings"),
                      study_type=extraction.get("study_type"))
    return {"article_id": article_id, "warning": warning,
            "entities": len(extraction.get("entities", [])), "relations": len(extraction.get("relations", []))}


@app.post("/api/articles")
def add_article(body: ArticleIn):
    try:
        kind, _ = sources.classify(body.input)
    except sources.SourceError as e:
        raise HTTPException(400, str(e))
    try:
        meta = sources.resolve(body.input)
    except sources.SourceError as e:
        raise HTTPException(502, str(e))
    if db.find_article(meta["source_key"]):
        return {"article_id": db.find_article(meta["source_key"])["id"], "duplicate": True, "warning": "Already in your map."}
    return _ingest(meta, body.use_ai)


@app.post("/api/articles/text")
def add_text_article(body: TextArticleIn):
    if len(body.text.strip()) < 50:
        raise HTTPException(400, "Paste at least an abstract's worth of text.")
    meta = {"title": body.title.strip(), "abstract": body.text[:3000], "full_text": body.text[:sources.FULL_TEXT_LIMIT],
            "url": body.url or None}
    meta["source_key"] = f"url:{body.url}" if body.url else f"text:{hash(body.text) & 0xffffffff:x}"
    return _ingest(meta, body.use_ai)


@app.post("/api/articles/pdf")
async def add_pdf_article(file: UploadFile = File(...), use_ai: bool = Form(True)):
    data = await file.read()
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "That file isn't a PDF.")
    if len(data) > 30 * 1024 * 1024:
        raise HTTPException(400, "PDF too large (30 MB max).")
    if not use_ai:
        raise HTTPException(400, "PDF import needs AI enabled (Claude reads the PDF).")
    meta = {"title": "", "url": None}
    return _ingest(meta, True, pdf_bytes=data)


@app.get("/api/articles")
def articles():
    return db.list_articles()


@app.get("/api/articles/{article_id}")
def article(article_id: int):
    a = db.get_article(article_id)
    if not a:
        raise HTTPException(404, "Not found")
    a.pop("full_text", None)
    a["has_pdf"] = os.path.exists(os.path.join(PDF_DIR, f"{article_id}.pdf"))
    return a


class ArticlePatch(BaseModel):
    notes: str | None = None
    title: str | None = None
    summary: str | None = None


@app.patch("/api/articles/{article_id}")
def patch_article(article_id: int, body: ArticlePatch):
    db.update_article(article_id, **body.model_dump())
    return {"ok": True}


@app.delete("/api/articles/{article_id}")
def remove_article(article_id: int):
    db.delete_article(article_id)
    pdf = os.path.join(PDF_DIR, f"{article_id}.pdf")
    if os.path.exists(pdf):
        os.remove(pdf)
    return {"ok": True}


@app.post("/api/articles/{article_id}/reextract")
def reextract(article_id: int):
    with db.connect() as c:
        row = c.execute("SELECT * FROM articles WHERE id=?", (article_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        meta = dict(row)
        meta["mesh"] = json.loads(meta["mesh"] or "null")
    pdf_path = os.path.join(PDF_DIR, f"{article_id}.pdf")
    pdf = open(pdf_path, "rb").read() if os.path.exists(pdf_path) else None
    try:
        extraction = ai.extract(meta, pdf)
    except ai.AIUnavailable as e:
        raise HTTPException(503, str(e))
    with db.connect() as c:
        c.execute("DELETE FROM relations WHERE article_id=? AND manual=0", (article_id,))
        c.execute("DELETE FROM article_entities WHERE article_id=?", (article_id,))
    db.store_extraction(article_id, extraction)
    db.update_article(article_id, summary=extraction["summary"], key_findings=extraction["key_findings"], study_type=extraction["study_type"])
    with db.connect() as c:  # drop orphans left behind by the old extraction
        c.execute("""DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM article_entities)
                     AND id NOT IN (SELECT source_id FROM relations) AND id NOT IN (SELECT target_id FROM relations)""")
    return {"ok": True, "entities": len(extraction["entities"]), "relations": len(extraction["relations"])}


# ------------------------------------------------------------------ entities & relations

class EntityIn(BaseModel):
    name: str
    type: str
    short_info: str | None = None


class EntityPatch(BaseModel):
    name: str | None = None
    type: str | None = None
    short_info: str | None = None
    description: str | None = None


class MergeIn(BaseModel):
    keep_id: int
    merge_id: int


class RelationIn(BaseModel):
    source_id: int
    target_id: int
    relation: str
    mechanism: str | None = None
    dose: str | None = None


@app.get("/api/entities/{entity_id}")
def entity(entity_id: int):
    e = db.get_entity(entity_id)
    if not e:
        raise HTTPException(404, "Not found")
    return e


@app.post("/api/entities")
def create_entity(body: EntityIn):
    return {"id": db.add_manual_entity(body.name, body.type, body.short_info)}


@app.patch("/api/entities/{entity_id}")
def patch_entity(entity_id: int, body: EntityPatch):
    db.update_entity(entity_id, **body.model_dump())
    return {"ok": True}


@app.delete("/api/entities/{entity_id}")
def remove_entity(entity_id: int):
    db.delete_entity(entity_id)
    return {"ok": True}


@app.post("/api/entities/merge")
def merge(body: MergeIn):
    try:
        db.merge_entities(body.keep_id, body.merge_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.get("/api/search")
def search(q: str):
    return db.search_entities(q)


@app.post("/api/relations")
def create_relation(body: RelationIn):
    return {"id": db.add_manual_relation(body.source_id, body.target_id, body.relation, body.mechanism, body.dose)}


@app.delete("/api/relations/{rel_id}")
def remove_relation(rel_id: int):
    db.delete_relation(rel_id)
    return {"ok": True}


# ------------------------------------------------------------------ AI streaming

def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _stream_and_save(prompt: str, save):
    def gen():
        chunks = []
        try:
            for t in ai.stream_text(ai.DESCRIBE_SYSTEM, prompt):
                chunks.append(t)
                yield _sse("text", t)
            save("".join(chunks))
            yield _sse("done", None)
        except Exception as e:  # noqa: BLE001 - surface any failure to the UI
            yield _sse("error", ai._friendly(e))
    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/describe/entity/{entity_id}")
def describe_entity(entity_id: int):
    if not db.get_entity(entity_id):
        raise HTTPException(404, "Not found")
    return _stream_and_save(ai.describe_entity_prompt(entity_id), lambda text: db.update_entity(entity_id, description=text))


@app.post("/api/describe/article/{article_id}")
def describe_article(article_id: int):
    if not db.get_article(article_id):
        raise HTTPException(404, "Not found")
    return _stream_and_save(ai.summarize_article_prompt(article_id), lambda text: db.update_article(article_id, summary=text))


class ChatIn(BaseModel):
    messages: list[dict]
    focus: dict | None = None
    mode: str | None = None
    web_search: bool = False


@app.post("/api/chat")
def chat(body: ChatIn):
    history = [m for m in body.messages if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)]
    if not history or history[-1]["role"] != "user":
        raise HTTPException(400, "Last message must be from the user.")

    def gen():
        try:
            for event, data in ai.chat_events(history, body.focus, body.mode, body.web_search):
                yield _sse(event, data)
        except Exception as e:  # noqa: BLE001
            yield _sse("error", ai._friendly(e))
    return StreamingResponse(gen(), media_type="text/event-stream")


# ------------------------------------------------------------------ calculators

@app.post("/api/calc/{name}")
def calc(name: str, params: dict):
    fn = dosing.CALCULATORS.get(name)
    if not fn:
        raise HTTPException(404, "Unknown calculator")
    try:
        clean = {k: v for k, v in params.items() if v not in (None, "")}
        result = fn(**clean) if name != "calculate" else {"result": fn(str(clean.get("expression", "")))}
    except (ValueError, TypeError, ZeroDivisionError, OverflowError, SyntaxError) as e:
        raise HTTPException(400, str(e))
    return result


@app.get("/api/species")
def species():
    return dosing.KM_FACTORS


# ------------------------------------------------------------------ export / import

@app.get("/api/export")
def export():
    with db.connect() as c:
        data = {t: db.rows(c.execute(f"SELECT * FROM {t}")) for t in ("articles", "entities", "article_entities", "relations")}
    return data


@app.post("/api/import")
def import_map(data: dict):
    """Replace the current map with an exported one."""
    tables = ("articles", "entities", "article_entities", "relations")
    if not all(isinstance(data.get(t), list) for t in tables):
        raise HTTPException(400, "Not a Research Map export file.")
    with db.connect() as c:
        for t in reversed(tables):
            c.execute(f"DELETE FROM {t}")
        for t in tables:
            cols = [r[1] for r in c.execute(f"PRAGMA table_info({t})")]
            for row in data[t]:
                keys = [k for k in row if k in cols]
                c.execute(f"INSERT INTO {t}({', '.join(keys)}) VALUES ({', '.join('?' * len(keys))})", [row[k] for k in keys])
    return {"ok": True}
