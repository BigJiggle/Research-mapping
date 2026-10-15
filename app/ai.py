"""Claude-powered extraction, descriptions and Q&A chat (with deterministic dose-calculation tools)."""

import base64
import json
import os
from typing import Literal

import anthropic
from pydantic import BaseModel, Field

from . import db, dosing

MODEL = os.environ.get("RESEARCH_MAP_MODEL", "claude-opus-5-5")
CHAT_EFFORT = os.environ.get("RESEARCH_MAP_CHAT_EFFORT", "high")
EXTRACT_EFFORT = os.environ.get("RESEARCH_MAP_EXTRACT_EFFORT", "medium")
FALLBACK_BETA = "server-side-fallback-2026-07-01"
_use_fallbacks = os.environ.get("RESEARCH_MAP_FALLBACKS", "1") != "0"

_client = None


class AIUnavailable(Exception):
    pass


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        try:
            _client = anthropic.Anthropic()
        except Exception as e:  # missing credentials etc.
            raise AIUnavailable(f"Claude client could not start: {e}. Set ANTHROPIC_API_KEY.") from e
    return _client


def status() -> dict:
    has_creds = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
                      or os.path.isdir(os.path.expanduser("~/.config/anthropic")))
    return {"configured": has_creds, "model": MODEL}


def _extra():
    """Server-side refusal fallback ('default' routing) - re-runs a declined request on Anthropic's recommended model."""
    if not _use_fallbacks:
        return {}
    return {"extra_headers": {"anthropic-beta": FALLBACK_BETA}, "extra_body": {"fallbacks": "default"}}


def _disable_fallbacks_if(err: anthropic.BadRequestError) -> bool:
    global _use_fallbacks
    if _use_fallbacks and "fallback" in str(err).lower():
        _use_fallbacks = False
        return True
    return False


def _friendly(err: Exception) -> str:
    if isinstance(err, AIUnavailable):
        return str(err)
    if isinstance(err, anthropic.AuthenticationError):
        return "Claude API key is missing or invalid. Set ANTHROPIC_API_KEY and restart."
    if isinstance(err, anthropic.RateLimitError):
        return "Rate limited by the Claude API - wait a moment and try again."
    if isinstance(err, anthropic.APIConnectionError):
        return "Could not reach the Claude API (network)."
    if isinstance(err, anthropic.APIStatusError):
        return f"Claude API error ({err.status_code}): {err.message}"
    return f"AI error: {err}"


# ---------------------------------------------------------------- extraction

EntityType = Literal["drug", "target", "pathway", "disease", "effect", "formulation", "other"]
RelationType = Literal[
    "inhibits", "activates", "upregulates", "downregulates", "binds", "agonist_of", "antagonist_of",
    "modulates", "part_of", "treats", "causes", "increases", "decreases", "substrate_of", "metabolized_by",
    "associated_with",
]


class XEntity(BaseModel):
    name: str = Field(description="Canonical name, e.g. 'Rapamycin', 'mTORC1', 'PI3K/AKT/mTOR signaling'")
    type: EntityType
    aliases: list[str]
    short_info: str = Field(description="One short line: what it is (class, gene family, etc.)")
    role_in_study: str = Field(description="What this entity does in THIS article")


class XRelation(BaseModel):
    source: str = Field(description="Must exactly match an entity name")
    source_type: EntityType
    target: str = Field(description="Must exactly match an entity name")
    target_type: EntityType
    relation: RelationType
    mechanism: str = Field(description="How it acts, e.g. 'allosteric inhibition via FKBP12 binding'")
    dose: str = Field(description="Dose/concentration/route/duration if reported, else empty string")
    model_system: str = Field(description="e.g. 'C57BL/6 mice', 'HEK293 cells', 'phase II RCT (n=120)'; empty if unknown")
    evidence: str = Field(description="Short quote or paraphrase of the supporting finding")
    confidence: Literal["high", "medium", "low"]


