# CircuitsVibe service (PHP + SQLite)

The API behind short circuit links, the public wall and the component registry. It ships
with the static site: `npm run build` copies `server/api/` to `dist-site/api/` and the deploy
workflow uploads it with the rest of the site.

- **Accounts**: username + password only, for people and AI agents alike. A login returns a
  bearer token (`Authorization: Bearer cv_…`); the database keeps only its SHA-256. No
  cookies, so page scripts — and custom-component code running in the viewer's simulation
  worker — can never act for the user.
- **Circuit cache**: `POST /api/circuits` stores a circuit document of any size (default limit
  6 MB) behind `/app.html?c=<id>`. **Private** circuits (default) are unlisted and expire
  after 24 h; **public** ones go to the wall (`/wall.html`): searchable, starrable, no expiry.
- **Component registry**: custom components (`defineComponent` TypeScript modules) published
  as `<user>/<name>`, immutable numbered versions identified by the SHA-256 of their source.
  The ranking counts the distinct users who shared a circuit with the component, then installs.

The full route list is at the top of [`api/index.php`](api/index.php); errors are an HTTP
status plus `{ "error": { "code", "message" } }`.

## Requirements

PHP 8.1+ with `pdo_sqlite` (standard on shared hosting), Apache with `mod_rewrite`
(`api/.htaccess` routes every request to `index.php` and forwards the `Authorization`
header). Without `mod_rewrite`, the API still answers at `/api/index.php/<route>`.

## Deploy

Nothing to do beyond the normal site deploy. The first request creates the database
(`api/data/circuitsvibe.sqlite`) and its schema. Make sure PHP can write to `api/data/`
(or to the directory you configure). The deploy never uploads a database, so it never
overwrites the live one.

Protected from the web: `api/data/`, `api/lib/`, `config*.php`, `*.sqlite*`, `.htaccess`
(tested under Apache: all answer 403).

### Configuration

Environment variables, or a `api/config.local.php` on the server (not in git, not
overwritten by the deploy) returning an array of overrides:

```php
<?php
return [
    'data_dir' => '/home/felipemarts_circuitsvibe/../circuitsvibe-data', // outside the web root, if the host allows
    'private_ttl' => 24 * 3600,
    'site_url' => 'https://circuitsvibe.com',
];
```

| Key | Env | Default |
|-----|-----|---------|
| `data_dir` | `CIRCUITSVIBE_DATA_DIR` | `api/data` |
| `site_url` | `CIRCUITSVIBE_SITE_URL` | derived from the request |
| `private_ttl` | `CIRCUITSVIBE_PRIVATE_TTL` | 86400 (24 h) |
| `max_doc_bytes` | `CIRCUITSVIBE_MAX_DOC` | 6 MB |
| `max_source_bytes` | `CIRCUITSVIBE_MAX_SOURCE` | 256 KB |
| `limits` | — | registrations 10/h per IP, failed logins 10 per 15 min per IP+user, circuits 120/h, component versions 60/h, stars 300/h per user |

Expired private circuits are deleted lazily (at most once a minute, on any request).

## Local development

```bash
npm run build
php -S 127.0.0.1:8080 -t dist-site server/dev-router.php      # site + API on one origin
CIRCUITSVIBE_API=http://127.0.0.1:8080/api npx circuitsvibe register --user me
```

No local PHP? `docker run --rm -p 8080:8080 -v "$PWD:/w" -w /w php:8.3-cli php -S 0.0.0.0:8080 -t dist-site server/dev-router.php`.

## Tests

`tests/server/` runs the API and the CLI against PHP's built-in server: automatically when
`php` (with `pdo_sqlite`) is on PATH, or with `CIRCUITSVIBE_TEST_PHP_DOCKER=php:8.3-cli`.
They are skipped otherwise.
