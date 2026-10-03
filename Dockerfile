# Optional Docker deploy path (Render: runtime docker). Native Python + uv.lock is preferred.
FROM python:3.14-slim

COPY --from=ghcr.io/astral-sh/uv:0.12.10 /uv /uvx /bin/

WORKDIR /app

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock README.md ./
COPY src ./src
COPY frontend ./frontend

RUN uv sync --frozen --no-dev

ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000

CMD ["sh", "-c", "uvicorn fixitnyc.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
