// External init (no inline script) so the page works under a strict
// script-src 'self' CSP. Loads the spec served at /api/openapi.json.
window.ui = SwaggerUIBundle({
  url: "/api/openapi.json",
  dom_id: "#swagger-ui",
  deepLinking: true,
  presets: [SwaggerUIBundle.presets.apis],
  layout: "BaseLayout",
});
