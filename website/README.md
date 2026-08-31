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
  blog.html                 # post listing: title, date, one-line summary, link per post
  feed.xml                  # RSS 2.0 feed for the seed posts
  posts/
    introducing-relay.html        # what Relay is, a run end to end, the release boundary
    inside-the-orchestrator.html  # read-only planning, plan validation, fallback, blockers, actions
    worktree-isolation.html       # one worktree per task, validated names, refused removals
  assets/
    relay-site.css          # the site-wide stylesheet (hand-written, no preprocessor)
    relay-blog.css          # blog-only rules, loaded after relay-site.css on blog pages
    relay-site.js           # small vanilla enhancement layer
    logo.svg                # copied from src/renderer/src/assets/relay-logo.svg
  README.md
```

`assets/relay-blog.css` holds only the listing and article rules (`.post-list`, `.post-card`,
`.article`, `.back-link`). It reuses the custom properties and the `.shell`, `.section`, `.pill`,
`.card`, and `.button` classes from `assets/relay-site.css` instead of redefining them, so blog
pages link both files in that order.

`feed.xml` uses relative item links and `urn:relay:post:*` guids with `isPermaLink="false"`, so it
stays domain-agnostic like the rest of the site.

## Viewing it

Every link, stylesheet, script, and image reference is relative, so both of these work:

```bash
open website/index.html          # file:// — no server needed

python3 -m http.server 8080 --directory website   # http://localhost:8080
```

## Constraints this site keeps

- **Plain HTML5.** No framework, no templating, no bundler.
- **Hand-written CSS, one JS file.** `relay-site.css` is the whole site; `relay-blog.css` adds only
  the blog listing and article rules on top of it. Both are readable, and there is one JS file.
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
| `posts/introducing-relay.html` — positioning, prerequisites, run modes, architecture, lifecycle | `README.md` |
| `posts/introducing-relay.html` — unsigned package and deferred distribution | `RELEASE_CHECKLIST.md` |
| `posts/inside-the-orchestrator.html` — intelligent orchestration, control protocol, memory and recovery | `README.md` |
| `posts/inside-the-orchestrator.html` — action allowlist, receipts, watchdogs, control replay | `RELEASE_CHECKLIST.md` |
| `posts/worktree-isolation.html` — worktree safety, integration lifecycle, safety boundaries | `README.md` |
| `posts/worktree-isolation.html` — packaged run, review through cleanup, safety and errors | `FULL_E2E_CHECKLIST.md` |
| `blog.html` and `feed.xml` post titles, dates, summaries | The post pages in `posts/` |

Blog posts carry no author byline and no invented dates, claims, or links: each post date matches the
repository work it describes, and every statement traces back to one of the files above.

**Release status is deliberate:** the site states plainly that macOS signing, notarization, and
public distribution are deferred and that no downloadable release exists. Do not add a download
button until that changes.

## Logo

`assets/logo.svg` reuses the three geometric paths from
`src/renderer/src/assets/relay-logo.svg` verbatim. Those paths are white with partial opacity, so
they are invisible on a light page; the copy adds the rounded radial-gradient plate and `#554AF2`
stroke from `build/relay-app-icon.svg` behind them, making the mark self-contained on any
background. The original renderer asset is untouched.
