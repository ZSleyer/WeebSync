// Package docs embeds the generated OpenAPI spec and the vendored Swagger UI.
// The spec is regenerated from the swaggo annotations by ./gen-docs.sh.
package docs

import "embed"

// SwaggerJSON is the generated OpenAPI 3.1 spec (see gen-docs.sh).
//
//go:embed swagger.json
var SwaggerJSON []byte

// SwaggerUI holds the vendored Swagger UI assets, served only by dev builds.
//
//go:embed swaggerui
var SwaggerUI embed.FS
