// Zara restock watcher: Cloudflare Worker, runs every minute.
//
// Watch list = items.json in the GitHub repo  +  links you share to ntfy topic "<NTFY_TOPIC>-add".
// Alerts go to ntfy topic NTFY_TOPIC with an "Open" and a "Bought" button.
//
// Needs (Cloudflare dashboard → this Worker → Settings):
//   - KV namespace binding named STATE
//   - Secret NTFY_TOPIC (your private ntfy topic name)
//   - Secret NTFY_TOKEN (recommended: ntfy.sh access token, tk_...). Without it, ntfy.sh limits
//     by IP address, and Cloudflare's IPs are shared with other users, so the daily quota runs out.
//   - Cron trigger "* * * * *"
// Then open the Worker's URL once: that shows the status page and enables the Bought buttons.
//
// Share text: "size M" overrides the default sizes; "bought" stops watching that link.

const REPO_RAW = "https://raw.githubusercontent.com/jsva0ne/Zara-Stock-Test/main";
const NTFY = "https://ntfy.sh";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const BUYABLE = new Set(["in_stock", "low_on_stock"]);
const DEFAULTS = { remindEveryMin: 60, defaultSizes: ["S", "XS"] };
const SIZE_RE = /^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|\d{2,3})$/i;
const ZARA_URL_RE = /https?:\/\/(?:www\.)?zara\.com\/[^\s"'<>]+/gi;
const MIN = 60_000;

// ---------- helpers ----------

function urlsFor(shareUrl) {
  const u = new URL(shareUrl.trim());
  const v1 = u.searchParams.get("v1");
  const path = u.pathname.toLowerCase();
  const page = `https://www.zara.com${path}` + (v1 ? `?v1=${v1}` : "");
  const api = `https://www.zara.com${path}?ajax=true` + (v1 ? `&v1=${v1}` : "");
  return { page, api, v1 };
}

function itemKey(url, sizes) {
  const { page, v1 } = urlsFor(url);
  const s = (sizes || []).map(x => String(x).toUpperCase()).sort().join(",");
  return `${v1 || page}|${s || "any"}`;
}

const baseOf = key => key.split("|")[0];

async function getJson(url, ttl = 60) {
  const res = await fetch(url, { cf: { cacheTtl: ttl } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function loadState(env) {
  const s = (await env.STATE.get("state", "json")) || {};
  s.added ??= [];        // items shared via ntfy: {url, sizes, addedAt}
  s.bought ??= [];       // item keys (or base ids) marked bought
  s.available ??= {};    // key -> {item, sizes, lastAlert}
  return s;
}

async function saveIfChanged(env, state, before) {
  const after = JSON.stringify(state);
  if (after !== before) await env.STATE.put("state", after);
}

// With a token, ntfy.sh counts usage against your account instead of the shared Cloudflare IP.
const ntfyAuth = env => (env.NTFY_TOKEN ? { Authorization: `Bearer ${env.NTFY_TOKEN.trim()}` } : {});

async function push(env, { title, message, click, priority = 3, tags = [], actions = [] }) {
  const res = await fetch(NTFY, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "zara-restock-watcher", ...ntfyAuth(env) },
    body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message, click, priority, tags, actions }),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
}

function isBought(state, key, item) {
  return item?.bought === true || state.bought.includes(key) || state.bought.includes(baseOf(key));
}

// ---------- Zara ----------

async function readZara(url) {
  const { api, v1 } = urlsFor(url);
  const res = await fetch(api, {
    headers: { "User-Agent": UA, "Accept": "application/json", "Accept-Language": "en" },
  });
  if (!res.ok) throw new Error(`Zara HTTP ${res.status}`);
  const text = await res.text();
  if (text.trimStart().startsWith("<")) throw new Error("Zara sent a web page instead of JSON (bot check?)");
  const data = JSON.parse(text);
  const colours = data.product.detail.colors;
  const colour = v1 ? colours.find(c => String(c.productId) === String(v1)) : colours[0];
  if (!colour) throw new Error(`colour v1=${v1} is no longer on the page`);
  return {
    name: data.product.name,
    colour: colour.name,
    sizes: colour.sizes.map(s => [s.name, s.availability]),
  };
}

const title = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

// ---------- share inbox ----------

function parseShare(text) {
  const urls = [...new Set((text.match(ZARA_URL_RE) || []).map(u => u.replace(/[).,]+$/, "")))];
  const m = text.match(/\bsizes?\s*[:=]?\s*([A-Za-z0-9 ,/]+)/i);
  const sizes = m ? m[1].split(/[\s,/]+/).filter(t => SIZE_RE.test(t)).map(t => t.toUpperCase()) : [];
  const bought = /\b(bought|stop|remove)\b/i.test(text);
  return { urls, sizes, bought };
}

async function pollInbox(env, state, settings) {
  const since = state.inboxSince || "1h";
  const res = await fetch(`${NTFY}/${env.NTFY_TOPIC}-add/json?poll=1&since=${encodeURIComponent(since)}`,
                          { headers: ntfyAuth(env) });
  if (!res.ok) throw new Error(`ntfy inbox HTTP ${res.status}`);
  const added = [], stopped = [], rejected = [];
  for (const line of (await res.text()).split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.event !== "message") continue;
    state.inboxSince = msg.id;
    const share = parseShare(`${msg.title || ""} ${msg.message || ""} ${msg.click || ""}`);
    if (!share.urls.length) rejected.push("no Zara link in the shared text");
    for (const url of share.urls) {
      // only product pages; shared favourites lists (/share/...) are off-limits per Zara's robots.txt
      if (!/-p\d+\.html/i.test(new URL(url).pathname)) { rejected.push(`not a product link: ${url.slice(0, 80)}`); continue; }
      const { page, v1 } = urlsFor(url);
      const base = v1 || page;
      if (share.bought) {
        if (!state.bought.includes(base)) state.bought.push(base);
        stopped.push(page);
        continue;
      }
      const sizes = share.sizes.length ? share.sizes : settings.defaultSizes;
      const key = itemKey(url, sizes);
      state.bought = state.bought.filter(b => b !== key && b !== base);   // re-sharing re-arms
      state.added = state.added.filter(a => itemKey(a.url, a.sizes) !== key);
      state.added.push({ url: page, sizes, addedAt: new Date().toISOString() });
      added.push(key);
    }
  }
  try {
    if (rejected.length) await push(env, { title: "Couldn't add that", message: `${rejected[0]}. Share a product page from the Zara app (one item, not a list).`, priority: 3, tags: ["x"] });
    if (stopped.length) await push(env, { title: "Stopped watching", message: stopped.join("\n"), priority: 2, tags: ["white_check_mark"] });
  } catch { /* feedback only; the list itself is already updated */ }
  return { added, stopped };
}

