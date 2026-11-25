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

## How it works (Cloudflare Workers, free plan)

The site runs as one Cloudflare Worker (`wrangler.jsonc`). It moved off Render in November 2026.

- `worker.js`: entry point. Serves photos and videos at `/media/:id` from object storage and keeps them in
  Cloudflare's cache; hands everything else to the Express app; runs the scheduled job every 5 minutes.
- `server.js`: Express app (pages, JSON API, admin API), running on Workers with `nodejs_compat`.
- CSS, JS, images and the welcome video in `public/` are served by Cloudflare directly (static assets,
  free and unlimited). HTML pages are left out of the assets (`public/.assetsignore`) and bundled into
  `generated/pages.js` by `tools/cf-build.js` at deploy time, so the Worker can fill in the website text.
- `db.js`: Postgres on Neon through the Neon serverless driver over HTTPS (one request per query, no
  connections kept). Transactions are not used on Workers; each statement runs on its own. The schema is
  applied by the 6-hourly job (bump `SCHEMA_VERSION` when it changes).
- Photos (a large copy up to 1600 px and a 640 px thumbnail) and videos are stored in Neon Object Storage,
  bucket `rnb-media` on the project's main branch (5 GB on the free plan). Postgres keeps only their details.
- **Photos are shrunk in the admin's browser** before upload (`public/js/admin.js`, WebP, or JPEG on browsers
  that can't make WebP), because the free plan gives each request only ~10 ms of CPU. Photos the server
  fetches itself (Megaticket flyers, social posts) are shrunk with Cloudflare Images (`IMAGES` binding,
  5,000 a month free); Google Drive photos come already resized from Drive.
- **Videos are stored as uploaded** (no compression on Workers), up to 40 MB each.
- Scheduled job (`*/5 * * * *`): Megaticket at 12:00 and 21:00 Harare time; every 6 hours the schema,
  Drive folder checks, storage tidy-up, old visitor codes and unpaid orders; otherwise one step of a waiting
  Drive import, only when the `drive-work` flag in Workers KV (`FLAGS`) says there is one, so the database
  can sleep when nothing is happening.
- Free plan limits that shaped the code: 100,000 Worker requests a day, ~10 ms CPU and 50 outside requests
  per request, 100 MB uploads, 128 MB memory.
- Admin login is email + password (`admins` table, scrypt hashes, `auth.js`). On first start the account is created with the site's contact email (or `ADMIN_EMAIL`) and `ADMIN_PASSWORD` as a temporary password; the admin must choose their own password at first login. Changing the password, or "Log out everywhere", ends all other sessions. 5 wrong passwords lock the login for 15 minutes.
- Forgotten password: add the secret `ADMIN_RESET_PASSWORD` in Cloudflare (10+ characters). At the next 6-hourly job it becomes a one-time temporary password for that account (or the one in `ADMIN_RESET_EMAIL`); the admin logs in with it and must choose a new one. Remove the secret afterwards; the same value is never applied twice.
- Every fixed word on the public pages is editable in the admin panel (Text tab). Fields are defined in `content.js`; pages use `{{key}}` placeholders that the server fills before sending a page. Saved words live in `settings` as `c:<key>`.

Public pages: `/` (home), `/events` (all events, upcoming and past), `/events/:id`, `/gallery`, `/shop`.

## Deploying

Cloudflare dashboard → **Workers & Pages** → the `rnb-dancehall-lovers` Worker is connected to this GitHub
repository (Workers Builds): every push to the production branch deploys. Deploy command `npx wrangler deploy`
(it runs `node tools/cf-build.js` first, see `wrangler.jsonc`).

## Settings (Worker → Settings → Variables and Secrets)

Plain values in `wrangler.jsonc`: `NODE_ENV`, `AWS_REGION`, `AWS_ENDPOINT_URL_S3`, `MEDIA_BUCKET`.

| Name | Type | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Secret | Postgres connection string (Neon project `rnb-dancehall-lovers`, main branch) |
| `SESSION_SECRET` | Secret | Random string, 32+ characters, used to sign login cookies |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Secret | Neon storage credential (scopes `storage:read`, `storage:write`) |
| `CANONICAL_HOST` | Text | Set to `rnbdancehalllovers.co.zw` once the domain works: every other address (www, workers.dev) redirects there |
| `ADMIN_PASSWORD` | Secret | Only for a brand new database: temporary password for the very first login |
| `ADMIN_RESET_PASSWORD` / `ADMIN_RESET_EMAIL` | Secret | Optional: one-time password reset, see above. Remove after use |
| `GOOGLE_API_KEY` | Secret | Optional: Drive API key (better for very large folders) |
| `PAYNOW_INTEGRATION_ID` / `PAYNOW_INTEGRATION_KEY` / `PAYNOW_AUTH_EMAIL` | Secret | Optional: shop payments (can also be set in the admin panel) |
| `MEDIA_LIMIT_MB` | Text | Storage cap shown in the admin panel. Default `5120` (5 GB) |

## Run locally

```bash
npm install
# Local stand-ins for Neon (HTTP queries on a local Postgres), object storage and Google Drive:
node tools/dev/local-services.js &
# .dev.vars: DATABASE_URL=postgresql://postgres:pg@localhost:5432/rnb, NEON_FETCH_ENDPOINT=http://127.0.0.1:4444/sql,
# AWS_ENDPOINT_URL_S3=http://127.0.0.1:4445, AWS_ACCESS_KEY_ID=local, AWS_SECRET_ACCESS_KEY=local,
# SESSION_SECRET=<32+ chars>, DRIVE_WEB_BASE=http://127.0.0.1:4446
npx wrangler dev --test-scheduled
```

## Custom domain (rnbdancehalllovers.co.zw)

The domain must be on Cloudflare (Cloudflare → **Add a domain** → Free plan, copy the DNS records from the
current host, especially **MX and TXT records for email**, then change the two nameservers at the .co.zw
registrar). Then Worker → **Settings → Domains & Routes → Add → Custom domain**: `rnbdancehalllovers.co.zw`
and `www.rnbdancehalllovers.co.zw` (Cloudflare replaces the old Render records itself). Then set
`CANONICAL_HOST`. Photos and videos are cached on the custom domain only (not on workers.dev).

## Google Drive

Admin → Events → **Add from Google Drive**: paste the link to a folder shared as "Anyone with the link" (`drive.js`, `jobs.js`). The admin can make one event per folder inside it (dates in folder names are read), one new event, or add the photos to an existing event. Photos (including folders inside, two levels deep) are copied into the website in the background, compressed like uploads, so the site never depends on Drive. Each event stays linked to its folder: new photos are copied every 6 hours, or straight away with "Check for new photos now" in the event's photos. Photos the admin deletes are never copied again (`drive_removed`).
