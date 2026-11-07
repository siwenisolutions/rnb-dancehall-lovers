# RNB Dancehall Lovers website

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
- Photos are stored in Postgres as WebP (a large version and a thumbnail) and served from `/media/:id`.
- Admin login is a single password (`ADMIN_PASSWORD`) with a signed, HttpOnly session cookie.

Public pages: `/` (home), `/events` (all events, upcoming and past), `/events/:id`, `/gallery`.

## Environment variables

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (Neon project `rnb-dancehall-lovers`) |
| `ADMIN_PASSWORD` | Admin panel password, 10+ characters |
| `SESSION_SECRET` | Random string, 32+ characters, used to sign login cookies |
| `CANONICAL_HOST` | Set to `rnbdancehalllovers.co.zw` once the domain works: every other address (www, onrender.com) redirects there |
| `NODE_ENV` | `production` on Render (makes cookies HTTPS-only) |

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
