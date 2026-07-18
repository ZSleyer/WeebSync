#!/usr/bin/env sh
# Regenerate the OpenAPI spec from the swaggo annotations. Deterministic, so CI
# can run it and diff docs/ to keep the checked-in spec in sync with the code.
set -e
cd "$(CDPATH= cd "$(dirname "$0")" && pwd)"

go tool swag init -g main.go -o docs --v3.1 --parseInternal >/dev/null

# swag v2.0.0-rc5 emits only the first apikey securityDefinition; the machine
# BearerAuth scheme (used by /api/status and the watch check) is added back here.
python3 - <<'PY'
import json
p = "docs/swagger.json"
with open(p, encoding="utf-8") as f:
    spec = json.load(f)
spec["components"]["securitySchemes"]["BearerAuth"] = {
    "type": "apiKey", "in": "header", "name": "Authorization",
}
with open(p, "w", encoding="utf-8") as f:
    json.dump(spec, f, indent=4, ensure_ascii=False)
    f.write("\n")
PY

# Only swagger.json is embedded/served; drop the extras swag also writes.
rm -f docs/swagger.yaml docs/docs.go
