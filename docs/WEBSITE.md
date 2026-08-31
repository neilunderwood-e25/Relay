# Static website preview

The repository includes a zero-dependency HTTP server for previewing a static site directory locally. By convention it serves `website/` from the repository root:

```sh
npm run site:dev
```

The command prints the listening URL and keeps running until you press Ctrl+C. Requests for directories serve their `index.html`. The preview server recognizes HTML, CSS, JavaScript (`.js` and `.mjs`), SVG, PNG, JPEG, WebP, ICO, JSON, XML, Atom, plain-text, and WOFF2 files by extension; other files use `application/octet-stream`.

To preview a different directory, pass it after `--` or set `SITE_ROOT`:

```sh
npm run site:dev -- ./path/to/static-files
SITE_ROOT=./path/to/static-files npm run site:dev
```

The server listens on `127.0.0.1:4173` by default. Override the port with `--port` or `PORT`; port `0` asks the operating system for an available port. Use `--host` when access from another interface is intentionally required.

```sh
npm run site:dev -- ./public --port 8080
PORT=8080 npm run site:dev
node scripts/serve-site.mjs ./public --host 0.0.0.0 --port 4173
```

If the selected directory does not exist, the command identifies the missing path and explains how to select another one.
