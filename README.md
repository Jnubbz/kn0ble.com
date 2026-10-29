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
is required. Note, mailing address (`address`), and email are optional.
The email is only so KN0BLE can reach the operator if needed. There is
no `@kn0ble.com` mailbox yet, and the notification should not use that
email as a reply address. QSL Tracker has to save `address` for the
field to be kept; the copy of the form on that app should stay in step
with this one.

## Editing

No build step and no dependencies. Edit the HTML and push. The header,
nav, and footer are copied in `index.html` and `404.html`, so a nav
change means editing both.

## Deploying

Pushing to `main` updates GitHub Pages from these files. A separate
workflow publishes the container image and does not change Pages.
Leave the DNS records below in place until the container is checked.
See "Docker on Unraid".

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

## Docker on Unraid

Same files, served by nginx in a container. `CNAME` and `.nojekyll`
stay in the repo for GitHub Pages. The image listens on port 8080 as
the nginx user (uid 101). The files are baked into the image, so there
is no appdata folder to chown.

### Run it locally

```bash
docker build -t kn0ble-com .
docker run --rm -p 8080:8080 kn0ble-com
```

- `http://127.0.0.1:8080/` is the homepage
- `http://127.0.0.1:8080/healthz` returns 200 and `ok`
- any unknown path returns `404.html`

### On the server

The QSL Tracker compose file (the Unraid stack in
[qsl-tracker#3](https://github.com/Jnubbz/qsl-tracker/pull/3)) already
runs `qsl-tracker` and `cloudflared` on a private network named `qsl`.
Copy `docker-compose.example.yml` to
`/mnt/cache/appdata/kn0ble-com/docker-compose.yml`. It joins that
network, which Docker names `qsl-tracker_qsl` when the other stack is
started from `/mnt/cache/appdata/qsl-tracker`. If `docker network ls`
shows another name, set `name:` under `qsl` to match. The file
publishes no host ports. cloudflared stays the container from the
qsl-tracker stack.

`cloudflared` only makes outbound connections. In the existing
tunnel, the public hostnames are:

- `kn0ble.com` -> `http://kn0ble-com:8080`
- `www.kn0ble.com` -> `http://kn0ble-com:8080`

`kn0ble-com` is this container on the `qsl` network, not an address
on the Unraid host.

A push to `main`, or a manual run of "Publish container image" from
`main`, publishes `ghcr.io/jnubbz/kn0ble-com` for amd64, tagged
`:latest` and the short git sha. If the pull is denied, the package
is still private: make it public, or `docker login ghcr.io` on Unraid
with a token that can read packages. The other stack has to be up
first so the `qsl` network exists.

```bash
cd /mnt/cache/appdata/kn0ble-com
docker compose up -d
```

### Auto-update

`pull_policy: always` takes effect when the container is recreated.
User Scripts can run this daily:

```bash
cd /mnt/cache/appdata/kn0ble-com
docker compose pull
docker compose up -d
```

### Cutover

Pages keeps serving the public site until the apex and `www` records
are tunnel CNAMEs. Check the container on the docker network before
changing them.

1. Merge, and wait until the workflow on `main` has published the image.
2. From the appdata directory, `docker compose up -d`, and confirm the
   container is healthy.
3. From the `qsl` network, request the site:

   ```bash
   docker run --rm --network qsl-tracker_qsl busybox wget -qO- http://kn0ble-com:8080/healthz
   docker run --rm --network qsl-tracker_qsl busybox wget -S -O /dev/null http://kn0ble-com:8080/
   docker run --rm --network qsl-tracker_qsl busybox wget -S -O - http://kn0ble-com:8080/no-such-page
   ```

   Expect `ok`, then `HTTP/1.1 200 OK`, then `HTTP/1.1 404 Not Found`
   and the words "Nothing on this frequency". wget exits non-zero on
   that 404; the status line is the check.
4. After that check, in Cloudflare, set the tunnel public hostnames
   above and change the apex and `www` records to the tunnel CNAMEs.
   Do that in Cloudflare. Leave the Pages records in the Deploying
   section as they are until this step.
5. Leave GitHub Pages enabled, and leave `CNAME` in the repo, so those
   records can be put back if `https://kn0ble.com` or
   `https://www.kn0ble.com` is not coming from the container.

## Related

- [QSL Tracker](https://qsl.kn0ble.com) -- the ADIF Address Extractor
  (QRZ login, then one callsign or an ADIF upload, printed as mailing
  labels) and the QSL Photo Map at `/photomap`.
