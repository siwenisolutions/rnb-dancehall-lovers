# RnB Dancehall Lovers website

R&B and dancehall events, Harare, Zimbabwe. Live at **rnbdancehalllovers.co.zw**.

## For the client: updating the website

Go to **https://rnbdancehalllovers.co.zw/admin** and log in with the admin password.

- **Events**: add an event (name, date and time in Zimbabwe time, venue, ticket link, description, poster).
  Upcoming events show on the home page automatically and move to "Recent events" once the date passes.
  Use **Photos** on an event to upload pictures from that night and pick the cover.
- **Photos**: upload "The Experience" photos (newest 3 show on the home page) or gallery highlights.
- **Website details**: tagline, about text, email, phone, address, social links and footer ticket buttons.

Photos from a phone are fine; they are resized automatically.

## How it works

- `server.js`: Express app that serves the pages in `public/`, a JSON API, and the admin API.
- `db.js`: Postgres schema (created on startup) plus first-run seeding of the original photos.
- Photos (WebP, a large version and a thumbnail) and videos are stored in Neon Object Storage, bucket `rnb-media` on the project's main branch (5 GB on the free plan), and served from `/media/:id`. Postgres keeps only their details. Without the `AWS_*` settings, files are kept in Postgres as before (1 GB limit). On start-up, files still in Postgres are moved to the bucket.
- Videos are compressed in the background after upload (`jobs.js`, `video.js`): at most 1920 px on the long side, 30 fps, H.264 CRF 23, AAC 128k. The original shows until the smaller copy is ready; a video that is not at least 10% smaller, or fails twice, is kept as uploaded.
- Admin login is email + password (`admins` table, scrypt hashes, `auth.js`). On first start the account is created with the site's contact email (or `ADMIN_EMAIL`) and `ADMIN_PASSWORD` as a temporary password; the admin must choose their own password at first login. Changing the password, or "Log out everywhere", ends all other sessions. 5 wrong passwords lock the login for 15 minutes.
- Forgotten password: set `ADMIN_RESET_PASSWORD` on Render (10+ characters). On the next start it becomes a one-time temporary password for that account (or the one in `ADMIN_RESET_EMAIL`); the admin logs in with it and must choose a new one. Remove the variable afterwards; the same value is never applied twice.
- Every fixed word on the public pages is editable in the admin panel (Text tab). Fields are defined in `content.js`; pages use `{{key}}` placeholders that the server fills before sending a page. Saved words live in `settings` as `c:<key>`.

Public pages: `/` (home), `/events` (all events, upcoming and past), `/events/:id`, `/gallery`.

## Environment variables

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (Neon project `rnb-dancehall-lovers`) |
| `ADMIN_PASSWORD` | Temporary password for the very first login only (10+ characters). Not used once the account exists |
| `ADMIN_EMAIL` | Optional: login email for that first account (default: the site's contact email) |
| `ADMIN_RESET_PASSWORD` / `ADMIN_RESET_EMAIL` | Optional: one-time password reset, see above. Remove after use |
| `SESSION_SECRET` | Random string, 32+ characters, used to sign login cookies |
| `CANONICAL_HOST` | Set to `rnbdancehalllovers.co.zw` once the domain works: every other address (www, onrender.com) redirects there |
| `AWS_ENDPOINT_URL_S3` | Object Storage endpoint of the Neon branch, `https://br-raspy-mode-b95p644d.storage.c-7.eu-central-1.aws.neon.tech` |
| `AWS_REGION` | `eu-central-1` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Neon storage credential `rnb-website-render` (scopes `storage:read`, `storage:write`) |
| `MEDIA_BUCKET` | `rnb-media` |
| `GOOGLE_API_KEY` | Optional: a Google API key with the Drive API enabled. Without it, Drive folders are read from their public embed page; with it, the Drive API is used (better for very large folders) |
| `MEDIA_LIMIT_MB` | Storage cap shown in the admin panel when the bucket is used. Default `5120` (5 GB) |
| `NODE_ENV` | `production` on Render (makes cookies HTTPS-only) |
| `KEEP_AWAKE` | Leave unset on the free plan: the server pings its own `/ping` every 10 minutes so Render doesn't put it to sleep. Set to `off` after moving to a paid plan |
| `BEHIND_CLOUDFLARE` | Set to `yes` only after the domain runs through Cloudflare (orange cloud). Uses Cloudflare's visitor address for login lockouts and loads the header video straight from Render (Cloudflare's free plan may not deliver video) |
| `KEEP_AWAKE_HOURS` | When to stay awake, in Zimbabwe time. Default `6-24` (free hours are shared with other free services in the workspace); `0-24` = always |

## Run locally

```bash
npm install
DATABASE_URL=postgres://... ADMIN_PASSWORD=change-me-please SESSION_SECRET=$(openssl rand -hex 32) npm start
```

## Custom domain (rnbdancehalllovers.co.zw)

The domain is managed at the `.co.zw` registrar, not on Render, so moving the site does not need the old
Render account. In the Render dashboard for this service, open **Settings → Custom Domains**, add
`rnbdancehalllovers.co.zw` and `www.rnbdancehalllovers.co.zw`, then at the registrar's DNS settings:

- `A` record for `@` (the bare domain) → `216.24.57.1`
- `CNAME` record for `www` → this service's `*.onrender.com` address

Remove any old `A`/`CNAME` records for those names that point to the previous site. Render issues the HTTPS
certificate automatically once DNS has updated (minutes to a few hours). Then set `CANONICAL_HOST`.

## Google Drive

Admin → Events → **Add from Google Drive**: paste the link to a folder shared as "Anyone with the link" (`drive.js`, `jobs.js`). The admin can make one event per folder inside it (dates in folder names are read), one new event, or add the photos to an existing event. Photos (including folders inside, two levels deep) are copied into the website in the background, compressed like uploads, so the site never depends on Drive. Each event stays linked to its folder: new photos are copied every 6 hours, or straight away with "Check for new photos now" in the event's photos. Photos the admin deletes are never copied again (`drive_removed`).


## Cloudflare (free plan) in front of the site

Cloudflare caches photos and page files at its edge, so a busy night costs Render
and the database far less, and it absorbs bot and attack traffic.

1. Cloudflare dashboard: **Add a domain** → `rnbdancehalllovers.co.zw` → **Free** plan.
2. **DNS → Records**. Check every record from the current DNS host was copied, especially
   **MX and TXT records for email**. Then make sure these two exist, both **Proxied** (orange):
   - `CNAME  @    rnb-dancehall-lovers-pvic.onrender.com`
   - `CNAME  www  rnb-dancehall-lovers-pvic.onrender.com`
3. **SSL/TLS → Overview**: encryption mode **Full** (as Render's Cloudflare guide says).
   **SSL/TLS → Edge Certificates**: turn on **Always Use HTTPS**.
4. **Caching → Cache Rules → Create rule** "Photos":
   when *URI Path starts with* `/media/` → **Eligible for cache**, Edge TTL *use cache-control
   header if present*. (Photo URLs have no file extension, so Cloudflare skips them otherwise.)
   Pages and `/api/` are not cached, so admin changes still show straight away.
5. At the domain registrar (the .co.zw company the domain was bought from), replace the two
   nameservers with the two Cloudflare shows. Wait until Cloudflare says the domain is **Active**.
6. Render → the service → **Environment**: add `BEHIND_CLOUDFLARE` = `yes` and save (it redeploys).
7. Render → **Settings → Custom Domains**: both domains should still show *Certificate issued*.
   If Render can't renew a certificate later, switch the two records to *DNS only* (grey) for a
   few minutes, click **Verify**, then switch back to orange.
