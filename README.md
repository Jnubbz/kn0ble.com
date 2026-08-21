# KN0BLE.com

Main homepage for amateur radio callsign KN0BLE. Plain static HTML/CSS,
hosted on GitHub Pages, no build step.

## Structure

- `index.html` -- About / home page
- `station.html` -- Equipment and operating notes
- `awards.html` -- DXCC / awards progress
- `log.html` -- Dated notes, newest first
- `gallery.html` -- Photos
- `css/style.css` -- Shared styling for every page
- `images/` -- Drop photo files in here, reference them from `gallery.html`
  (or anywhere else) with `<img src="images/yourfile.jpg" alt="...">`
- `CNAME` -- Tells GitHub Pages to serve this site at `kn0ble.com`. Don't
  delete it or the custom domain breaks.
- `404.html` -- GitHub Pages automatically serves this for unknown paths.

## Editing

No build step, no dependencies -- just edit the HTML files directly and
push. Every page repeats the same header/nav/footer markup (no shared
templating without a build step), so a nav change means editing it in
each `.html` file.

Look for `[bracketed placeholder text]` -- that's every spot in the
current pages that still needs your real content (bio, callsign details,
equipment, awards, log entries, photos).

## Deploying

Pushing to `main` is enough -- GitHub Pages (once enabled in the repo's
Settings -> Pages) rebuilds automatically on every push. See the
project notes for the exact DNS setup on the kn0ble.com domain (GoDaddy).

## Related

- [QSL Tracker](https://qsl-tracker.onrender.com) -- separate app/repo,
  linked from the nav on every page here.
