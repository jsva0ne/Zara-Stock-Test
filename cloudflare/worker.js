// Zara restock watcher: Cloudflare Worker + Telegram bot.
//
// Setup (Cloudflare → this Worker → Settings):
//   - KV namespace binding named STATE
//   - Secret TELEGRAM_TOKEN (from @BotFather)
//   - Cron trigger "* * * * *"
// Then open the Worker's address once (connects the bot), and press Start in your bot's chat.
//
// In the bot chat: share or paste a Zara product link to watch it. Sizes are picked per item
// (settings.json → sizeRules): letter sizes → XS, S; numbered clothing → 32, 34; shoes → 38;
// one-size items → that size. Write "size M" (or "size any") with the link to override.
// "stop <link>" or the Bought button stops it. /list shows everything being watched.
//
// Capacity: the cron fires every minute and each minute checks one slice of the list, so every
// item is checked every checkEveryMin minutes with at most maxItemsPerRun items per run
// (free plan: 50 outside requests and 10 ms processing per run). Longer lists stretch the interval.

const REPO_RAW = "https://raw.githubusercontent.com/jsva0ne/Zara-Stock-Test/main";
const TG = "https://api.telegram.org";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const BUYABLE = new Set(["in_stock", "low_on_stock"]);
const DEFAULTS = {
  checkEveryMin: 3, remindAfterMin: 60, maxItemsPerRun: 35,
  sizeRules: { letters: ["XS", "S"], numbers: ["32", "34"], shoes: ["38"], oneSize: true },
};
const SUBREQUEST_LIMIT = 50;   // Cloudflare free plan, per run
const SIZE_RE = /^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|\d{2,3}(?:[.,]5)?)$/i;
const ZARA_URL_RE = /https?:\/\/(?:www\.)?zara\.com\/[^\s"'<>]+/gi;
const MIN = 60_000;
const HELP = "Share or paste a Zara product link here to watch it.\n" +
             "• Sizes are picked automatically: clothing XS/S, trousers & jeans 32/34, shoes 38, one-size items as they are. " +
             "Write e.g. \"size M\" (or \"size any\") with the link to choose yourself.\n" +
             "• Stop: tap Bought on an alert, or send \"stop\" with the link.\n" +
             "• /list shows everything being watched.";

// ---------- helpers ----------

function urlsFor(shareUrl) {
  const u = new URL(shareUrl.trim());
  const v1 = u.searchParams.get("v1");
  const path = u.pathname.toLowerCase();
  const page = `https://www.zara.com${path}` + (v1 ? `?v1=${v1}` : "");
  const api = `https://www.zara.com${path}?ajax=true` + (v1 ? `&v1=${v1}` : "");
  return { page, api, v1 };
}

// sizes: undefined/"auto" = automatic rules, [] = any size, ["M", ...] = exactly these
const isAuto = sizes => sizes === undefined || sizes === null || sizes === "auto";

function itemKey(url, sizes) {
  const { page, v1 } = urlsFor(url);
  const s = isAuto(sizes) ? "auto" : (sizes.map(x => String(x).toUpperCase()).sort().join(",") || "any");
  return `${v1 || page}|${s}`;
}

const baseOf = key => key.split("|")[0];
const titleCase = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const nameFromUrl = url => titleCase(decodeURIComponent(new URL(url).pathname.split("/").pop()
  .replace(/-p\d+\.html$/i, "").replace(/-/g, " ")));

function hash(s) {   // short stable id for button data when a key is too long
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

async function getJson(url, ttl = 60) {
  const res = await fetch(url, { cf: { cacheTtl: ttl } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// KV: one key per writer, so the minute check and the bot never overwrite each other.
//   config  (bot + status page): chatId, origin, webhookUrl, tgSecret
//   watch   (bot):               added [{url, sizes?, addedAt}], bought [keys or base ids]
//   state   (minute check):      available {key: {item, sizes, since, reminded}}, problems, aliveAt
async function kvGet(env, key) {
  const v = (await env.STATE.get(key, "json")) || {};
  if (key === "watch") { v.added ??= []; v.bought ??= []; }
  if (key === "state") { v.available ??= {}; v.problems ??= {}; }
  return v;
}
async function kvPutIfChanged(env, key, value, before) {
  const after = JSON.stringify(value);
  if (after !== before) await env.STATE.put(key, after);
}

// ---------- Telegram ----------

async function tg(env, method, body) {
  const res = await fetch(`${TG}/bot${(env.TELEGRAM_TOKEN || "").trim()}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Telegram ${method}: ${data.description || `HTTP ${res.status}`}`);
  return data.result;
}

function send(env, chatId, text, buttons) {
  return tg(env, "sendMessage", {
    chat_id: chatId, text, link_preview_options: { is_disabled: true },
    ...(buttons ? { reply_markup: { inline_keyboard: [buttons] } } : {}),
  });
}

async function sendLong(env, chatId, text) {   // Telegram caps messages at 4,096 characters
  let chunk = "";
  for (const line of text.split("\n")) {
    if (chunk.length + line.length + 1 > 3800) { await send(env, chatId, chunk); chunk = ""; }
    chunk += (chunk ? "\n" : "") + line;
  }
  if (chunk) await send(env, chatId, chunk);
}

function cbData(action, key) {
  const d = `${action}:${key}`;
  return new TextEncoder().encode(d).length <= 64 ? d : `${action}#${hash(key)}`;
}

const buttons = (page, key, stopLabel = "Bought ✓") =>
  [{ text: "Open", url: page }, { text: stopLabel, callback_data: cbData("b", key) }];

// ---------- Zara ----------

// Fast path: pull just this colour's sizes out of the ~100 KB reply instead of parsing all of it.
// Returns null if anything looks unexpected; the caller then parses the whole reply.
function readFast(text, v1) {
  if (!v1) return null;
  const anchorStr = `"productId":${v1},`;
  const anchor = text.indexOf(anchorStr);
  if (anchor < 0) return null;
  const sizesAt = text.indexOf('"sizes":[', anchor);
  // the sizes must belong to this colour: no other colour's "productId" in between
  if (sizesAt < 0 || text.lastIndexOf('"productId":', sizesAt) !== anchor) return null;

  let i = sizesAt + 8, depth = 0, inStr = false, esc = false;   // walk to the matching "]"
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; continue; }
    if (c === 34) inStr = true;
    else if (c === 91 || c === 123) depth++;
    else if ((c === 93 || c === 125) && --depth === 0) break;
  }
  if (depth !== 0) return null;
  const arr = JSON.parse(text.slice(sizesAt + 8, i + 1));
  if (!Array.isArray(arr) || !arr.length ||
      !arr.every(s => typeof s?.name === "string" && typeof s?.availability === "string")) return null;

  const strAt = (key, from, within) => {   // first "key":"value" after `from`, within N chars
    const k = text.indexOf(`"${key}":"`, from);
    if (k < 0 || k - from > within) return undefined;
    const start = k + key.length + 4;
    let j = start; while (j < text.length && !(text[j] === '"' && text[j - 1] !== "\\")) j++;
    return JSON.parse(`"${text.slice(start, j)}"`);
  };
  // colour name = the colour object's own "name" (before any nested object/array starts)
  const objStart = text.lastIndexOf("{", anchor);
  const nameAt = text.indexOf('"name":"', objStart);
  let firstNested = text.slice(objStart + 1, sizesAt).search(/[[{]/);
  firstNested = firstNested < 0 ? sizesAt : objStart + 1 + firstNested;
  if (objStart < 0 || nameAt < 0 || nameAt > firstNested) return null;
  const productAt = text.indexOf('"product":{');
  return {
    name: productAt >= 0 ? strAt("name", productAt, 600) : undefined,
    kind: productAt >= 0 ? strAt("kind", productAt, 300) : undefined,
    colour: strAt("name", nameAt, 0),
    sizes: arr.map(s => [s.name, s.availability]),
  };
}

function readFull(text, v1) {
  const data = JSON.parse(text);
  const colours = data.product.detail.colors;
  const colour = v1 ? colours.find(c => String(c.productId) === String(v1)) : colours[0];
  if (!colour) throw new Error(`colour v1=${v1} is no longer on the page`);
  return { name: data.product.name, kind: data.product.kind, colour: colour.name,
           sizes: colour.sizes.map(s => [s.name, s.availability]) };
}

async function readZara(url) {
  const { api, v1 } = urlsFor(url);
  const res = await fetch(api, {
    headers: { "User-Agent": UA, "Accept": "application/json", "Accept-Language": "en" },
  });
  if (!res.ok) throw new Error(`Zara HTTP ${res.status}`);
  const text = await res.text();
  if (text.trimStart().startsWith("<")) throw new Error("Zara sent a web page instead of JSON (bot check?)");
  let info = null;
  try { info = readFast(text, v1); } catch { info = null; }
  info ??= readFull(text, v1);
  info.name ??= nameFromUrl(url);
  return info;
}

// ---------- which sizes to watch ----------

// Size names like "XS-S" or "36/38" match if any part matches.
const sizeMatches = (name, want) => {
  const n = String(name).toUpperCase().trim();
  return want.includes(n) || n.split(/[-/\s]+/).some(p => want.includes(p));
};

// Returns { want: [...] | null (any size), why: label }
function wantedSizes(item, info, rules) {
  if (!isAuto(item.sizes)) {
    const want = item.sizes.map(s => String(s).toUpperCase());
    return { want: want.length ? want : null, why: want.length ? "chosen" : "any size" };
  }
  const r = { ...DEFAULTS.sizeRules, ...(rules || {}) };
  const names = info.sizes.map(([s]) => String(s).trim());
  if (names.length === 1 && r.oneSize !== false) return { want: [names[0].toUpperCase()], why: "one size" };
  const numeric = names.length > 0 && names.every(n => /^\d{2,3}(?:[.,]5)?$/.test(n));
  if (numeric) {
    // Zara marks clothing as kind "Wear"; shoes come as "Other" (checked on real items, Oct 2026).
    // If kind is missing, odd numbers (35, 37, …) mean shoes: Zara trousers come in even sizes.
    const shoes = info.kind ? info.kind !== "Wear" : names.some(n => parseInt(n, 10) % 2 === 1);
    return shoes ? { want: r.shoes.map(String), why: "shoes" } : { want: r.numbers.map(String), why: "numbered clothing" };
  }
  return { want: r.letters.map(s => String(s).toUpperCase()), why: "clothing" };
}

// ---------- shared text ----------

function parseShare(text) {
  const urls = [...new Set((text.match(ZARA_URL_RE) || []).map(u => u.replace(/[).,]+$/, "")))];
  let sizes;   // undefined = automatic
  if (/\b(size\s*any|any\s*size)\b/i.test(text)) sizes = [];
  else {
    const m = text.match(/\bsizes?\s*[:=]?\s*([A-Za-z0-9 ,/.]+)/i);
    const list = m ? m[1].split(/[\s,/]+/).filter(t => SIZE_RE.test(t)).map(t => t.toUpperCase()) : [];
    if (list.length) sizes = list;
  }
  const stop = /\b(bought|stop|remove)\b/i.test(text);
  return { urls, sizes, stop };
}

async function loadSettings() {
  const settings = structuredClone(DEFAULTS);
  try {
    const s = await getJson(`${REPO_RAW}/settings.json`);
    Object.assign(settings, s, { sizeRules: { ...DEFAULTS.sizeRules, ...(s.sizeRules || {}) } });
  } catch { /* defaults */ }
  return settings;
}

async function loadLists() {
  let repoItems = [], repoError = null;
  try { repoItems = await getJson(`${REPO_RAW}/items.json`); } catch (e) { repoError = e.message; }
  return { repoItems, repoError };
}

function mergeWatch(repoItems, watch) {
  const list = new Map();
  for (const it of [...repoItems, ...watch.added]) {
    const item = typeof it === "string" ? { url: it } : it;
    const key = itemKey(item.url, item.sizes);
    if (!list.has(key)) list.set(key, item);
  }
  return list;
}

const isBought = (watch, key, item) =>
  item?.bought === true || watch.bought.includes(key) || watch.bought.includes(baseOf(key));

// Every minute checks one slice; each item comes round every `slots` minutes.
function schedule(activeCount, settings) {
  const every = Math.max(1, Math.round(Number(settings.checkEveryMin) || 1));
  const perRun = Math.max(1, Math.min(SUBREQUEST_LIMIT - 10, Math.round(Number(settings.maxItemsPerRun) || 35)));
  return { slots: Math.max(every, Math.ceil(activeCount / perRun)), every, perRun };
}

const sizeLabel = item => isAuto(item.sizes) ? "auto" : (item.sizes.join(", ") || "any");

// ---------- bot: messages and button taps (instant, via webhook) ----------

async function onUpdate(env, update) {
  const config = await kvGet(env, "config");
  const configBefore = JSON.stringify(config);

  if (update.callback_query) {
    const cq = update.callback_query;
    if (String(cq.message?.chat?.id) !== String(config.chatId)) return;
    const watch = await kvGet(env, "watch");
    const before = JSON.stringify(watch);
    const data = cq.data || "";
    let key = data.startsWith("b:") ? data.slice(2) : null;
    if (!key && data.startsWith("b#")) {
      const { repoItems } = await loadLists();
      key = [...mergeWatch(repoItems, watch).keys()].find(k => hash(k) === data.slice(2)) || null;
    }
    if (key && !watch.bought.includes(key)) watch.bought.push(key);
    await kvPutIfChanged(env, "watch", watch, before);
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: key ? "Stopped ✓ No more alerts for this one." : "Couldn't find that item." });
    if (key) {   // keep only the Open button on that message
      const open = (cq.message.reply_markup?.inline_keyboard?.[0] || []).filter(b => b.url);
      await tg(env, "editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id,
        reply_markup: { inline_keyboard: open.length ? [open] : [] } }).catch(() => {});
    }
    return;
  }

  const msg = update.message;
  if (!msg?.chat) return;
  const chatId = msg.chat.id;
  const text = (msg.text || msg.caption || "").trim();

  if (!config.chatId) {
    if (!text.startsWith("/start")) return send(env, chatId, "Press Start (or send /start) to link this chat.");
    config.chatId = chatId;   // first /start claims the bot
    await kvPutIfChanged(env, "config", config, configBefore);
    return send(env, chatId, `Linked ✓ Alerts will arrive here.\n\n${HELP}`);
  }
  if (String(chatId) !== String(config.chatId)) return send(env, chatId, "This is a private bot.");

  if (text.startsWith("/start") || text.startsWith("/help")) return send(env, chatId, HELP);
  if (text.startsWith("/list")) return sendLong(env, chatId, await listText(env));

  const share = parseShare(text);
  if (!share.urls.length) return send(env, chatId, `I didn't find a Zara link in that.\n\n${HELP}`);

  const watch = await kvGet(env, "watch");
  const before = JSON.stringify(watch);
  const settings = await loadSettings();
  const replies = [];
  for (const url of share.urls) {
    // only product pages; shared favourites lists (/share/...) are off-limits per Zara's robots.txt
    if (!/-p\d+\.html/i.test(new URL(url).pathname)) {
      replies.push(["Couldn't add that: it's not a single product link. Favourites lists can't be watched; share each product instead."]);
      continue;
    }
    const { page, v1 } = urlsFor(url);
    const base = v1 || page;
    if (share.stop) {
      if (!watch.bought.includes(base)) watch.bought.push(base);
      replies.push([`✓ Stopped watching ${nameFromUrl(page)}.`]);
      continue;
    }
    const item = { url: page, ...(share.sizes ? { sizes: share.sizes } : {}), addedAt: new Date().toISOString() };
    const key = itemKey(page, item.sizes);
    watch.bought = watch.bought.filter(b => baseOf(b) !== base);       // re-sharing re-arms
    watch.added = watch.added.filter(a => baseOf(itemKey(a.url, a.sizes)) !== base);   // replaces older sizes
    watch.added.push(item);
    try {
      const info = await readZara(url);
      const { want, why } = wantedSizes(item, info, settings.sizeRules);
      const watched = info.sizes.filter(([s]) => !want || sizeMatches(s, want));
      const now = watched.length
        ? watched.map(([s, a]) => `${s} ${a.replace(/_/g, " ")}`).join(", ")
        : `none of ${want.join("/")} exist for this item (it has ${info.sizes.map(s => s[0]).join("/")}); send the link again with "size …"`;
      const label = want ? `sizes ${want.join(", ")}${why === "chosen" ? "" : ` (${why})`}` : "any size";
      replies.push([`👀 Now watching ${titleCase(info.name)} (${info.colour}), ${label}.\nNow: ${now}.`, buttons(page, key, "Stop")]);
    } catch (e) {
      replies.push([`👀 Added ${nameFromUrl(page)}, but I can't read it yet (${e.message}). I'll keep trying.`, buttons(page, key, "Stop")]);
    }
  }
  await kvPutIfChanged(env, "watch", watch, before);
  for (const [t, b] of replies) await send(env, chatId, t, b);
}

async function listText(env) {
  const [watch, state] = await Promise.all([kvGet(env, "watch"), kvGet(env, "state")]);
  const [{ repoItems }, settings] = await Promise.all([loadLists(), loadSettings()]);
  const lines = [];
  for (const [key, item] of mergeWatch(repoItems, watch)) {
    if (isBought(watch, key, item)) continue;
    const a = state.available[key];
    lines.push(`${a ? "🛍️" : "⏳"} ${a ? a.item : nameFromUrl(item.url)}: ${sizeLabel(item)}${a ? `, IN STOCK: ${a.sizes.join(", ")}` : ""}`);
  }
  const { slots } = schedule(lines.length, settings);
  return lines.length
    ? `Watching ${lines.length}, each checked every ${slots} min:\n${lines.join("\n")}`
    : "Nothing is being watched. Share a Zara link here to start.";
}

// ---------- the check (cron fires every minute and checks one slice of the list) ----------

async function runCheck(env, now = Date.now()) {
  now = Math.floor(now / MIN) * MIN;   // cron runs on whole minutes
  const nowIso = new Date(now).toISOString();
  const [config, watch, state] = await Promise.all([kvGet(env, "config"), kvGet(env, "watch"), kvGet(env, "state")]);
  const before = JSON.stringify(state);
  const [settings, { repoItems, repoError }] = await Promise.all([loadSettings(), loadLists()]);
  let used = 2;   // outside requests so far this run (settings + list)

  const problem = (k, msg) => { state.problems[k] = { since: state.problems[k]?.since || nowIso, msg: msg.slice(0, 200) }; };
  const ok = k => { delete state.problems[k]; };
  if (repoError) problem("_list", `can't read items.json: ${repoError}`); else ok("_list");
  if (!env.TELEGRAM_TOKEN) problem("_telegram", "secret TELEGRAM_TOKEN is missing");
  else if (!config.chatId) problem("_telegram", "no Telegram chat linked yet: open the bot and press Start");
  else ok("_telegram");
  const chatId = config.chatId;
  const canSend = Boolean(env.TELEGRAM_TOKEN && chatId);
  const remindMs = Math.max(1, Number(settings.remindAfterMin) || 60) * MIN;
  let sendFailed = false;
  delete state.problemSince; delete state.lastProblem;   // fields from the previous version

  const list = mergeWatch(repoItems, watch);
  const active = [...list].filter(([key, item]) => !isBought(watch, key, item)).sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [key, item] of list) if (isBought(watch, key, item)) { delete state.available[key]; ok(key); }
  const { slots } = schedule(active.length, settings);
  const slot = Math.floor(now / MIN) % slots;
  state.interval = slots;
  const due = active.filter((_, i) => i % slots === slot);
  // Reserve one request per due check (+1 for a possible warning); alerts get what's left.
  let sendsLeft = SUBREQUEST_LIMIT - used - due.length - 1;

  for (const [key, item] of due) {
    let info;
    used++;
    try { info = await readZara(item.url); }
    catch (e) { problem(key, `${nameFromUrl(item.url)}: ${e.message}`); continue; }

    const { want } = wantedSizes(item, info, settings.sizeRules);
    const watched = info.sizes.filter(([s]) => !want || sizeMatches(s, want));
    if (!watched.length) {
      problem(key, `${titleCase(info.name)} (${info.colour}): sizes ${want.join("/")} don't exist (has ${info.sizes.map(s => s[0]).join("/")})`);
      delete state.available[key];
      continue;
    }
    ok(key);
    const hits = watched.filter(([, a]) => BUYABLE.has(a)).map(([s]) => s);
    if (!hits.length) { delete state.available[key]; continue; }   // sold out: the next restock alerts again
    if (!canSend) continue;                                       // alert once a chat is linked

    // One "Back in stock" when a watched size becomes buyable, then ONE reminder after
    // remindAfterMin if it's still buyable.
    const prev = state.available[key] || {};
    const fresh = hits.filter(s => !(prev.sizes || []).includes(s));
    const since = prev.since ? Date.parse(prev.since) : null;
    const isNew = since === null || fresh.length > 0;
    const reminderDue = !isNew && !prev.reminded && now - since >= remindMs;
    let sinceIso = prev.since || null, reminded = Boolean(prev.reminded);
    const page = urlsFor(item.url).page;

    if (isNew || reminderDue) {
      if (sendsLeft <= 0) {                      // out of requests this run: alert on this item's next turn
        if (isNew) continue;
      } else {
        sendsLeft--; used++;
        const mins = Math.round((now - since) / MIN);
        const text = isNew
          ? `🛍️ Back in stock: ${titleCase(info.name)}\n${info.colour}, size ${(fresh.length ? fresh : hits).join(", ")}`
          : `⏰ Still in stock after ${mins >= 60 && mins % 60 === 0 ? `${mins / 60} h` : `${mins} min`}: ${titleCase(info.name)}\n` +
            `${info.colour}, size ${hits.join(", ")}. This is the only reminder.`;
        try {
          await send(env, chatId, text, buttons(page, key));
          if (isNew) { sinceIso = nowIso; reminded = false; } else reminded = true;
        } catch (e) {
          problem("_send", `sending alert: ${e.message}`);
          sendFailed = true;
          if (isNew) continue;   // not recorded, so the next turn retries the alert
        }
      }
    }
    state.available[key] = { item: `${titleCase(info.name)} (${info.colour})`, sizes: hits, since: sinceIso,
                             ...(reminded ? { reminded: true } : {}) };
  }
  if (!sendFailed) ok("_send");   // unsent alerts were not recorded, so they retry and re-flag if still failing

  // forget anything no longer on the list
  for (const key of Object.keys(state.available)) if (!list.has(key)) delete state.available[key];
  for (const key of Object.keys(state.problems)) if (!key.startsWith("_") && !list.has(key)) delete state.problems[key];

  // don't fail silently: one message if a problem persists 30+ min, then at most daily
  const probs = Object.values(state.problems);
  if (probs.length) {
    const oldest = Math.min(...probs.map(p => Date.parse(p.since)));
    const quiet = !state.problemPushedAt || now - Date.parse(state.problemPushedAt) >= 24 * 60 * MIN;
    if (now - oldest >= 30 * MIN && quiet && canSend && used < SUBREQUEST_LIMIT) {
      try {
        await send(env, chatId, `⚠️ Zara watcher needs a look: ${probs.length} problem(s), e.g. ${probs[0].msg}`);
        state.problemPushedAt = nowIso;
      } catch { /* Telegram down; the status page still shows it */ }
    }
  } else delete state.problemPushedAt;

  // keep KV writes low: note "alive" every 30 min, not every minute
  if (!state.aliveAt || now - Date.parse(state.aliveAt) >= 30 * MIN) state.aliveAt = nowIso;
  await kvPutIfChanged(env, "state", state, before);
  return { state, checked: due.length, slots, used };
}

