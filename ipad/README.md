# Research Map for iPad

The iPad edition runs entirely in Safari. Your iPad doesn't need Python or a server. It's the same app as the desktop version:
- the interactive map
- AI extraction, descriptions and chat
- the dose calculator

Your map is stored in the browser on your iPad, and Claude is called directly with your own API key.

## Install on your iPad

The app has to be opened from a web address (Safari won't run an HTML file straight from the Files app). Either of these works:

**Option A – GitHub Pages (free, recommended)**
1. In this repository on GitHub, go to **Settings → Pages**.
2. Under *Build and deployment*, choose **Deploy from a branch**, pick this branch and the **/docs** folder, then **Save**.
3. After a minute GitHub shows the site address (`https://<you>.github.io/<repo>/`). Open it in **Safari** on the iPad.
4. Tap **Share → Add to Home Screen**. It now opens full-screen like an app, and works offline for browsing your map.

**Option B – any static host**
Unzip `research-map-ipad.zip` and upload the folder to any static web host (Netlify, Cloudflare Pages, your own server). Then open it in Safari and **Add to Home Screen**.

## First run
1. Tap **Settings** (or the red **AI** pill) and paste your Claude API key (from console.anthropic.com).
2. Tap **Test key**, then **Save**.
3. Paste a PMID, PubMed link or DOI into the box at the top.

The key never leaves your iPad except to go to `api.anthropic.com`.

## Notes
- **Moving maps between iPad and desktop:** use **Export** on one and **Import** on the other. Both versions read the same file.
- **Back up with Export now and then.** Safari keeps the map until you clear the site's data.
- **Sources:** PubMed, PMC and DOIs are fetched directly. Some sites (arXiv, many journal pages) block direct requests from a browser. For those, Claude fetches the page for you (needs the API key). You can also use **More…** to paste text or upload a PDF.
- **Portrait mode:** tap **☰ Filters** to open the filter drawer.

## Rebuilding (developers)
```bash
python ipad/build.py                 # -> docs/ and dist/research-map-ipad.zip
# to update the bundled Claude SDK:
npm i @anthropic-ai/sdk esbuild
npx esbuild ipad/sdk-entry.js --bundle --minify --format=iife --platform=browser --target=safari15 --outfile=ipad/vendor/anthropic-sdk.js
```
