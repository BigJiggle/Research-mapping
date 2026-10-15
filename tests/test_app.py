import json
import os
import tempfile

os.environ["RESEARCH_MAP_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")

import pytest
from fastapi.testclient import TestClient

from app import ai, db, dosing, main, sources

PUBMED_XML = """<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>23746838</PMID>
<Article><Journal><JournalIssue><PubDate><Year>2013</Year></PubDate></JournalIssue><ISOAbbreviation>Cell Metab</ISOAbbreviation></Journal>
<ArticleTitle>Rapamycin <i>extends</i> lifespan</ArticleTitle><Abstract><AbstractText Label="BACKGROUND">mTOR matters.</AbstractText>
<AbstractText>Rapamycin inhibits mTORC1.</AbstractText></Abstract>
<AuthorList><Author><LastName>Smith</LastName><Initials>J</Initials></Author></AuthorList></Article>
<ChemicalList><Chemical><NameOfSubstance>Sirolimus</NameOfSubstance></Chemical></ChemicalList>
<MeshHeadingList><MeshHeading><DescriptorName>Longevity</DescriptorName></MeshHeading><MeshHeading><DescriptorName>Mice</DescriptorName></MeshHeading></MeshHeadingList>
</MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1016/j.cmet.2013.05.001</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>"""

EXTRACTION = {
    "title": "", "authors": "", "journal": "", "year": "", "abstract": "", "summary": "Rapamycin inhibits mTORC1.",
    "study_type": "animal", "key_findings": ["Lifespan extended"],
    "entities": [
        {"name": "Rapamycin", "type": "drug", "aliases": ["Sirolimus"], "short_info": "macrolide", "role_in_study": "treatment"},
        {"name": "mTORC1", "type": "target", "aliases": [], "short_info": "kinase complex", "role_in_study": "target"},
        {"name": "Autophagy", "type": "pathway", "aliases": [], "short_info": "", "role_in_study": "outcome"},
    ],
    "relations": [
        {"source": "Rapamycin", "source_type": "drug", "target": "mTORC1", "target_type": "target", "relation": "inhibits",
         "mechanism": "FKBP12 binding", "dose": "14 ppm in diet", "model_system": "mice", "evidence": "x", "confidence": "high"},
        {"source": "mTORC1", "source_type": "target", "target": "Autophagy", "target_type": "pathway", "relation": "inhibits",
         "mechanism": "ULK1 phosphorylation", "dose": "", "model_system": "", "evidence": "", "confidence": "medium"},
    ],
}


@pytest.mark.parametrize("raw,expected", [
    ("23746838", ("pmid", "23746838")),
    ("PMID: 23746838", ("pmid", "23746838")),
    ("https://pubmed.ncbi.nlm.nih.gov/23746838/", ("pmid", "23746838")),
    ("PMC3687363", ("pmcid", "PMC3687363")),
    ("https://pmc.ncbi.nlm.nih.gov/articles/PMC3687363/", ("pmcid", "PMC3687363")),
    ("https://doi.org/10.1016/j.cmet.2013.05.001", ("doi", "10.1016/j.cmet.2013.05.001")),
    ("10.1016/j.cmet.2013.05.001", ("doi", "10.1016/j.cmet.2013.05.001")),
    ("https://www.biorxiv.org/content/10.1101/2023.01.01.522000v2.full", ("doi", "10.1101/2023.01.01.522000")),
    ("https://arxiv.org/abs/2401.01234v3", ("arxiv", "2401.01234")),
    ("https://www.nature.com/articles/s41586-020-1234-5", ("url", "https://www.nature.com/articles/s41586-020-1234-5")),
])
def test_classify(raw, expected):
    assert sources.classify(raw) == expected


def test_parse_pubmed():
    m = sources.parse_pubmed_xml(PUBMED_XML)
    assert m["pmid"] == "23746838" and m["doi"] == "10.1016/j.cmet.2013.05.001"
    assert m["title"] == "Rapamycin extends lifespan"
    assert "BACKGROUND: mTOR matters." in m["abstract"]
    assert m["mesh"]["chemicals"] == ["Sirolimus"]