class Extraction(BaseModel):
    title: str
    authors: str
    journal: str
    year: str
    abstract: str = Field(description="The article abstract (verbatim if available, else a faithful summary)")
    summary: str = Field(description="3-5 sentence plain-language summary of what was done and found")
    study_type: str = Field(description="e.g. 'in vitro', 'animal', 'RCT', 'review', 'meta-analysis', 'observational'")
    key_findings: list[str]
    entities: list[XEntity]
    relations: list[XRelation]


EXTRACT_SYSTEM = """You extract a mechanistic knowledge graph from biomedical research articles.

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
- If bibliographic fields are unknown, use empty strings."""


def extract(meta: dict, pdf_bytes: bytes | None = None) -> dict:
    """Run Claude over an article and return an Extraction dict."""
    c = client()
    text = (f"Title: {meta.get('title') or ''}\nAuthors: {meta.get('authors') or ''}\nJournal: {meta.get('journal') or ''} "
            f"{meta.get('year') or ''}\nPMID: {meta.get('pmid') or ''} DOI: {meta.get('doi') or ''}\n\n"
            f"Abstract:\n{meta.get('abstract') or '(none)'}\n")
    if meta.get("mesh"):
        text += f"\nMeSH / indexed chemicals: {json.dumps(meta['mesh'])}\n"
    if meta.get("full_text"):
        text += f"\nFull text:\n{meta['full_text']}\n"
    content = []
    if pdf_bytes:
        content.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                       "data": base64.standard_b64encode(pdf_bytes).decode()}})
    content.append({"type": "text", "text": text + "\nExtract the knowledge graph for this article."})

    def run():
        with c.messages.stream(
            model=MODEL, max_tokens=32000, system=EXTRACT_SYSTEM,
            output_config={"effort": EXTRACT_EFFORT, "format": {"type": "json_schema", "schema": _schema(Extraction)}},
            messages=[{"role": "user", "content": content}], **_extra(),
        ) as stream:
            return stream.get_final_message()

    try:
        try:
            msg = run()
        except anthropic.BadRequestError as e:
            if not _disable_fallbacks_if(e):
                raise
            msg = run()
    except Exception as e:
        raise AIUnavailable(_friendly(e)) from e
    if msg.stop_reason == "refusal":
        raise AIUnavailable("Claude declined to process this article.")
    if msg.stop_reason == "max_tokens":
        raise AIUnavailable("Extraction was too long and got cut off; try an article with less text.")
    raw = next((b.text for b in msg.content if b.type == "text"), "")
    return Extraction.model_validate_json(raw).model_dump()


