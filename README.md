# Zara restock watcher

A Telegram bot that messages you when a Zara item you want can be added to the
bag. Each item is checked **every 3 minutes** on Cloudflare Workers (free plan),
for lists of up to ~105 items.

## How you use it (all in the bot's Telegram chat)

- **Add an item:** in the Zara app, tap Share → Telegram → your bot. Or paste the
  link. The bot replies "👀 Now watching …" with the current stock.
  - Sizes are picked per item automatically (`sizeRules` in `settings.json`):
    - letter-sized clothing → **XS, S**
    - numbered clothing (trousers, jeans) → **32, 34**
    - shoes → **38**
    - one-size items → their single size
    - To choose yourself, write e.g. `size M`, `sizes M L` or `size any` with the link.
- **Alerts:**
  - "🛍️ Back in stock" when a watched size becomes buyable.
  - "⏰ Still in stock": one reminder 60 minutes later, only if it's still buyable.
  - Buttons: **Open** (product page) and **Bought ✓** (cancels the reminder and future alerts).
  - If it sells out, it resets: the next restock gets a fresh alert, and later one reminder.
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
| `settings.json` | `checkEveryMin` (3), `remindAfterMin` (60), `maxItemsPerRun` (35), `sizeRules`. The Worker reads it every run (GitHub caches it for up to ~5 min). |
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
6. **Trigger events:** add a Cron Trigger `* * * * *`. It runs every minute and checks one slice
   of the list each time, so each item comes round every `checkEveryMin` minutes.
7. **Open the Worker's address once.** This connects the bot to the Worker. The page
   links to your bot.
8. **Open the bot in Telegram and press Start.** The first chat to press Start becomes
   the owner; anyone else gets "This is a private bot."

## Things to know

- **Capacity:** each minute checks a third of the list, at most `maxItemsPerRun` (35), so
  up to ~105 items are each checked every 3 minutes. A longer list stretches the interval
  automatically (e.g. 130 items → every 4 minutes); `/list` and the status page show it.
  - Only this colour's sizes are read out of each ~100 KB Zara reply. A 35-item run costs
    about the same processing as the 15-item test that passed on Cloudflare.
  - Every check reserves its request first, and alerts use what's left. If many items
    restock at once, the rest go out on their next turn, a few minutes later.
- **Free-plan limits used:**
  - Runs: 1,440 a day out of 100,000.
  - Storage writes: only when stock changes, plus one every 30 minutes, against a
    limit of 1,000 a day.
  - Outside requests: at most 49 per run, against a limit of 50.
  - Processing: a 35-item run takes about 3.5 ms in local tests, against a limit of 10 ms.
  - Telegram: free, with limits per bot (not shared with anyone).
- **No silent failures:** if checks keep failing for 30+ minutes, the bot sends one
  "⚠️ needs a look" message a day until it's fixed. The status page shows the latest
  problem.
- **Urgency:** Telegram treats bot messages as normal chats. For louder alerts, set
  a custom sound or importance for the bot chat in Telegram's notification settings.
- **Code updates** mean pasting the new `worker.js` and clicking Deploy. The lists
  and settings come from this repo and update without that.