// ---------- the minute check ----------

async function runCheck(env, now = Date.now()) {
  now = Math.floor(now / MIN) * MIN;   // cron runs on whole minutes
  const state = await loadState(env);
  const before = JSON.stringify(state);
  const settings = { ...DEFAULTS };
  const problems = [];

  try { Object.assign(settings, await getJson(`${REPO_RAW}/settings.json`)); } catch { /* defaults */ }
  const remindMs = Math.max(1, settings.remindEveryMin) * MIN;

  let repoItems = [];
  try { repoItems = await getJson(`${REPO_RAW}/items.json`); }
  catch (e) { problems.push(`can't read items.json: ${e.message}`); }

  let inbox = { added: [], stopped: [] };
  try { inbox = await pollInbox(env, state, settings); }
  catch (e) { problems.push(`can't read share inbox: ${e.message}`); }

  // merge watch list (repo + shared), dedupe by key
  const watch = new Map();
  for (const it of [...repoItems, ...state.added]) {
    const item = typeof it === "string" ? { url: it } : it;
    const key = itemKey(item.url, item.sizes);
    if (!watch.has(key)) watch.set(key, item);
  }

  for (const [key, item] of watch) {
    if (isBought(state, key, item)) { delete state.available[key]; continue; }
    let info;
    try { info = await readZara(item.url); }
    catch (e) {
      problems.push(`${urlsFor(item.url).page}: ${e.message}`);
      if (inbox.added.includes(key)) {
        try { await push(env, { title: "Added, but can't read it yet", message: `${urlsFor(item.url).page}: ${e.message}. Will keep trying.`, priority: 3, tags: ["warning"] }); } catch {}
      }
      continue;
    }

    const want = (item.sizes || []).map(s => String(s).toUpperCase());
    const watched = info.sizes.filter(([s]) => !want.length || want.includes(s.toUpperCase()));
    if (want.length && !watched.length) {
      problems.push(`${info.name} (${info.colour}): sizes ${want.join("/")} not on page (has ${info.sizes.map(s => s[0]).join("/")})`);
      continue;
    }
    const hits = watched.filter(([, a]) => BUYABLE.has(a)).map(([s]) => s);
    const page = urlsFor(item.url).page;

    if (inbox.added.includes(key)) {
      const status = watched.map(([s, a]) => `${s} ${a.replace(/_/g, " ")}`).join(", ");
      try {
        await push(env, { title: `Now watching: ${title(info.name)}`, message: `${info.colour}, sizes ${want.join(", ") || "any"}. Now: ${status}.`, click: page, priority: 2, tags: ["eyes"] });
      } catch (e) { problems.push(`confirmation push: ${e.message}`); }
    }

    if (!hits.length) { delete state.available[key]; continue; }

    // Reminders are derived from when the alert first went out, so they need no storage writes
    // (free plan allows ~1,000 writes/day): remind in the minute each full interval completes.
    const prev = state.available[key] || {};
    const fresh = hits.filter(s => !(prev.sizes || []).includes(s));
    const since = prev.since ? Date.parse(prev.since) : null;
    const age = since === null ? 0 : now - since;
    const reminderDue = since !== null && age >= remindMs && age % remindMs < MIN;
    const isNew = since === null || fresh.length > 0;
    let sinceIso = prev.since || null;

    if (isNew || reminderDue) {
      const actions = [{ action: "view", label: "Open", url: page }];
      if (state.origin && state.buttonKey) {
        actions.push({ action: "http", label: "Bought", method: "POST", clear: true,
          url: `${state.origin}/bought?id=${encodeURIComponent(key)}&k=${state.buttonKey}` });
      }
      try {
        await push(env, {
          title: `${isNew ? "Back in stock" : "Still in stock"}: ${title(info.name)}`,
          message: `${info.colour}, size ${(isNew ? (fresh.length ? fresh : hits) : hits).join(", ")}.` +
                   (isNew ? "" : " Tap Bought to stop reminders."),
          click: page, priority: isNew ? 5 : 4, tags: ["shopping_bags"], actions,
        });
        if (isNew) sinceIso = new Date(now).toISOString();   // restart the reminder clock
      } catch (e) {
        problems.push(`alert push: ${e.message}`);
        if (isNew) continue;   // not recorded, so the next minute retries the alert
      }
    }
    state.available[key] = { item: `${info.name} (${info.colour})`, sizes: hits, since: sinceIso };
  }

  // forget state for items no longer on the list
  for (const key of Object.keys(state.available)) if (!watch.has(key)) delete state.available[key];

  // don't fail silently: one push if problems persist 30+ min, then at most daily
  if (problems.length) {
    state.problemSince ??= new Date(now).toISOString();
    state.lastProblem = problems[0].slice(0, 300);
    const persisting = now - Date.parse(state.problemSince) >= 30 * MIN;
    const quiet = !state.problemPushedAt || now - Date.parse(state.problemPushedAt) >= 24 * 60 * MIN;
    if (persisting && quiet) {
      try {
        await push(env, { title: "Zara watcher needs a look", message: `${problems.length} problem(s), e.g. ${problems[0]}`, priority: 3, tags: ["warning"] });
        state.problemPushedAt = new Date(now).toISOString();
      } catch { /* ntfy down; nothing else to do */ }
    }
  } else {
    delete state.problemSince; delete state.lastProblem; delete state.problemPushedAt;
  }

  // keep KV writes low (free plan: 1,000/day): note "alive" every 30 min, not every minute
  if (!state.aliveAt || now - Date.parse(state.aliveAt) >= 30 * MIN) state.aliveAt = new Date(now).toISOString();

  await saveIfChanged(env, state, before);
  return { state, problems, watched: watch.size };
}

