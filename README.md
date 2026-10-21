# Zara restock watcher

Checks the Zara items in `items.json` every 15 minutes (GitHub Actions, free)
and pushes to your phone (ntfy, free) whenever a watched size can be added to
the bag, then keeps reminding you until you mark the item bought.

## Setup (≈10 min)

1. **Phone:** install the **ntfy** app (Play Store) and subscribe to a topic
   with a long random name, e.g. `zara-0hznuom1nyrqwvpg`. Anyone who knows
   the name can read it, so keep it private.
   In the app's settings, allow it to ignore battery optimisation so pushes
   arrive instantly.
2. **GitHub:** create a new **public** repository (public = unlimited free
   minutes; a private repo's 2,000 free minutes/month would run out at this
   cadence). Upload all files from this folder, keeping the `.github/workflows/`
   path.
3. **Secret:** repo → Settings → Secrets and variables → Actions →
   *New repository secret* → name `NTFY_TOPIC`, value = your topic name.
4. **Test the alert path:** repo → Actions → *Zara restock check* →
   *Run workflow* → tick *Only send a test notification* → Run.
   Your phone should buzz within seconds.
5. **Test the Zara path:** run it again without the tick. Open the run log:
   each item prints `WAIT` (watched sizes out) or `HIT` (alert sent).
   An `ERROR ... could not get JSON` line means Zara is blocking GitHub's
   servers; see *If Zara blocks* below.

After that it runs on its own.

## Adding or changing items

Edit `items.json`. Paste the product link (share links work as-is; the
`v1=` number in the link pins the colour). `sizes` is a list like
`["M"]` or `["S", "M"]`; an empty list `[]` means any size.

```json
[
  { "url": "https://www.zara.com/hr/en/...-p05536102.html?v1=586069543", "sizes": ["M"] }
]
```

## How alerts work

- **Back in stock** (urgent): every time a watched size goes from unavailable
  to buyable, including when it sells out and comes back again later.
- **Still in stock** (high): a reminder every 60 minutes while it stays
  buyable. Change the interval by adding a repository *variable*
  `REMIND_EVERY_MIN` (Settings → Secrets and variables → Actions → Variables).
- **Stop:** when you've bought it, add `"bought": true` to the item in
  `items.json` (or delete the item).

```json
{ "url": "https://www.zara.com/hr/en/...", "sizes": ["S"], "bought": true }
```

Only `in_stock` and `low_on_stock` count as available; `coming_soon` and
`out_of_stock` don't. `state.json` is the watcher's memory of what's currently
in stock; you never need to edit it.

## Things to know

- **Timing:** GitHub can start scheduled runs a few minutes late, and under
  heavy load occasionally skips one. Expect "every 15–20 min", not exact.
- **Failures email you:** if a run fails (Zara blocked, a size name typo, the
  colour was removed), GitHub emails you about the failed run.
- **Keep-alive:** GitHub pauses schedules in public repos after 60 days with
  no activity. The script commits a small heartbeat to `state.json` once a
  month to prevent that.

## If Zara blocks

The script reads the same JSON the product page itself loads, at 2 requests
per 15 minutes. If GitHub's IP range ever gets blocked, the fallback is to
run the same script on any always-on machine at home (a Raspberry Pi or old
laptop) with cron: `*/15 * * * * NTFY_TOPIC=... python3 /path/check.py`.
