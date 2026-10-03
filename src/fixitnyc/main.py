import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from fixitnyc.config import get_settings
from fixitnyc.routers import auth, reports, staff
from fixitnyc.vortex import router as vortex_router

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"

_LOCAL_CORS_ORIGINS = [
    "http://127.0.0.1:8000",
    "http://localhost:8000",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
]


def _cors_origins() -> list[str]:
    """Same-origin /ui needs no CORS; allow extras via env + Render URL."""
    origins = list(_LOCAL_CORS_ORIGINS)
    extra = os.getenv("CORS_ORIGINS", "")
    if extra.strip():
        origins.extend(
            part.strip() for part in extra.split(",") if part.strip()
        )
    render_url = os.getenv("RENDER_EXTERNAL_URL", "").rstrip("/")
    if render_url:
        origins.append(render_url)
    # Preserve order while dropping duplicates.
    return list(dict.fromkeys(origins))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    get_settings()
    yield


app = FastAPI(
    title="FixItNYC API",
    description="Backend for NYC issue reporting, staff queues, and Vortex chat.",
    version="0.1.0",
    lifespan=lifespan,
)

# Prototype UI may also be opened from another local origin (e.g. python -m http.server).
# Production UI is served at /ui on the same host (relative API calls; CORS not required).
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(auth.settings_router)
app.include_router(reports.router)
app.include_router(staff.router)
app.include_router(vortex_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def root() -> RedirectResponse:
    return RedirectResponse(url="/ui/")


if FRONTEND_DIR.is_dir():
    app.mount("/ui", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="ui")
