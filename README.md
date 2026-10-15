# Research Map

A local web app for mapping research articles onto an interactive graph of **drugs / research compounds → targets → pathways → effects / diseases**, with Claude built in for extraction, descriptions and Q&A.

## What it does

- **Add articles** by PMID, PubMed link, PMC ID or link, DOI, arXiv, bioRxiv/medRxiv, or any article URL. You can paste several at once, one per line. You can also paste raw text or upload a PDF (**More…**).
  - PubMed metadata, abstract, MeSH terms and indexed chemicals come from NCBI E-utilities. When an open-access PMC version exists, the full text is pulled in too.
  - DOIs that aren't in PubMed are resolved through Crossref. Other web pages are read through their `citation_*` meta tags or page text.
- **AI extraction**: Claude reads each article and adds:
  - entities: drugs, targets, pathways, diseases, effects and formulations;
  - typed links: *inhibits, activates, up/downregulates, binds, agonist/antagonist of, modulates, part of, treats, increases/decreases…*;
  - for each link, the **mechanism**, **dose**, **model system**, **evidence** and **confidence**.

  Entities with the same name or alias are merged across articles, so the map grows into one connected network.
- **Interactive map** (Cytoscape.js):
  - Click a node to highlight its neighbourhood (1–4 hops) and open its details.
  - Click a link to see every supporting article and its mechanism.
  - Filter by entity type or relation type, search, and switch layouts (force-directed, concentric, layered drug → target → pathway → effect).
  - Add your own nodes and links, merge duplicate nodes, and export to PNG or JSON.
- **AI descriptions**: one click writes a brief on any drug, target or pathway, grounded in your mapped articles with PMID citations, or a structured summary of any article. Both are saved.
- **Ask AI**: chat about a topic, pathway, research drug, formulation or dose calculation.
  - Select a node to focus the question on it.
  - Claude can search your map and read your articles.
  - It does arithmetic **only through built-in calculator tools**, never in its head.
  - Optional web search is available.
- **Dose calculator tab** (works without AI):
  - FDA BSA/Km species conversion (HED)
  - weight-based dose
  - vial reconstitution (mg/mL, mL and U-100 syringe units per dose)
  - molarity / stock solutions, C1V1 = C2V2, body surface area, and a general calculator.

> For research and education only. Not medical advice. Check every calculation yourself before using it.

## Run it locally

Requires Python 3.10+.

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

export ANTHROPIC_API_KEY=sk-ant-...  # Windows (PowerShell): $env:ANTHROPIC_API_KEY="sk-ant-..."
python run.py                        # opens http://127.0.0.1:8000
```

Without an API key the app still works: articles are fetched and placed on the map using PubMed's indexed chemicals and MeSH terms, and the calculators work. AI extraction, descriptions and chat need the key.

### Optional settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `RESEARCH_MAP_MODEL` | `claude-opus-5-5` | Claude model |
| `RESEARCH_MAP_EXTRACT_EFFORT` | `medium` | Effort for article extraction (`low`…`max`) |
| `RESEARCH_MAP_CHAT_EFFORT` | `high` | Effort for chat answers |
| `RESEARCH_MAP_FALLBACKS` | `1` | Server-side refusal fallback (`0` to disable) |
| `RESEARCH_MAP_DB` | `data/research_map.db` | Where your map is stored (SQLite) |
| `NCBI_API_KEY` | – | Raises NCBI's rate limit if you add many PubMed articles |
| `PORT` / `HOST` | `8000` / `127.0.0.1` | Server address |

## Project layout

```
run.py              start the server
app/main.py         FastAPI routes
app/sources.py      PubMed / PMC / DOI / arXiv / URL fetching
app/ai.py           Claude extraction, descriptions, chat + tool loop
app/dosing.py       deterministic dose & formulation calculators
app/db.py           SQLite storage (articles, entities, relations)
app/static/         front end (vendored Cytoscape, marked, DOMPurify - works offline)
tests/              pytest suite
```

Run the tests with `pip install pytest httpx && pytest`.
