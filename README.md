# abarrett.io

Personal landing page. Static — no build step, no dependencies, no framework.

```
public/
  index.html    markup + pre-paint theme resolution
  styles.css    tokens, layout, type, entrance animation
  main.js       generative ink field + color-scheme toggle
  favicon.svg   theme-aware
  CNAME         custom domain claim for GitHub Pages
  fonts/        Geist + Geist Mono (variable, self-hosted, OFL)
.github/workflows/deploy.yml
```

## Run locally

```sh
python3 -m http.server 8000 --directory public
```

Then open http://localhost:8000.

## Deploy

GitHub Pages, via `.github/workflows/deploy.yml` — push to `main` and the
workflow uploads `public/` and deploys it. Pages source must be set to
**GitHub Actions** (not a branch).

`abarrett.io` is served through Cloudflare, which proxies to GitHub Pages.
DNS lives in Cloudflare and does not need to change when the serving repo
changes — Pages routes by the custom domain claim, which is `public/CNAME`
plus the domain set in this repo's Pages settings. Only one repo may claim
the domain at a time.

## Notes

- The canvas is the theme toggle — click or focus + Enter. The choice is kept
  in `localStorage`; `?theme=light` / `?theme=dark` forces one for a visit.
- Dark is the default. Theme resolves in a blocking inline script so there is
  no flash on load.
- `prefers-reduced-motion` disables the entrance animation and renders the ink
  field as a single settled frame instead of animating.