// ---------- web: Telegram webhook + status page ----------

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/telegram") {
    const config = await kvGet(env, "config");
    if (request.method !== "POST" || !config.tgSecret ||
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== config.tgSecret) {
      return new Response("Forbidden", { status: 403 });
    }
    try { await onUpdate(env, await request.json()); }
    catch (e) { console.log("telegram update failed:", e.message); }
    return new Response("ok");   // always 200, or Telegram keeps re-sending the update
  }

  // status page; visiting it also connects the bot (webhook) to this address
  const config = await kvGet(env, "config");
  const before = JSON.stringify(config);
  config.origin = url.origin;
  if (!config.tgSecret) {
    const b = crypto.getRandomValues(new Uint8Array(24));
    config.tgSecret = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  }
  let bot = null, botError = null;
  if (env.TELEGRAM_TOKEN) {
    try {
      bot = await tg(env, "getMe", {});
      const hook = `${url.origin}/telegram`;
      if (config.webhookUrl !== hook) {
        await tg(env, "setWebhook", { url: hook, secret_token: config.tgSecret, allowed_updates: ["message", "callback_query"] });
        config.webhookUrl = hook;
      }
    } catch (e) { botError = e.message; }
  }
  await kvPutIfChanged(env, "config", config, before);

  const [watch, state] = await Promise.all([kvGet(env, "watch"), kvGet(env, "state")]);
  const { repoItems } = await loadLists();
  const list = mergeWatch(repoItems, watch);
  const activeCount = [...list].filter(([k, it]) => !isBought(watch, k, it)).length;
  const yes = (good, a, b) => (good ? `✅ ${a}` : `❌ ${b}`);
  const rows = Object.values(state.available).map(a =>
    `<li>🛍️ <b>${esc(a.item)}</b>: ${esc(a.sizes.join(", "))} in stock (alerted ${esc(a.since || "-")})</li>`).join("");
  const probs = Object.values(state.problems || {}).slice(0, 5).map(p =>
    `<li>⚠️ since ${esc(p.since)}: ${esc(p.msg)}</li>`).join("");
  const shared = watch.added.map(a => {
    const stopped = isBought(watch, itemKey(a.url, a.sizes));
    return `<li>${esc(nameFromUrl(a.url))}: ${esc(sizeLabel(a))}${stopped ? " (stopped)" : ""}</li>`;
  }).join("");
  const botLink = bot ? `<a href="https://t.me/${esc(bot.username)}">@${esc(bot.username)}</a>` : "your bot";
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zara watcher</title><body style="font:16px system-ui;max-width:640px;margin:24px auto;padding:0 16px">
<h1>Zara watcher</h1>
<p>${yes(env.TELEGRAM_TOKEN && !botError, `Telegram bot ${botLink}`, botError ? `Telegram: ${esc(botError)}` : "secret TELEGRAM_TOKEN missing")}<br>
${yes(config.webhookUrl, "bot connected to this Worker", "bot not connected yet")}<br>
${yes(config.chatId, "chat linked", `no chat linked: open ${botLink} and press Start`)}<br>
${yes(env.STATE, "storage (KV) bound", "KV binding STATE missing")}<br>
watching ${activeCount} item(s), each checked every ${esc(state.interval || "?")} min · last alive: ${esc(state.aliveAt || "not run yet: add the cron trigger * * * * *")}</p>
${probs ? `<ul>${probs}</ul>` : "<p>✅ No problems</p>"}
<h2>In stock now</h2><ul>${rows || "<li>Nothing watched is in stock.</li>"}</ul>
<h2>Added in Telegram</h2><ul>${shared || "<li>None yet. Share a Zara link with the bot.</li>"}</ul>
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
  _test: { runCheck, handleRequest, onUpdate, parseShare, itemKey, urlsFor, hash, readFast, readFull,
           wantedSizes, sizeMatches, schedule },   // local tests only
};
