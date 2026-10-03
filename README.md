# FixItNYC API

FastAPI backend for NYC issue reporting with Supabase Auth, staff queues, and Vortex chat.

## Setup

1. Copy `.env.example` to `.env` and fill in values from the FixitNYC Supabase project:
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY` (publishable or legacy anon key)
   - `SUPABASE_SECRET_KEY` (service role / secret — server only)
   - `ANTHROPIC_API_KEY` (required for Vortex)
   - `VORTEX_MODEL` (optional; default `claude-haiku-4-5`)
   - `BOOTSTRAP_STAFF_EMAILS` (comma-separated emails that register as staff)
2. In the Supabase dashboard, disable **Auth → Providers → Email → Confirm email** for local register/login.
3. Install and run:

```bash
uv sync
uv run uvicorn fixitnyc.main:app --reload --host 0.0.0.0 --port 8000
```

Open API docs at `http://127.0.0.1:8000/docs`.

Smoke script (server must be running with a complete `.env`):

```bash
./scripts/smoke_test.sh
```

## Prototype frontend

A simple vanilla HTML/CSS/JS UI lives in `frontend/`. It is mounted by the API at `/ui` (same origin), so no separate build step is required.

1. Start the API (see above).
2. Open `http://127.0.0.1:8000/ui/` (or `/` which redirects there).

Features wired to the API:

- Auth: register, login, logout, current user (`/auth/me`)
- Settings: update name/email, change password
- Client: submit report (multipart + image), list my reports, report detail (image via signed URL)
- Staff (nav only when `role=staff`): all reports (detail + image, status/priority), summary, accounts list/update, Vortex chat
  - Report statuses: `submitted`, `reviewed`, `in_progress`, `canceled`, `done`

Optional: serve `frontend/` from another local static server and pass the API base, e.g. open the page with `?api=http://127.0.0.1:8000`. CORS allows common local origins (`8000`, `5500`, `5173`).

Live auth/reports need a valid `.env` with Supabase keys. Without keys the API will not start; the static UI files still load if you open them separately, but API calls will fail.

## Key routes

- Auth: `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`
- Settings: `PATCH /settings`, `POST /settings/password`
- Client reports: `POST /reports`, `GET /reports`, `GET /reports/{id}`
- Staff: `GET /staff/reports`, `GET /staff/reports/summary`, `GET|PATCH /staff/reports/{id}`, `GET|PATCH /staff/accounts[...]`
- Vortex (staff): `GET /vortex/conversations`, `POST /vortex/conversations`, `GET /vortex/transcript`, `POST /vortex/chat` (turns persist in `vortex_messages`)
- Health: `GET /health`

## Deploy on Render

This repo includes a Blueprint (`render.yaml`), optional `Dockerfile`, and `Procfile`.

1. Push to GitHub (`main`).
2. In [Render](https://dashboard.render.com): **New → Blueprint** and select this repo, **or** **New → Web Service** with:
   - Runtime: Python
   - Build: `uv sync --frozen`
   - Start: `uv run uvicorn fixitnyc.main:app --host 0.0.0.0 --port $PORT`
   - Health check path: `/health`
3. Set these environment variables (from `.env.example`; do not commit `.env`):

| Variable | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | yes | Publishable / anon key |
| `SUPABASE_SECRET_KEY` | yes | Service role — server only |
| `ANTHROPIC_API_KEY` | for Vortex | Chat fails without it |
| `VORTEX_MODEL` | no | Default `claude-haiku-4-5` |
| `BOOTSTRAP_STAFF_EMAILS` | no | Comma-separated staff emails |
| `CORS_ORIGINS` | no | Extra origins; `/ui` is same-origin |
| `PYTHON_VERSION` | no | Blueprint sets `3.14.0` |

Open the service URL (UI at `/ui/`, docs at `/docs`).

**Note:** `pyproject.toml` includes `torch` / `torchvision` / `scikit-learn`. Builds are large and may exceed free-tier disk/time; upgrade the instance or trim unused ML deps if the build fails.
