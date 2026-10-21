#!/usr/bin/env python3
"""Zara restock watcher.

Reads items.json, asks Zara for each product's per-size stock and pushes to
your phone via ntfy:
  - "Back in stock"  every time a watched size goes from unavailable to buyable
  - "Still in stock" reminder every REMIND_EVERY_MIN (default 60) while it stays
    buyable, until you mark the item "bought": true in items.json
Standard library only, so it runs on a bare GitHub Actions runner.

  python3 check.py               normal check
  python3 check.py --test-notify send a test push and exit
"""
import json
import os
import random
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ITEMS_FILE = ROOT / "items.json"
STATE_FILE = ROOT / "state.json"

REMIND_EVERY = timedelta(minutes=int(os.environ.get("REMIND_EVERY_MIN", "60")))
SLACK = timedelta(minutes=5)  # GitHub runs drift; don't skip a reminder by seconds

# Zara's per-size "availability" values. Only these two mean "can add to bag".
BUYABLE = {"in_stock", "low_on_stock"}
KNOWN = BUYABLE | {"out_of_stock", "coming_soon", "back_soon"}

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0 Safari/537.36")


def urls_for(share_url):
    """Turn any Zara product link (share links included) into
    (clean page URL, JSON URL, v1 colour id)."""
    u = urllib.parse.urlparse(share_url.strip())
    v1 = urllib.parse.parse_qs(u.query).get("v1", [None])[0]
    path = u.path.lower()  # /HR/en/... -> /hr/en/...
    page = f"https://www.zara.com{path}" + (f"?v1={v1}" if v1 else "")
    query = urllib.parse.urlencode({"ajax": "true", **({"v1": v1} if v1 else {})})
    return page, f"https://www.zara.com{path}?{query}", v1


def fetch_json(url, tries=3):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Language": "en",
    })
    last = None
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read())
        except Exception as e:  # HTTP error, timeout, or HTML block page
            last = e
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"could not get JSON from {url}: {last}")


def read_sizes(data, v1):
    """Return (product name, colour name, [(size, availability), ...])."""
    product = data["product"]
    colours = product["detail"]["colors"]
    if v1:
        colour = next((c for c in colours if str(c.get("productId")) == str(v1)), None)
        if colour is None:
            found = ", ".join(f"{c.get('name')} (v1={c.get('productId')})" for c in colours)
            raise RuntimeError(f"colour v1={v1} not on the page any more; found: {found}")
    else:
        colour = colours[0]
    sizes = [(s["name"], s.get("availability", "?")) for s in colour["sizes"]]
    return product["name"], colour.get("name", "?"), sizes


def notify(title, message, click, priority=5):
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if not topic:
        raise RuntimeError("NTFY_TOPIC is not set")
    server = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    payload = {
        "topic": topic,
        "title": title,
        "message": message,
        "priority": priority,     # 5 = urgent (long vibration), 4 = high
        "tags": ["shopping_bags"],
        "click": click,           # tap the notification -> product page
    }
    req = urllib.request.Request(
        server, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        r.read()


def load_state():
    if STATE_FILE.exists() and STATE_FILE.read_text().strip():
        return json.loads(STATE_FILE.read_text())
    return {}


def main(argv):
    if "--test-notify" in argv:
        notify("Zara watcher: test", "If you can read this, alerts work.",
               "https://www.zara.com/hr/en/")
        print("Test notification sent.")
        return 0

    items = json.loads(ITEMS_FILE.read_text())
    state = load_state()
    before = json.dumps(state, sort_keys=True)
    available = state.setdefault("available", {})  # key -> what's buyable now
    now = datetime.now(timezone.utc)
    errors = 0
    checked = 0

    for item in items:
        if isinstance(item, str):
            item = {"url": item}
        page, api, v1 = urls_for(item["url"])
        want = [str(s).strip().upper() for s in item.get("sizes") or []]
        key = f"{v1 or page}|{','.join(sorted(want)) or 'any'}"

        if item.get("bought"):
            available.pop(key, None)
            print(f"SKIP  {page}  (bought)")
            continue

        if checked:
            time.sleep(random.uniform(1, 3))  # be gentle
        checked += 1
        try:
            name, colour, sizes = read_sizes(fetch_json(api), v1)
        except Exception as e:
            print(f"ERROR {page}: {e}", file=sys.stderr)
            errors += 1
            continue

        for size, avail in sizes:
            if avail not in KNOWN:
                print(f"WARN  unknown availability '{avail}' for {name} {size}", file=sys.stderr)

        watched = [(s, a) for s, a in sizes if not want or s.upper() in want]
        if want and not watched:
            print(f"ERROR {name} ({colour}): sizes {want} not found; "
                  f"sizes on page: {[s for s, _ in sizes]}", file=sys.stderr)
            errors += 1
            continue

        hits = [s for s, a in watched if a in BUYABLE]
        summary = " ".join(f"{s}:{a}" for s, a in watched)

        if not hits:
            available.pop(key, None)  # sold out: next time it's back counts as new
            print(f"WAIT  {name} ({colour})  {summary}")
            continue

        prev = available.get(key, {})
        new = [s for s in hits if s not in prev.get("sizes", [])]
        last = prev.get("last_alert")
        reminder_due = last and now - datetime.fromisoformat(last) >= REMIND_EVERY - SLACK

        if new or not last or reminder_due:
            if new or not last:
                tag, title, prio = "HIT ", f"Back in stock: {name.title()}", 5
                body = f"{colour}, size {', '.join(new or hits)}. Tap to open."
            else:
                tag, title, prio = "REMIND", f"Still in stock: {name.title()}", 4
                body = (f"{colour}, size {', '.join(hits)}. "
                        f"Reminders stop when you mark it bought.")
            try:
                notify(title, body, page, prio)
            except Exception as e:
                print(f"ERROR notify failed, will retry next run: {e}", file=sys.stderr)
                errors += 1
                continue
            last = now.isoformat(timespec="seconds")
        else:
            tag = "QUIET"  # buyable, reminder not due yet

        print(f"{tag:5} {name} ({colour})  {summary}")
        available[key] = {"item": f"{name} ({colour})", "sizes": hits, "last_alert": last}

    # Monthly heartbeat commit keeps GitHub from pausing the schedule
    # (public repos pause scheduled workflows after 60 days of no activity).
    hb = state.get("heartbeat")
    if not hb or now - datetime.fromisoformat(hb) > timedelta(days=30):
        state["heartbeat"] = now.isoformat(timespec="seconds")

    if json.dumps(state, sort_keys=True) != before:
        STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
