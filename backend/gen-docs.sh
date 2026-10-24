#!/usr/bin/env sh
# Regenerate the OpenAPI spec from the swaggo annotations. Deterministic, so CI
# can run it and diff docs/ to keep the checked-in spec in sync with the code.
set -e
cd "$(CDPATH= cd "$(dirname "$0")" && pwd)"

go tool swag init -g main.go -o docs --v3.1 --parseInternal >/dev/null

# swag v2.0.0-rc5 emits only the first apikey securityDefinition, and that one
# with the wrong place: CookieAuth comes out as {in: header, name:
# Authorization}. Both schemes are written here as main.go declares them: the
# session cookie, and the machine BearerAuth scheme (used by /api/status and
# the watch check).
python3 - <<'PY'
import json
p = "docs/swagger.json"
with open(p, encoding="utf-8") as f:
    spec = json.load(f)
spec["components"]["securitySchemes"]["CookieAuth"] = {
    "type": "apiKey", "in": "cookie", "name": "weebsync_session",
    "description": "The session cookie: weebsync_session over plain HTTP, __Host-weebsync_session under HTTPS.",
}
spec["components"]["securitySchemes"]["BearerAuth"] = {
    "type": "apiKey", "in": "header", "name": "Authorization",
}
with open(p, "w", encoding="utf-8") as f:
    json.dump(spec, f, indent=4, ensure_ascii=False)
    f.write("\n")
PY

# Only swagger.json is embedded/served; drop the extras swag also writes.
rm -f docs/swagger.yaml docs/docs.go

# swag marks no field required and none nullable; derive both from the structs
# so the generated frontend types match what the handlers send.
go run ./cmd/openapi-tighten docs/swagger.json
