# Security

Report vulnerabilities privately to **grousson.dylan@gmail.com**, the project
maintainer's contact. Include the affected version or commit, impact, and steps
to reproduce using synthetic or sanitized data. Do not open a public issue with
exploit details or authentication credentials.

Do not attach tokens, cookies, raw HAR files, or personal account exports. HARs
can contain credentials in headers, URLs, and response bodies even when some
fields have been sanitized. A small fictional dataset is usually sufficient to
reproduce a solver problem.

Kyara requests are read-only. The browser extension keeps credentials inside the
Kyara tab and stores datasets, holdings, and wishlists locally. Backups can contain
private holdings and wishlist information; review them before sharing. There is
no project-operated solver server.

Use the latest code on `main` when checking whether a problem is still present;
older versions do not have a separate security-maintenance commitment. Report
ordinary bugs through the [issue tracker](https://github.com/diaarca/kyara-solver/issues).
