# KN0BLE.com

Homepage for amateur radio callsign KN0BLE. Plain static HTML/CSS,
hosted on GitHub Pages. Deliberately small: a front door for the QSL
tools, kept around so it can grow later. There is no station, awards,
gallery, or log section.

## Structure

- `index.html` -- Home page. Links to the ADIF Address Extractor and the
  QSL Photo Map (both on [qsl.kn0ble.com](https://qsl.kn0ble.com)), and
  a form to request a card from KN0BLE.
- `404.html` -- GitHub Pages serves this for unknown paths. Links in
  here are root-relative (`/`, `/css/style.css`) so a miss like
  `/old/station` still loads the stylesheet and the home link.
- `css/style.css` -- Shared styling (dark theme).
- `CNAME` -- Tells GitHub Pages to serve this site at `kn0ble.com`.
  Don't delete it or the custom domain breaks.
- `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`, `og.png` --
  icon and the image used when the link is previewed in chat.
- `robots.txt`, `sitemap.xml` -- the one public URL.
- `.nojekyll` -- Pages skips Jekyll and publishes these files as-is.

The card-request form posts to `https://qsl.kn0ble.com/request-qsl`
(the [QSL Tracker](https://github.com/Jnubbz/qsl-tracker) app). Callsign
is required. Note, mailing address, and email are optional. The email
is only so KN0BLE can reach the operator if needed. There is no
`@kn0ble.com` mailbox yet, and the notification is not sent as a reply
to that address.

## Editing

No build step and no dependencies. Edit the HTML and push. The header,
nav, and footer are copied in `index.html` and `404.html`, so a nav
change means editing both.

## Deploying

Pushing to `main` is enough. GitHub Pages rebuilds from that branch.

DNS is on GoDaddy (`ns35` and `ns36.domaincontrol.com`):

- Apex `A` records: `185.199.108.153`, `185.199.109.153`,
  `185.199.110.153`, `185.199.111.153` (GitHub Pages).
- Apex has no `AAAA` records yet. Add `2606:50c0:8000::153`,
  `2606:50c0:8001::153`, `2606:50c0:8002::153`, and
  `2606:50c0:8003::153` so IPv6-only visitors can reach the apex.
  `www` is a CNAME to `jnubbz.github.io`, which already has those
  addresses, and then redirects here.
- In the repo's Settings -> Pages, turn on **Enforce HTTPS**. It is
  currently off, so `http://kn0ble.com` serves the page in cleartext.

## Related

- [QSL Tracker](https://qsl.kn0ble.com) -- the ADIF Address Extractor
  (QRZ login, then one callsign or an ADIF upload, printed as mailing
  labels) and the QSL Photo Map at `/photomap`.
