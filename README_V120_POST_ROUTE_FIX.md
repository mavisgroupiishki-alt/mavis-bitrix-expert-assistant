# v120 POST ROUTE FIX

Bitrix24 can open a local app placement by POSTing to `/doc-return-report`.
This version explicitly serves the report page on both GET and POST at the top-level Express app, preventing `Cannot POST /doc-return-report`.
