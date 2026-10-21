# Zara restock watcher

A Telegram bot that messages you when a Zara item you want can be added to the
bag, and keeps reminding you until you tap **Bought**. Checks run **every minute**
on Cloudflare Workers (free plan).

## How you use it (all in the bot's Telegram chat)

- **Add an item:** in the Zara app, tap Share → Telegram → your bot. Or paste the
  link. The bot replies "👀 Now watching …" with the current stock.
  - Sizes default to S and XS (`settings.json`). To change them, write e.g. `size M`
    or `sizes M L` with the link.
- **Alerts:**
  - "🛍️ Back in stock" every time a watched size becomes buyable.
  - "⏰ Still in stock" reminders while it stays buyable.
  - Buttons: **Open** (product page) and **Bought ✓** (stops the reminders).
- **Stop without buying:** tap Stop or Bought, or send `stop` with the link.
  Sharing the link again starts watching it again.
- **/list** shows everything being watched.
- Favourites lists can't be watched, only single product links. Zara forbids
  automated reading of shared lists.
- Claude can also add items for you to `items.json`.

## Where things live

| File | What it is |
|---|---|
| `cloudflare/worker.js` | The watcher and bot. Pasted into the Cloudflare Worker. |
| `items.json` | Items added via Claude/GitHub. `sizes: []` = any size; `"bought": true` stops it. |
| `settings.json` | `remindEveryMin` and `defaultSizes`. The Worker reads it every run (GitHub caches it for up to ~5 min). |
| `check.py` + `.github/workflows/check.yml` | Old GitHub/ntfy checker: manual runs only, kept as a backup. |
| `cloudflare/test-worker.js` | Read-only reachability test. |

Items added in Telegram are stored in the Worker's storage (KV). The status page,
the Worker's `.workers.dev` address, shows them along with setup checks and problems.

## Setup (once)

1. **Create the bot:** in Telegram, open **@BotFather**, send `/newbot`, and pick a
   name and a username ending in `bot`. Copy the token it gives you.
2. **Cloudflare storage:** Storage & Databases → KV → create a namespace.
3. **Worker:** Edit code → paste `cloudflare/worker.js` → Deploy.
4. **Bindings:** add a KV namespace binding, variable name `STATE`.
5. **Variables and Secrets:** add a **Secret** `TELEGRAM_TOKEN` = the BotFather token.
6. **Trigger events:** add a Cron Trigger `* * * * *`.
7. **Open the Worker's address once.** This connects the bot to the Worker. The page
   links to your bot.
8. **Open the bot in Telegram and press Start.** The first chat to press Start becomes
   the owner; anyone else gets "This is a private bot."

## Things to know

- **Free-plan limits used:**
  - Runs: 1,440 a day out of 100,000.
  - Storage writes: only when stock changes, plus one every 30 minutes, against a
    limit of 1,000 a day.
  - Processing: each run gets 10 ms, which fits roughly 10–30 items.
  - Telegram: free, with limits per bot (not shared with anyone).
- **No silent failures:** if checks keep failing for 30+ minutes, the bot sends one
  "⚠️ needs a look" message a day until it's fixed. The status page shows the latest
  problem.
- **Urgency:** Telegram treats bot messages as normal chats. For louder alerts, set
  a custom sound or importance for the bot chat in Telegram's notification settings.
- **Code updates** mean pasting the new `worker.js` and clicking Deploy. The lists
  and settings come from this repo and update without that.
