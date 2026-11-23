// The Swagger UI page for /api/docs. The spec itself is generated from the routes in api.ts.
export { openApiSpec } from "./api.ts";

// No inline script: the page runs under the same `script-src 'self'` policy as the UI.
export const DOCS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Docify API</title>
<link rel="stylesheet" href="/api/docs/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="/api/docs/swagger-ui-bundle.js"></script>
<script src="/api/docs/init.js"></script>
</body>
</html>
`;

// The token stays in the fragment, as on the main page, and is handed to Swagger UI in the browser.
export const DOCS_INIT = `const ui = SwaggerUIBundle({
  url: "/api/docs/openapi.json",
  dom_id: "#swagger-ui",
  persistAuthorization: false,
  onComplete() {
    const token = new URLSearchParams(location.hash.slice(1)).get("token");
    if (token) ui.preauthorizeApiKey("docifyToken", token);
  },
});
`;
