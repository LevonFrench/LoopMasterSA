# Browser dependencies

The browser bundles in this directory are pinned copies from their official npm
packages:

- `html2canvas-1.4.1.min.js` — `html2canvas` 1.4.1; see
  `HTML2CANVAS-LICENSE` (MIT).
- `jszip-3.10.1.min.js` — `jszip` 3.10.1; see `JSZIP-LICENSE.markdown`
  (MIT or GPLv3).

Keep the version in each filename and its adjacent license in sync when
upgrading. The application references these files locally, and its CSP restricts
scripts to `'self'`, so screenshot and ZIP export no longer require a CDN.

The previous Google Fonts CSS import was also removed. The interface uses local
system font stacks and makes no runtime font request.
