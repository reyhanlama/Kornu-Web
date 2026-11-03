# Kornu Web

A browser based Kornu prototype that uses the existing visual identity and the same sample readings as Kornu for iPad. It is a separate web client; it does not yet sync with the installed iPad app.

## Run locally

```sh
npm start
```

Open `http://127.0.0.1:4173` in a browser. Node 20 or newer is required. Set `PORT` to use another port. The server binds to localhost by default. To test without running a hosted service, clone this repository and run the command above from its root.

## Working now

- Library, Inbox, Marks & Notes, and responsive article Reader.
- Paste a public article link. The small Node server extracts title, paragraphs, and available images, then reports import failures or suspected short Medium previews for review.
- Select words within one paragraph to highlight, underline, or attach a typed passage note. Notes appear with a wavy underline and a numbered margin marker.
- Marks & Notes and the Reader rail jump to the relevant paragraph.
- Reading level note, search, filters, reading progress, and JSON backup export.
- Browser local storage persists readings and marks on this browser profile.

## Current limits

The web and iPad apps have separate stores and IDs. This is a browser prototype, not yet a hosted service or a shared account. The browser can load it from a URL once deployed, but cross device handoff requires an authenticated shared backend and migration of existing iPad data. Pencil ink, handwritten notes, fixed pages, offline image caching, and annotated PDF export remain native app work. The article importer is an early extractor; paywalled, JavaScript rendered, and restrictive sites may fail. Before public deployment, the import service needs stronger DNS pinning, rate limits, and operational monitoring. The server currently listens only on `127.0.0.1` deliberately; deploying it requires a production hosting configuration.

The original sample reading text is bundled for review, and its editorial image was generated for the Kornu prototype.