def _schema(model) -> dict:
    """Pydantic JSON schema with additionalProperties:false everywhere (required by structured outputs)."""
    schema = model.model_json_schema()

    def fix(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                node["additionalProperties"] = False
                node["required"] = list(node.get("properties", {}).keys())
            if isinstance(node.get("title"), str):  # schema annotation, not a property named "title"
                node.pop("title")
            for v in node.values():
                fix(v)
        elif isinstance(node, list):
            for v in node:
                fix(v)
    fix(schema)
    return schema


def fallback_extraction(meta: dict) -> dict:
    """No-AI fallback: use PubMed's indexed chemicals / MeSH terms so the article still lands on the map."""
    mesh = meta.get("mesh") or {}
    ents = [{"name": ch, "type": "drug", "aliases": [], "short_info": "PubMed indexed substance", "role_in_study": ""}
            for ch in mesh.get("chemicals", [])[:15]]
    ents += [{"name": t, "type": "disease" if any(w in t.lower() for w in ("disease", "neoplasm", "syndrome", "diabetes", "obesity", "cancer")) else "other",
              "aliases": [], "short_info": "MeSH term", "role_in_study": ""}
             for t in mesh.get("terms", [])[:10] if t.lower() not in ("humans", "animals", "male", "female", "mice", "rats", "adult", "middle aged", "aged")]
    return {"summary": None, "key_findings": [], "study_type": None, "entities": ents, "relations": []}


# ---------------------------------------------------------------- descriptions

DESCRIBE_SYSTEM = """You write concise, accurate research briefs for a scientist's pathway-mapping tool.
Use Markdown with short headings and bullets. Ground statements in the user's map data when provided (cite PMIDs as
[PMID 123]) and clearly label anything from general knowledge as such. Be precise about mechanism and direction of
effect. Don't invent doses or citations. Keep it under ~400 words."""

DESCRIBE_TEMPLATES = {
    "drug": "Write a brief on this drug/compound: class & origin, primary targets and mechanism of action, pathways it acts on "
            "(and direction), key findings from the mapped articles, reported doses/routes/model systems, known PK/formulation "
            "notes, safety/limitations, and open questions.",
    "target": "Write a brief on this molecular target: what it is, its role in signaling, upstream regulators and downstream "
              "effects, drugs in the map that act on it (and how), and relevance to diseases in the map.",
    "pathway": "Write a brief on this pathway: core components and flow of signaling, what activates/inhibits it, outputs, "
               "drugs in the map acting on it and where they hit, and links to diseases/effects in the map.",
    "default": "Write a brief on this entity: what it is, how it connects to the other entities in the map, key findings, and open questions.",
}


def stream_text(system: str, user: str, effort: str = "medium"):
    """Yield text chunks for a single-turn request."""
    c = client()
    for attempt in range(2):
        try:
            with c.messages.stream(model=MODEL, max_tokens=16000, system=system, output_config={"effort": effort},
                                   messages=[{"role": "user", "content": user}], **_extra()) as stream:
                for text in stream.text_stream:
                    yield text
                if stream.get_final_message().stop_reason == "refusal":
                    yield "\n\n*Claude declined to answer this request.*"
            return
        except anthropic.BadRequestError as e:
            if attempt == 0 and _disable_fallbacks_if(e):
                continue
            raise


def describe_entity_prompt(entity_id: int) -> str:
    e = db.get_entity(entity_id)
    tmpl = DESCRIBE_TEMPLATES.get(e["type"], DESCRIBE_TEMPLATES["default"])
    return f"{tmpl}\n\n<map_data>\n{db.entity_context_text(entity_id)}\n</map_data>"


def summarize_article_prompt(article_id: int) -> str:
    return ("Write a structured summary of this article: Objective, Methods (model system, doses, routes), Key results "
            "(with numbers), Mechanism (drug -> target -> pathway -> effect), Limitations, and Relevance.\n\n<article>\n"
            + db.article_context_text(article_id) + "\n</article>")


# ---------------------------------------------------------------- chat with tools

CHAT_SYSTEM = """You are a research assistant inside "Research Map", a local tool where a scientist maps research articles,
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
- Use Markdown. Be concise and direct."""

MODE_HINTS = {
    "pathway": "Focus: pathway biology - components, regulation, crosstalk, and which mapped drugs act where.",
    "drug": "Focus: the drug/research compound - mechanism, targets, pathways, evidence, doses used in studies, safety.",
    "formulation": "Focus: formulation - solubility, vehicle/excipients, route, stability, bioavailability, reconstitution and storage.",
    "dose": "Focus: dose calculation - use calculator tools for every number, show formulas and units, state assumptions.",
}

TOOLS = [
    {"name": "search_map", "description": "Search the user's research map for entities (drugs, targets, pathways, diseases, effects) by name or alias. Returns ids, names and types.",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "get_entity_details", "description": "Get everything the map knows about one entity: its relations (with mechanism, dose, model system, evidence, source article) and the articles mentioning it.",
     "input_schema": {"type": "object", "properties": {"entity_id": {"type": "integer"}}, "required": ["entity_id"]}},
    {"name": "get_article", "description": "Get an article in the map (title, abstract, full text if available, extracted relations) by its article id.",
     "input_schema": {"type": "object", "properties": {"article_id": {"type": "integer"}}, "required": ["article_id"]}},
    {"name": "list_articles", "description": "List all articles in the map with ids, titles, PMIDs and years.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "calculate", "description": "Evaluate an arithmetic expression exactly (supports + - * / ^ ( ), sqrt, log, ln, log10, exp, round, min, max, pi). Use for ALL arithmetic.",
     "input_schema": {"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]}},
    {"name": "human_equivalent_dose", "description": "Convert a mg/kg dose between species using FDA body-surface-area Km factors. Species: " + ", ".join(sorted(dosing.KM_FACTORS)) + ".",
     "input_schema": {"type": "object", "properties": {
         "dose_mg_per_kg": {"type": "number"}, "from_species": {"type": "string"},
         "to_species": {"type": "string", "description": "default human"},
         "body_weight_kg": {"type": "number", "description": "optional, target body weight for total dose"}},
         "required": ["dose_mg_per_kg", "from_species"]}},
    {"name": "body_surface_area", "description": "Body surface area (Mosteller and DuBois) from weight and height.",
     "input_schema": {"type": "object", "properties": {"weight_kg": {"type": "number"}, "height_cm": {"type": "number"}}, "required": ["weight_kg", "height_cm"]}},
    {"name": "weight_based_dose", "description": "mg/kg x body weight, optional daily frequency and volume at a given concentration.",
     "input_schema": {"type": "object", "properties": {
         "dose_mg_per_kg": {"type": "number"}, "weight_kg": {"type": "number"},
         "doses_per_day": {"type": "integer"}, "concentration_mg_per_ml": {"type": "number"}},
         "required": ["dose_mg_per_kg", "weight_kg"]}},
    {"name": "molar_conversion", "description": "Solve mass (mg) / volume (mL) / concentration (mM) for a compound of given molecular weight. Provide exactly two of the three.",
     "input_schema": {"type": "object", "properties": {
         "mw_g_per_mol": {"type": "number"}, "mass_mg": {"type": "number"}, "volume_ml": {"type": "number"}, "concentration_mM": {"type": "number"}},
         "required": ["mw_g_per_mol"]}},
    {"name": "dilution", "description": "C1V1 = C2V2. Provide exactly three of c1, v1, c2, v2 (consistent units).",
     "input_schema": {"type": "object", "properties": {"c1": {"type": "number"}, "v1": {"type": "number"}, "c2": {"type": "number"}, "v2": {"type": "number"}}}},
    {"name": "reconstitution", "description": "Lyophilized vial reconstitution: concentration, volume per dose, syringe units, doses per vial.",
     "input_schema": {"type": "object", "properties": {
         "vial_mg": {"type": "number"}, "diluent_ml": {"type": "number"}, "dose_mcg": {"type": "number"},
         "syringe_units_per_ml": {"type": "number", "description": "default 100 (U-100)"}},
         "required": ["vial_mg", "diluent_ml", "dose_mcg"]}},
]
for _t in TOOLS:
    _t["eager_input_streaming"] = True

WEB_SEARCH_TOOL = {"type": "web_search_20260209", "name": "web_search", "max_uses": 5}

_ARG_MAP = {
    "human_equivalent_dose": ("hed", ["dose_mg_per_kg", "from_species", "to_species", "body_weight_kg"]),
    "body_surface_area": ("bsa", ["weight_kg", "height_cm"]),
    "weight_based_dose": ("weight_dose", ["dose_mg_per_kg", "weight_kg", "doses_per_day", "concentration_mg_per_ml"]),
    "molar_conversion": ("molar", ["mw_g_per_mol", "mass_mg", "volume_ml", "concentration_mM"]),
    "dilution": ("dilution", ["c1", "v1", "c2", "v2"]),
    "reconstitution": ("reconstitution", ["vial_mg", "diluent_ml", "dose_mcg", "syringe_units_per_ml"]),
}


def run_tool(name: str, args) -> str:
    if not isinstance(args, dict):
        raise ValueError("tool input must be an object")
    if name == "search_map":
        return json.dumps(db.search_entities(str(args.get("query", ""))))
    if name == "get_entity_details":
        return db.entity_context_text(int(args["entity_id"])) or "No such entity."
    if name == "get_article":
        return db.article_context_text(int(args["article_id"]), max_chars=40000) or "No such article."
    if name == "list_articles":
        return json.dumps(db.list_articles())
    if name == "calculate":
        return json.dumps({"expression": args["expression"], "result": dosing.safe_calc(str(args["expression"]))})
    if name in _ARG_MAP:
        fn_name, keys = _ARG_MAP[name]
        kwargs = {k: args[k] for k in keys if args.get(k) is not None}
        if fn_name == "hed" and "to_species" not in kwargs:
            kwargs["to_species"] = "human"
        return json.dumps(dosing.CALCULATORS[fn_name](**kwargs))
    raise ValueError(f"unknown tool {name}")


def _context_block(focus: dict | None, mode: str | None) -> str:
    parts = ["<map_overview>\n" + db.map_overview_text() + "\n</map_overview>"]
    if focus and focus.get("type") == "entity":
        parts.append("<focused_entity>\n" + db.entity_context_text(int(focus["id"])) + "\n</focused_entity>")
    elif focus and focus.get("type") == "article":
        parts.append("<focused_article>\n" + db.article_context_text(int(focus["id"]), 40000) + "\n</focused_article>")
    if mode in MODE_HINTS:
        parts.append(MODE_HINTS[mode])
    return "\n\n".join(parts)


def chat_events(history: list[dict], focus: dict | None, mode: str | None, web: bool):
    """Generator of (event, data) tuples: text / thinking / tool / error / done."""
    c = client()
    system = [
        {"type": "text", "text": CHAT_SYSTEM, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": _context_block(focus, mode)},
    ]
    messages = [{"role": m["role"], "content": m["content"]} for m in history if m.get("content")]
    tools = TOOLS + ([WEB_SEARCH_TOOL] if web else [])

    for _ in range(12):  # agent loop cap
        try:
            with c.messages.stream(
                model=MODEL, max_tokens=64000, system=system, tools=tools, messages=messages,
                thinking={"type": "adaptive", "display": "summarized"},
                output_config={"effort": CHAT_EFFORT}, **_extra(),
            ) as stream:
                for event in stream:
                    if event.type == "text":
                        yield "text", event.text
                    elif event.type == "thinking":
                        yield "thinking", event.thinking
                    elif event.type == "content_block_start" and event.content_block.type == "server_tool_use":
                        yield "tool", {"name": event.content_block.name, "status": "running"}
                response = stream.get_final_message()
        except anthropic.BadRequestError as e:
            if _disable_fallbacks_if(e):
                continue
            yield "error", _friendly(e)
            return
        except ValueError:
            continue  # unparseable streamed tool JSON: re-issue the turn
        except Exception as e:
            yield "error", _friendly(e)
            return

        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason == "pause_turn":
            continue
        if response.stop_reason == "refusal":
            yield "text", "\n\n*Claude declined to answer this request.*"
            break
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        if not tool_uses:
            break
        if response.stop_reason == "max_tokens":
            yield "error", "Response was cut off (max tokens)."
            break
        results = []
        for b in tool_uses:
            yield "tool", {"name": b.name, "input": b.input, "status": "running"}
            try:
                out = run_tool(b.name, b.input)
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": out})
                yield "tool", {"name": b.name, "input": b.input, "output": out[:2000], "status": "done"}
            except (ValueError, TypeError, KeyError, ZeroDivisionError, OverflowError) as e:
                results.append({"type": "tool_result", "tool_use_id": b.id, "is_error": True, "content": f"Error: {e}"})
                yield "tool", {"name": b.name, "input": b.input, "output": f"Error: {e}", "status": "error"}
        messages.append({"role": "user", "content": results})
    yield "done", None
