# Xpert brand

The platform's brand (adopted 2026-10-29, team trial round 9). Every file here is redrawn as vectors from the brand sheet
the team supplied: the shapes follow the sheet to within a fraction of a pixel and the colours are sampled from it.
Use the SVG files wherever possible; they stay sharp at any size.

| File | Use |
| --- | --- |
| `xpert-logo.svg` | Logo on light backgrounds |
| `xpert-logo-white.svg` | Logo on dark backgrounds (white lettering, brighter blues) |
| `xpert-logo-tagline.svg`, `xpert-logo-tagline-white.svg` | Logo with "CONNECT • COMMUNICATE • GROW", for documents, slides and large headers |
| `xpert-mark.svg`, `xpert-mark-white.svg` | The X alone, where there is no room for the name |
| `xpert-app-icon.svg` | App icon: the X on a navy rounded square (browser tab icon, phone home screen) |
| `*.png` | Ready-made PNGs with transparent backgrounds (logos 2400 px wide, app icon 1024 px) |

## Palette

| Name | Hex |
| --- | --- |
| Deep Navy | `#0B2D6B` |
| Turquoise | `#00C6D7` |
| Tech Blue | `#1E73EB` |
| Light Gray | `#F2F6FA` |

The logo artwork carries its own gradients (sampled from the sheet). The app's interface colours are unchanged; they
stay in `web/src/styles/tokens.css`.

## Rules

- Keep the logo's proportions and colours; do not recolour, stretch or add effects.
- Keep clear space around the logo at least as wide as the stem of the "p".
- Below about 90 px wide, use the X mark instead of the full logo.
- The tagline is part of the large logo only. In the app it is too small to read, so the app shows the logo without it.

## Where the app uses it

- Top bar, sign-in and Change Password screens, customer portal: `web/src/ui/BrandLogo.tsx`. It loads the files in
  `web/src/assets/brand` and shows the navy or white version to suit the theme (`web/src/styles/brand.css`).
- Browser tab icon and phone home-screen icon: `web/public/favicon.svg`, `favicon.ico`, `apple-touch-icon.png`.
- Window titles end in "· Xpert". Authenticator apps list new enrolments as "Xpert". E-mails go out from "Xpert"
  (`smtp_from_name` in `deploy/ansible/group_vars/all.yml`).

The lettering is drawn shapes, not a font, so the logo needs no font installed. The tagline is set in Poppins Medium
(SIL Open Font License) and converted to outlines.
