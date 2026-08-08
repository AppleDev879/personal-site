# abarrett.io

Personal landing page. Static — no build step, no dependencies, no framework.

```
public/
  index.html    markup + pre-paint theme resolution
  styles.css    tokens, layout, type, entrance animation
  main.js       generative ink field + color-scheme toggle
  favicon.svg   theme-aware
  fonts/        Geist + Geist Mono (variable, self-hosted, OFL)
render.yaml     Render blueprint
```

## Run locally

```sh
python3 -m http.server 8000 --directory public
```

Then open http://localhost:8000.

## Deploy

Render static site, from `render.yaml`:

- **Publish directory** `public`
- **Build command** none

Push to `main` and Render redeploys. To point `abarrett.io` at it, add the
custom domain in the Render dashboard and follow the DNS records it prints.

## Notes

- The canvas is the theme toggle — click or focus + Enter. The choice is kept
  in `localStorage`; `?theme=light` / `?theme=dark` forces one for a visit.
- Dark is the default. Theme resolves in a blocking inline script so there is
  no flash on load.
- `prefers-reduced-motion` disables the entrance animation and renders the ink
  field as a single settled frame instead of animating.
