"""Resolve user input (PMID, PubMed/PMC/DOI/arXiv/bioRxiv URLs, any article URL) into article metadata + text."""

import html
import json
import os
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
UA = "ResearchMap/1.0 (local research mapping tool)"
NCBI_KEY = os.environ.get("NCBI_API_KEY")
FULL_TEXT_LIMIT = 80_000


class SourceError(Exception):
    pass


def _get(url: str, accept: str | None = None, timeout=25) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **({"Accept": accept} if accept else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            charset = r.headers.get_content_charset() or "utf-8"
            return r.read().decode(charset, errors="replace")
    except urllib.error.HTTPError as e:
        raise SourceError(f"HTTP {e.code} fetching {url}") from e
    except urllib.error.URLError as e:
        raise SourceError(f"Could not reach {urllib.parse.urlparse(url).netloc}: {e.reason}") from e


def _eutil(path: str, **params) -> str:
    params.setdefault("tool", "research-map")
    if NCBI_KEY:
        params["api_key"] = NCBI_KEY
    return _get(f"{EUTILS}/{path}?{urllib.parse.urlencode(params)}")


def _text(el) -> str:
    return " ".join("".join(el.itertext()).split()) if el is not None else ""


# ---------- identifier detection ----------

def classify(raw: str) -> tuple[str, str]:
    s = raw.strip()
    if re.fullmatch(r"(?i)(pmid:?\s*)?\d{1,9}", s):
        return "pmid", re.sub(r"\D", "", s)
    if re.fullmatch(r"(?i)pmc\d+", s):
        return "pmcid", s.upper()
    m = re.search(r"pubmed\.ncbi\.nlm\.nih\.gov/(\d+)", s) or re.search(r"ncbi\.nlm\.nih\.gov/pubmed/(\d+)", s)
    if m:
        return "pmid", m.group(1)
    m = re.search(r"(?i)/pmc/articles/(PMC\d+)", s) or re.search(r"(?i)pmc\.ncbi\.nlm\.nih\.gov/articles/(PMC\d+)", s)
    if m:
        return "pmcid", m.group(1).upper()
    m = re.search(r"arxiv\.org/(?:abs|pdf)/([\w.\-/]+?)(?:v\d+)?(?:\.pdf)?$", s) or re.fullmatch(r"(?i)arxiv:\s*([\d.]+)", s)
    if m:
        return "arxiv", m.group(1)
    m = re.search(r"(10\.\d{4,9}/[^\s?#]+)", s)
    if m and ("doi.org" in s or not s.startswith("http") or "biorxiv" in s or "medrxiv" in s):
        doi = re.sub(r"(v\d+)?(\.full(\.pdf)?|\.abstract)?$", "", m.group(1).rstrip(".")) if ("biorxiv" in s or "medrxiv" in s) else m.group(1).rstrip(".")
        return "doi", doi
    if s.startswith("http://") or s.startswith("https://"):
        return "url", s
    raise SourceError("Couldn't recognise that input. Use a PMID, PMCID, DOI, or an article URL.")


# ---------- PubMed ----------

def parse_pubmed_xml(xml_text: str) -> dict:
    root = ET.fromstring(xml_text)
    art = root.find(".//PubmedArticle")
    if art is None:
        raise SourceError("PubMed returned no article for that ID.")
    cit = art.find("MedlineCitation")
    a = cit.find("Article")
    pmid = _text(cit.find("PMID"))
    title = _text(a.find("ArticleTitle"))
    abstract_parts = []
    for p in a.findall("Abstract/AbstractText"):
        label = p.get("Label")
        abstract_parts.append(f"{label}: {_text(p)}" if label else _text(p))
    authors = []
    for au in a.findall("AuthorList/Author"):
        if au.find("LastName") is not None:
            authors.append(f"{_text(au.find('LastName'))} {_text(au.find('Initials'))}".strip())
        elif au.find("CollectiveName") is not None:
            authors.append(_text(au.find("CollectiveName")))
    journal = _text(a.find("Journal/ISOAbbreviation")) or _text(a.find("Journal/Title"))
    year = _text(a.find("Journal/JournalIssue/PubDate/Year")) or _text(a.find("Journal/JournalIssue/PubDate/MedlineDate"))[:4]
    doi = None
    for aid in art.findall("PubmedData/ArticleIdList/ArticleId"):
        if aid.get("IdType") == "doi":
            doi = _text(aid)
    pmcid = next((_text(x) for x in art.findall("PubmedData/ArticleIdList/ArticleId") if x.get("IdType") == "pmc"), None)
    mesh = [_text(m.find("DescriptorName")) for m in cit.findall("MeshHeadingList/MeshHeading")]
    chemicals = [_text(ch.find("NameOfSubstance")) for ch in cit.findall("ChemicalList/Chemical")]
    keywords = [_text(k) for k in cit.findall("KeywordList/Keyword")]
    return {
        "pmid": pmid, "doi": doi, "pmcid": pmcid, "title": title,
        "authors": ", ".join(authors[:12]) + (" et al." if len(authors) > 12 else ""),
        "journal": journal, "year": year, "abstract": "\n".join(abstract_parts),
        "mesh": {"terms": mesh, "chemicals": chemicals, "keywords": keywords},
        "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
    }


def fetch_pubmed(pmid: str) -> dict:
    meta = parse_pubmed_xml(_eutil("efetch.fcgi", db="pubmed", id=pmid, retmode="xml"))
    if meta.get("pmcid"):
        try:
            meta["full_text"] = fetch_pmc_fulltext(meta["pmcid"])
        except SourceError:
            pass
    return meta


def fetch_pmc_fulltext(pmcid: str) -> str | None:
    xml_text = _eutil("efetch.fcgi", db="pmc", id=pmcid.replace("PMC", ""), retmode="xml")
    root = ET.fromstring(xml_text)
    body = root.find(".//body")
    if body is None:
        return None
    chunks = []
    for sec in body.iter():
        if sec.tag == "title":
            chunks.append("\n## " + _text(sec))
        elif sec.tag == "p":
            chunks.append(_text(sec))
    return "\n".join(chunks)[:FULL_TEXT_LIMIT] or None


def idconv(ident: str) -> dict:
    data = json.loads(_get("https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?" +
                           urllib.parse.urlencode({"ids": ident, "format": "json", "tool": "research-map"})))
    recs = data.get("records") or []
    return recs[0] if recs else {}


# ---------- other sources ----------

def fetch_crossref(doi: str) -> dict:
    data = json.loads(_get("https://api.crossref.org/works/" + urllib.parse.quote(doi)))["message"]
    abstract = re.sub(r"<[^>]+>", " ", data.get("abstract") or "")
    year = None
    for k in ("published-print", "published-online", "issued", "posted"):
        if data.get(k, {}).get("date-parts"):
            year = str(data[k]["date-parts"][0][0])
            break
    authors = [f"{a.get('family', '')} {a.get('given', '')[:1]}".strip() for a in data.get("author", [])]
    return {
        "doi": doi, "title": " ".join((data.get("title") or [""])[0].split()),
        "authors": ", ".join(authors[:12]) + (" et al." if len(authors) > 12 else ""),
        "journal": (data.get("container-title") or [""])[0] or ((data.get("institution") or [{}])[0].get("name") or ""),
        "year": year, "abstract": " ".join(html.unescape(abstract).split()),
        "url": f"https://doi.org/{doi}",
    }


def fetch_arxiv(arxiv_id: str) -> dict:
    xml_text = _get("https://export.arxiv.org/api/query?id_list=" + urllib.parse.quote(arxiv_id))
    ns = {"a": "http://www.w3.org/2005/Atom"}
    entry = ET.fromstring(xml_text).find("a:entry", ns)
    if entry is None or entry.find("a:title", ns) is None:
        raise SourceError("arXiv returned no entry.")
    return {
        "title": _text(entry.find("a:title", ns)), "abstract": _text(entry.find("a:summary", ns)),
        "authors": ", ".join(_text(a.find("a:name", ns)) for a in entry.findall("a:author", ns)[:12]),
        "journal": "arXiv", "year": _text(entry.find("a:published", ns))[:4],
        "url": f"https://arxiv.org/abs/{arxiv_id}",
    }


class _PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta, self.text, self._skip, self.title = {}, [], 0, ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta":
            key = (a.get("name") or a.get("property") or "").lower()
            if key and a.get("content"):
                self.meta.setdefault(key, []).append(a["content"])
        elif tag in ("script", "style", "nav", "footer", "header", "noscript"):
            self._skip += 1
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag in ("script", "style", "nav", "footer", "header", "noscript") and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip and data.strip():
            self.text.append(data.strip())


def fetch_url(url: str) -> dict:
    page = _get(url, accept="text/html,application/xhtml+xml")
    p = _PageParser()
    p.feed(page)
    m = lambda k: (p.meta.get(k) or [None])[0]
    if m("citation_pmid"):
        return resolve(m("citation_pmid"))
    if m("citation_doi"):
        try:
            return resolve(m("citation_doi").replace("doi:", ""))
        except SourceError:
            pass
    body = " ".join(p.text)
    return {
        "title": m("citation_title") or m("og:title") or " ".join(p.title.split()) or url,
        "authors": ", ".join((p.meta.get("citation_author") or [])[:12]),
        "journal": m("citation_journal_title") or m("og:site_name") or urllib.parse.urlparse(url).netloc,
        "year": (m("citation_publication_date") or m("citation_date") or "")[:4],
        "abstract": m("citation_abstract") or m("description") or m("og:description") or body[:1500],
        "full_text": body[:FULL_TEXT_LIMIT], "url": url,
    }


def resolve(raw: str) -> dict:
    kind, ident = classify(raw)
    if kind == "pmid":
        meta = fetch_pubmed(ident)
    elif kind == "pmcid":
        rec = idconv(ident)
        if rec.get("pmid"):
            meta = fetch_pubmed(rec["pmid"])
        else:
            meta = {"title": ident, "url": f"https://pmc.ncbi.nlm.nih.gov/articles/{ident}/", "full_text": fetch_pmc_fulltext(ident)}
    elif kind == "doi":
        try:
            rec = idconv(ident)
        except SourceError:
            rec = {}
        if rec.get("pmid"):
            meta = fetch_pubmed(rec["pmid"])
        else:
            meta = fetch_crossref(ident)
    elif kind == "arxiv":
        meta = fetch_arxiv(ident)
    else:
        meta = fetch_url(ident)
    meta["source_key"] = source_key(meta, raw)
    return meta


def source_key(meta: dict, raw: str) -> str:
    if meta.get("pmid"):
        return f"pmid:{meta['pmid']}"
    if meta.get("doi"):
        return f"doi:{meta['doi'].lower()}"
    return f"url:{meta.get('url') or raw.strip()}"