def test_dosing():
    r = dosing.hed(10, "mouse")
    assert r["equivalent_dose_mg_per_kg"] == pytest.approx(10 * 3 / 37, rel=1e-3)
    assert dosing.molar(180.16, mass_mg=180.16, volume_ml=1000)["concentration_mM"] == pytest.approx(1)
    assert dosing.dilution(c1=10, v1=None, c2=1, v2=100)["v1"] == 10
    rec = dosing.reconstitution(5, 2, 250)
    assert rec["volume_per_dose_ml"] == 0.1 and rec["syringe_units_per_dose"] == 10
    assert dosing.safe_calc("2^3 + sqrt(16)") == 12
    with pytest.raises(ValueError):
        dosing.safe_calc("__import__('os')")


def test_schema_is_strict():
    s = ai._schema(ai.Extraction)
    assert s["additionalProperties"] is False and "title" in s["properties"]
    assert all(d["additionalProperties"] is False for d in s["$defs"].values())


def test_api_flow(monkeypatch):
    monkeypatch.setattr(sources, "_eutil", lambda *a, **k: PUBMED_XML)
    monkeypatch.setattr(ai, "extract", lambda meta, pdf=None: json.loads(json.dumps(EXTRACTION)))
    c = TestClient(main.app)
    r = c.post("/api/articles", json={"input": "23746838"}).json()
    assert r["relations"] == 2
    assert c.post("/api/articles", json={"input": "https://pubmed.ncbi.nlm.nih.gov/23746838/"}).json()["duplicate"]
    g = c.get("/api/graph").json()
    names = {e["name"] for e in g["entities"]}
    assert {"Rapamycin", "mTORC1", "Autophagy"} <= names
    rapa = next(e for e in g["entities"] if e["name"] == "Rapamycin")
    detail = c.get(f"/api/entities/{rapa['id']}").json()
    assert detail["relations"][0]["mechanism"] == "FKBP12 binding"
    # alias resolution: a second article naming "sirolimus" maps onto the same node
    with db.connect() as conn:
        assert db.upsert_entity(conn, "sirolimus", "drug") == rapa["id"]
    # manual node + link + merge
    nid = c.post("/api/entities", json={"name": "Rapamune", "type": "drug"}).json()["id"]
    c.post("/api/relations", json={"source_id": nid, "target_id": rapa["id"], "relation": "associated_with"})
    assert c.post("/api/entities/merge", json={"keep_id": rapa["id"], "merge_id": nid}).status_code == 200
    assert "Rapamune" in c.get(f"/api/entities/{rapa['id']}").json()["aliases"]
    # calculators
    assert c.post("/api/calc/hed", json={"dose_mg_per_kg": 12.3, "from_species": "rat"}).json()["equivalent_dose_mg_per_kg"] == pytest.approx(12.3 * 6 / 37, rel=1e-3)
    assert c.post("/api/calc/molar", json={"mw_g_per_mol": 100}).status_code == 400
    # tools used by chat
    assert "FKBP12" in ai.run_tool("get_entity_details", {"entity_id": rapa["id"]})
    assert json.loads(ai.run_tool("human_equivalent_dose", {"dose_mg_per_kg": 10, "from_species": "mouse"}))["km_to"] == 37
    # export / import round-trip
    exp = c.get("/api/export").json()
    assert c.post("/api/import", json=exp).status_code == 200
    assert len(c.get("/api/graph").json()["relations"]) == len(g["relations"])
    # delete article cleans up orphans
    c.delete(f"/api/articles/{r['article_id']}")
    assert c.get("/api/graph").json()["entities"] == []


def test_no_ai_fallback(monkeypatch):
    monkeypatch.setattr(sources, "_eutil", lambda *a, **k: PUBMED_XML.replace("23746838", "111"))
    def boom(*a, **k):
        raise ai.AIUnavailable("no key")
    monkeypatch.setattr(ai, "extract", boom)
    c = TestClient(main.app)
    r = c.post("/api/articles", json={"input": "111"}).json()
    assert "AI extraction skipped" in r["warning"]
    names = {e["name"] for e in c.get("/api/graph").json()["entities"]}
    assert "Sirolimus" in names and "Mice" not in names
