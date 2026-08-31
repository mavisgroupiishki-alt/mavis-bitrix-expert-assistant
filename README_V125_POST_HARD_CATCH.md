# v125 POST HARD CATCH

Fixes recurring `Cannot POST /doc-return-report`.

- Registers a top-level `app.use` catch-all for `/doc-return-report` and `/doc-return-report/`, so GET/POST/HEAD and other methods all serve the report page.
- Adds `/api/doc-return-report/build` returning `{ build: "v125-POST-HARD-CATCH" }` so the deployed runtime can be verified unambiguously.
- Sends `X-Mavis-Doc-Return-Build: v125-POST-HARD-CATCH` on the report page.
- Bumps report JS cache key to v125.
