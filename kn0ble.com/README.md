# KN0BLE.com

Main homepage for amateur radio callsign KN0BLE. Plain static HTML/CSS,
hosted on GitHub Pages, no build step. Deliberately minimal -- just the
two QSL tools, no bio/station/log/gallery content.

## Structure

- `index.html` -- Home page: address lookup (via the QSL Tracker),
  a "request a card from KN0BLE" form, and a link to the QSL Photo Map.
- `css/style.css` -- Shared styling for every page (dark theme).
- `images/` -- Unused for now.
- `CNAME` -- Tells GitHub Pages to serve this site at `kn0ble.com`. Don't
  delete it or the custom domain breaks.
- `404.html` -- GitHub Pages automatically serves this for unknown paths.

## Editing

No build step, no dependencies -- just edit the HTML files directly and
push. Every page repeats the same header/nav/footer markup (no shared
templating without a build step), so a nav change means editing it in
each `.html` file.

## Deploying

Pushing to `main` is enough -- GitHub Pages (once enabled in the repo's
Settings -> Pages) rebuilds automatically on every push. See the
project notes for the exact DNS setup on the kn0ble.com domain (GoDaddy).

## Related

- [QSL Tracker](https://qsl.kn0ble.com) -- separate app/repo,
  linked from the nav on every page here. Also serves the QSL Photo Map
  at `/photomap`.
