#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8000}"
CLIENT_EMAIL="${CLIENT_EMAIL:-client_smoke@example.com}"
STAFF_EMAIL="${STAFF_EMAIL:-staff@example.com}"
PASSWORD="${PASSWORD:-Password123!}"
IMG="${IMG:-/tmp/fixitnyc-smoke.png}"

if [[ ! -f "$IMG" ]]; then
  python - <<'PY'
from pathlib import Path
# Minimal 1x1 PNG
Path("/tmp/fixitnyc-smoke.png").write_bytes(
    bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
    )
)
PY
fi

echo "== health =="
curl -fsS "$BASE_URL/health"
echo

echo "== register client =="
CLIENT_JSON=$(curl -fsS -X POST "$BASE_URL/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$CLIENT_EMAIL\",\"password\":\"$PASSWORD\",\"full_name\":\"Smoke Client\"}")
CLIENT_TOKEN=$(python - <<PY
import json,sys
print(json.loads('''$CLIENT_JSON''')["session"]["access_token"])
PY
)
echo "client token acquired"

echo "== register staff =="
STAFF_JSON=$(curl -fsS -X POST "$BASE_URL/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$STAFF_EMAIL\",\"password\":\"$PASSWORD\",\"full_name\":\"Smoke Staff\"}")
STAFF_TOKEN=$(python - <<PY
import json
print(json.loads('''$STAFF_JSON''')["session"]["access_token"])
PY
)
echo "staff token acquired"

echo "== submit report =="
REPORT_JSON=$(curl -fsS -X POST "$BASE_URL/reports" \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -F "address_area=123 Broadway" \
  -F "city=Manhattan" \
  -F "name=Broken sidewalk" \
  -F "problem_type=infrastructure" \
  -F "additional_info=Near the subway entrance" \
  -F "image=@${IMG};type=image/png")
REPORT_ID=$(python - <<PY
import json
print(json.loads('''$REPORT_JSON''')["id"])
PY
)
echo "report $REPORT_ID"

echo "== staff list =="
curl -fsS "$BASE_URL/staff/reports" -H "Authorization: Bearer $STAFF_TOKEN" | head -c 400
echo

echo "== staff summary =="
curl -fsS "$BASE_URL/staff/reports/summary" -H "Authorization: Bearer $STAFF_TOKEN"
echo

echo "== patch status/priority =="
curl -fsS -X PATCH "$BASE_URL/staff/reports/$REPORT_ID" \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"reviewed","priority":"high"}'
echo

echo "== settings =="
curl -fsS -X PATCH "$BASE_URL/settings" \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"full_name":"Smoke Client Updated"}'
echo

echo "== vortex on-topic =="
curl -fsS -X POST "$BASE_URL/vortex/chat" \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"How many infrastructure reports are high priority?"}'
echo

echo "== vortex off-topic =="
curl -fsS -X POST "$BASE_URL/vortex/chat" \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Write me a poem about cats."}'
echo

echo "Smoke test completed."
