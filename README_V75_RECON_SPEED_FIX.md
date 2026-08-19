# v75 — Monthly originals reconciliation speed fix

- Manual reconciliation no longer downloads up to 5000 tasks from project #36 before responding.
- First loads successful Production deals for the requested month.
- Then searches act tasks directly by `GROUP_ID` + `UF_CRM_TASK=D_<dealId>` with concurrency 6.
- Only when the CRM link is absent, performs a title fallback search.
- Adds progress logs and `durationMs` to the JSON response.
- Manual mode remains `send=0` by default; no automatic month-end schedule is enabled yet.
