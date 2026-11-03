# Kornu Web

A browser based Kornu prototype that uses the existing visual identity and the same sample readings as Kornu for iPad. It is a separate web client; it does not yet sync with the installed iPad app.

## Run locally

```sh
npm start
```

Open `http://127.0.0.1:4173` in a browser. Node 20 or newer is required. Set `PORT` to use another port. The server binds to localhost by default. To test without running a hosted service, clone this repository and run the command above from its root.

## Deploy on Netlify

Connect this repository to a Netlify site and deploy the `main` branch. The checked-in `netlify.toml` sets the publish directory to `public`, runs the project checks and account client build, and bundles the article capture function. Keep the base directory at the repository root. Netlify installs the npm dependencies and uses Node 24 from `.nvmrc`.

Deploy from the Git repository so Netlify builds the `netlify/functions` code. Uploading only the `public` folder makes the interface available but cannot provide article import. The app uses hash routes (`/#/library`, `/#/reader/...`), so it does not need a catch-all page rewrite. If a linked site still shows Netlify's 404 page, inspect the latest deploy's file explorer and confirm that `public/index.html` was published.

## Activate Google sign-in and private profiles

The account interface and storage code are prepared, but Google sign-in will remain unavailable until Kornu has a Supabase project. To activate it:

1. Create a Supabase project. In its SQL Editor, run [`supabase/schema.sql`](supabase/schema.sql). This creates a private `kornu_readings` table and private `kornu-assets` bucket with per-user access rules.
2. In Google Cloud, create an OAuth **Web application** client. Set its **Authorized redirect URI** to the Supabase callback URL shown under Supabase **Authentication → Providers → Google** (usually `https://PROJECT_REF.supabase.co/auth/v1/callback`). Add its client ID and client secret to that Supabase Google provider and enable it. Keep the Google client secret in Supabase; it does not belong in this repository or Netlify's public build variables.
3. In Supabase **Authentication → URL Configuration**, set **Site URL** to the production Netlify origin. Add `https://YOUR-SITE.netlify.app/` and `http://127.0.0.1:4173/` to **Redirect URLs**. Add any custom domain or preview origin you actually use.
4. In Netlify's environment variables, set `KORNU_SUPABASE_URL` to the project's HTTPS URL and `KORNU_SUPABASE_PUBLISHABLE_KEY` to its **publishable** key, then redeploy. For local development, set the same two environment variables before `npm start`. Both values are intentionally included in the browser build; **never use the service-role key** there.

Signing in opens a separate profile library. The browser's guest library remains local until the user chooses **Copy this browser's library into my profile** from the account menu. Profile readings, rich article snapshots, marks, notes, and progress are stored in the table; saved article images are stored in the private bucket. The browser retains a local cache and queues changes if a cloud save fails. The account menu reports the save state. Account data is protected by Supabase row level security, not by hiding the publishable key.

The installed iPad app still uses its own local store. This setup prepares web accounts; it does not yet connect the native app.

## Working now

- Library, Inbox, Marks & Notes, and responsive article Reader.
- Paste a public article link. Mozilla Readability prepares a structured reading copy with headings, emphasis, links, lists, quotations, tables, image placement, and author information when available.
- For a Medium story blocked by its browser challenge, Kornu tries the publication or author's public RSS feed. It accepts a matching long entry and labels the reading as an RSS capture.
- Kornu downloads supported article images through its local capture server and stores them with the reading in browser IndexedDB. A failed image appears as a placeholder with an explicit warning.
- Recapture an older article from the Reader. If it has marks or a reading note, Kornu creates a new copy so those annotations stay attached to the original version.
- Select words within one paragraph to highlight, underline, or attach a typed passage note. Notes appear with a wavy underline and a numbered margin marker.
- Marks & Notes and the Reader rail jump to the relevant paragraph.
- Reading level note, search, filters, reading progress, and a JSON backup that includes saved article snapshots and image data.
- Browser local storage holds library metadata and marks; IndexedDB holds rich article snapshots and image files on this browser profile. When cloud storage is configured and the user signs in, these can also be saved to a private profile.

## Current limits

The web and iPad apps have separate stores and IDs. Pencil ink, handwritten notes, fixed pages, and annotated PDF export remain native app work. Older web imports remain in their original plain-text format until recaptured. The article importer is a reader-copy extractor, not a pixel-perfect website archiver: embedded media, interactive layouts, paywalled pages, JavaScript-rendered pages, and sites that block automated requests may fail. Medium's public RSS feeds contain only recent stories, and paywalled stories are not available there in full; if a blocked story has no suitable feed entry, Kornu keeps its original link for review. It captures up to 30 supported images of at most 4 MB each. The hosted capture function checks the destination at connection time and has a per-client request limit. Review function usage and errors in Netlify after deployment. The local Node server still listens only on `127.0.0.1`.

The article extraction layer uses [Mozilla Readability](https://github.com/mozilla/readability). Captured inline HTML is rebuilt from a small allowlist before it reaches the Reader.

The original sample reading text is bundled for review, and its editorial image was generated for the Kornu prototype.