// ---------- web: status page + Bought button ----------

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const state = await loadState(env);
  const before = JSON.stringify(state);

  if (url.pathname === "/bought") {
    if (request.method !== "POST") return new Response("Use the Bought button in the notification.", { status: 405 });
    if (!state.buttonKey || url.searchParams.get("k") !== state.buttonKey) return new Response("Forbidden", { status: 403 });
    const key = url.searchParams.get("id") || "";
    if (!key.includes("|")) return new Response("Bad id", { status: 400 });
    if (!state.bought.includes(key)) state.bought.push(key);
    delete state.available[key];
    await saveIfChanged(env, state, before);
    return new Response("OK, reminders stopped.");
  }

  // status page; visiting it also teaches the Worker its own address for the Bought buttons
  state.origin = url.origin;
  if (!state.buttonKey) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    state.buttonKey = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  }
  await saveIfChanged(env, state, before);

  const rows = Object.values(state.available).map(a =>
    `<li>🛍️ <b>${esc(a.item)}</b>: ${esc(a.sizes.join(", "))} in stock (alerted ${esc(a.since || "-")})</li>`).join("");
  const shared = state.added.map(a =>
    `<li>${esc(urlsFor(a.url).page)}: sizes ${esc((a.sizes || []).join(", ") || "any")}${isBought(state, itemKey(a.url, a.sizes)) ? " (bought)" : ""}</li>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zara watcher</title><body style="font:16px system-ui;max-width:640px;margin:24px auto;padding:0 16px">
<h1>Zara watcher</h1>
<p>${env.NTFY_TOPIC ? "✅ ntfy topic set" : "❌ secret NTFY_TOPIC missing"} · ${env.NTFY_TOKEN ? "✅ ntfy login" : "⚠️ no NTFY_TOKEN (shared quota)"} · ${env.STATE ? "✅ KV bound" : "❌ KV missing"} ·
last alive ${esc(state.aliveAt || "not run yet: add the cron trigger")}</p>
${state.lastProblem ? `<p>⚠️ Since ${esc(state.problemSince)}: ${esc(state.lastProblem)}</p>` : "<p>✅ No problems</p>"}
<h2>In stock now</h2><ul>${rows || "<li>Nothing watched is in stock.</li>"}</ul>
<h2>Added by sharing</h2><ul>${shared || "<li>None yet. Share a Zara link to your ntfy topic ending in <code>-add</code>.</li>"}</ul>
<p>Repo list: <a href="https://github.com/jsva0ne/Zara-Stock-Test/blob/main/items.json">items.json</a> ·
settings: <a href="https://github.com/jsva0ne/Zara-Stock-Test/blob/main/settings.json">settings.json</a></p>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env, event.scheduledTime ?? Date.now()));
  },
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  _test: { runCheck, handleRequest, parseShare, itemKey, urlsFor },   // used by local tests only
};
