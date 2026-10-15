"""Build the iPad / browser-only edition of Research Map.

Produces a static, installable web app (no Python server needed):
  docs/                       ready for GitHub Pages (Settings -> Pages -> branch, /docs)
    index.html                the whole app in one file (UI, graph engine, Claude SDK, backend)
    manifest.webmanifest, sw.js, icons   -> "Add to Home Screen" + offline use
  dist/research-map-ipad.zip  the same files, to host anywhere

Run:  python ipad/build.py
"""
import hashlib
import json
import os
import re
import shutil
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(ROOT, "app", "static")
IPAD = os.path.join(ROOT, "ipad")
OUT = os.path.join(ROOT, "docs")
DIST = os.path.join(ROOT, "dist")
VERSION_FILES = []


def read(*parts):
    path = os.path.join(*parts)
    VERSION_FILES.append(path)
    with open(path, encoding="utf-8") as f:
        return f.read()


def inline_script(js):
    return "<script>\n" + js.replace("</script", "<\\/script") + "\n</script>"


def build_html():
    html = read(STATIC, "index.html")

    def script(m):
        src = m.group(1)
        if src.startswith("/static/"):
            return inline_script(read(STATIC, src[len("/static/"):]))
        raise ValueError(f"unexpected script {src}")

    html = re.sub(r'<script src="([^"]+)"></script>', script, html)
    css = read(STATIC, "styles.css") + "\n" + read(IPAD, "ipad.css")
    html = html.replace('<link rel="stylesheet" href="/static/styles.css">', "<style>\n" + css + "\n</style>", 1)
    # the in-page backend and the Claude SDK must load before app.js boots
    app_js_marker = "<script>\n/* Research Map front end"
    assert app_js_marker in html, "app.js inline marker not found"
    pre = inline_script(read(IPAD, "vendor", "anthropic-sdk.js")) + "\n" + inline_script(read(IPAD, "backend.js")) + "\n"
    html = html.replace(app_js_marker, pre + app_js_marker, 1)
    head_extra = """<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Research Map">
<meta name="theme-color" content="#2f6fde">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="icon" href="icon-192.png">"""
    html = html.replace('<meta name="viewport" content="width=device-width, initial-scale=1">', head_extra, 1)
    sw = """<script>
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
</script>
</body>"""
    head, sep, tail = html.rpartition("</body>")  # the page's own </body>; vendored JS contains the string too
    html = head + sw + tail
    for block in re.findall(r"<script>\n(.*?)\n</script>", html, re.S):  # sanity: nothing got spliced into vendored code
        assert "serviceWorker.register" not in block or block.lstrip().startswith("if (")
    return html


def build_icons():
    from PIL import Image, ImageDraw
    out = {}
    for size, name in ((512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon.png")):
        s = 4  # supersample
        im = Image.new("RGB", (size * s, size * s), "#1f4fae")
        d = ImageDraw.Draw(im)
        c = size * s / 2
        rings = [0.16, 0.29, 0.41]
        for r in rings:
            rr = r * size * s
            d.ellipse([c - rr, c - rr, c + rr, c + rr], outline="#7fa6ec", width=max(2, size * s // 140))
        import math
        dots = [(0, 0, "#ffffff"), (0.16, 30, "#ffd166"), (0.16, 210, "#ffd166"), (0.29, 80, "#c39bd3"),
                (0.29, 260, "#c39bd3"), (0.29, 330, "#c39bd3"), (0.41, 10, "#f5a65b"), (0.41, 140, "#5fd3b3"), (0.41, 230, "#f06b6b")]
        pts = []
        for r, a, col in dots:
            x = c + r * size * s * math.cos(math.radians(a))
            y = c + r * size * s * math.sin(math.radians(a))
            pts.append((x, y, col))
        for i, j in ((0, 1), (0, 2), (1, 3), (2, 4), (1, 5), (3, 6), (5, 7), (4, 8)):
            d.line([pts[i][:2], pts[j][:2]], fill="#dfe8fb", width=max(2, size * s // 90))
        for x, y, col in pts:
            rr = size * s * (0.07 if col == "#ffffff" else 0.045)
            d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=col)
        out[name] = im.resize((size, size), Image.LANCZOS)
    return out


def main():
    html = build_html()
    version = hashlib.sha1(html.encode()).hexdigest()[:10]
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    for name, im in build_icons().items():
        im.save(os.path.join(OUT, name))
    manifest = {
        "name": "Research Map", "short_name": "Research Map",
        "description": "Map research articles onto drugs, targets and pathways, with Claude built in.",
        "start_url": "./", "scope": "./", "display": "standalone", "orientation": "any",
        "background_color": "#f6f7f9", "theme_color": "#2f6fde",
        "icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
                  {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"}],
    }
    with open(os.path.join(OUT, "manifest.webmanifest"), "w") as f:
        json.dump(manifest, f, indent=2)
    with open(os.path.join(IPAD, "sw.js")) as f:
        sw = f.read().replace("__VERSION__", version)
    with open(os.path.join(OUT, "sw.js"), "w") as f:
        f.write(sw)
    with open(os.path.join(OUT, ".nojekyll"), "w") as f:
        f.write("")
    os.makedirs(DIST, exist_ok=True)
    zpath = os.path.join(DIST, "research-map-ipad.zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(os.listdir(OUT)):
            z.write(os.path.join(OUT, name), os.path.join("research-map-ipad", name))
        z.write(os.path.join(IPAD, "README.md"), os.path.join("research-map-ipad", "README.md"))
    shutil.copy(os.path.join(OUT, "index.html"), os.path.join(DIST, "research-map-ipad.html"))
    print(f"built {OUT}/index.html ({len(html) // 1024} KB), {zpath}")


if __name__ == "__main__":
    main()
