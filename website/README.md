# Relay website

A self-contained static marketing/docs site for Relay. It is intentionally separate from the
application: no build step, no dependencies, no npm scripts, and nothing here is imported by
`src/`.

## Files

```text
website/
  index.html                # overview: hero, how it works, capability grid, local-first
  features.html             # deeper subsystem sections
  docs.html                 # getting started, verification, workspace, packaging, release boundary
  assets/
    relay-site.css          # the entire stylesheet (hand-written, no preprocessor)
    relay-site.js           # small vanilla enhancement layer
    logo.svg                # copied from src/renderer/src/assets/relay-logo.svg
  README.md
```

## Viewing it

Every link, stylesheet, script, and image reference is relative, so both of these work:

```bash
open website/index.html          # file:// — no server needed

python3 -m http.server 8080 --directory website   # http://localhost:8080
```

## Constraints this site keeps

- **Plain HTML5.** No framework, no templating, no bundler.
- **One CSS file, one JS file.** Both hand-written and readable.
- **No network at runtime.** No CDN stylesheets, fonts, analytics, or `fetch` calls. Typography
  uses the system UI and monospace font stacks.
- **Relative links only.** Nothing assumes a domain or a server root.
- **Progressive enhancement.** The pages are fully readable with JavaScript disabled. The script
  only adds the theme toggle, the mobile nav, code copy buttons, scroll reveals, and docs
  table-of-contents highlighting. `localStorage` and the clipboard API are both wrapped in
  fallbacks because they are restricted under `file://`.
- **Accessibility basics.** Skip link, landmark elements, labelled controls, visible focus rings,
  `prefers-reduced-motion` and `prefers-color-scheme` support.

## Content sourcing

All claims come from files already in this repository, so the site should be updated when they
change:

| Site content | Source |
| --- | --- |
| Positioning, orchestration/safety/lifecycle copy, architecture tree, hive layout | `README.md` |
| Product name, version `0.1.0`, npm scripts, prerequisites | `package.json`, `README.md` |
| Verification gates, unsigned artifact names, deferred distribution work | `RELEASE_CHECKLIST.md` |
| Packaged acceptance pass description | `FULL_E2E_CHECKLIST.md` |

**Release status is deliberate:** the site states plainly that macOS signing, notarization, and
public distribution are deferred and that no downloadable release exists. Do not add a download
button until that changes.

## Logo

`assets/logo.svg` reuses the three geometric paths from
`src/renderer/src/assets/relay-logo.svg` verbatim. Those paths are white with partial opacity, so
they are invisible on a light page; the copy adds the rounded radial-gradient plate and `#554AF2`
stroke from `build/relay-app-icon.svg` behind them, making the mark self-contained on any
background. The original renderer asset is untouched.
