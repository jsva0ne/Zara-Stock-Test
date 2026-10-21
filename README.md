# Zara restock watcher

Push alerts to your phone (ntfy, free) when a Zara item you want can be added to
the bag, with reminders until you mark it bought. Checks run **every minute** on
Cloudflare Workers (free plan).

## How you use it

- **Add an item:** in the Zara app, tap Share → **ntfy** → your topic ending in
  `-add`. You get a "Now watching" confirmation.
  - Sizes default to S and XS. To override, add `size M` (or `sizes M L`) to the
    shared text.
  - Or paste the link to Claude, which adds it to `items.json`.
- **Alert:** "Back in stock" (urgent) every time a watched size becomes buyable.
  "Still in stock" reminders repeat while it stays buyable.
  - **Open** goes to the product page.
  - **Bought** stops the reminders.
- **Stop without buying:** share the link again with the word `stop`, or tap Bought.
- Favourites lists can't be watched, only single product links. Zara forbids
  automated reading of shared lists.

## Where things live

| File | What it is |
|---|---|
| `cloudflare/worker.js` | The watcher. Pasted into the Cloudflare Worker. |
| `items.json` | Items added via Claude/GitHub. `sizes: []` = any size; `"bought": true` stops it. |
| `settings.json` | `remindEveryMin` and `defaultSizes`. The Worker reads it every run (GitHub caches it for up to ~5 min). |
| `check.py` + `.github/workflows/check.yml` | Backup checker: GitHub Actions, manual runs only. |
| `cloudflare/test-worker.js` | Read-only reachability test. |

Items you add by sharing live in the Worker's storage. You can see them on the
Worker's status page, which is its `.workers.dev` address.

## Cloudflare setup (once)

1. **Storage:** Storage & Databases → KV → create a namespace (any name, e.g. `zara-watcher`).
2. **Worker:** open your Worker → Edit code → paste `cloudflare/worker.js` → Deploy.
3. **Settings → Bindings:** add a KV namespace binding, variable name `STATE`,
   pointing at the namespace from step 1.
4. **Settings → Variables and Secrets:** add a **Secret** named `NTFY_TOPIC` with
   your topic name (only the name, no `https://ntfy.sh/`), and a **Secret** named
   `NTFY_TOKEN` with an access token from a free ntfy.sh account (Account → Access
   tokens). Without the token, ntfy.sh limits by IP address, and Cloudflare's IPs are
   shared with other users, so the daily quota is often already used up (HTTP 429).
5. **Settings → Trigger events:** add a Cron Trigger `* * * * *` (every minute).
6. Open the Worker's address once. The status page should show ✅ for the topic and
   storage; visiting it also switches on the Bought buttons.
7. **Phone:** in ntfy, subscribe to `<your topic>-add` so it appears in the share
   menu. Mute it if you don't want to see your own shares.

## Things to know

- **Limits used (free plan):** 1,440 runs/day out of 100,000. Storage is written only
  when stock changes, roughly every 30 minutes otherwise, well under the 1,000/day limit.
  Each run has 10 ms of processing, which fits roughly 10–30 items.
- **No silent failures:** if checks keep failing for 30+ minutes (Zara blocking,
  wrong size name), you get one "Zara watcher needs a look" push per day until it's
  fixed. The status page shows the latest problem.
- **Updating the Worker code** means pasting the new `worker.js` and clicking Deploy.
  Lists and settings don't need that; they come from this repo.
