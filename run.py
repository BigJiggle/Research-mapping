"""Start Research Map locally:  python run.py   then open http://127.0.0.1:8000"""
import os
import webbrowser

import uvicorn

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    if os.environ.get("NO_BROWSER") != "1":
        webbrowser.open(f"http://{host}:{port}")
    uvicorn.run("app.main:app", host=host, port=port)
