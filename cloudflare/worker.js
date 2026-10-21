// Zara restock watcher: Cloudflare Worker + Telegram bot, checks every minute.
//
// Setup (Cloudflare → this Worker → Settings):
//   - KV namespace binding named STATE
//   - Secret TELEGRAM_TOKEN (from @BotFather)
//   - Cron trigger "* * * * *"
// Then open the Worker's address once (connects the bot), and press Start in your bot's chat.
//
// In the bot chat: share or paste a Zara product link to watch it (sizes from settings.json,
// default S and XS; add "size M" to override). "stop <link>" or the Bought button stops it.
// /list shows everything being watched.

const REPO_RAW = "https://raw.githubusercontent.com/jsva0ne/Zara-Stock-Test/main";
const TG = "https://api.telegram.org";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const BUYABLE = new Set(["in_stock", "low_on_stock"]);
const DEFAULTS = { remindEveryMin: 60, defaultSizes: ["S", "XS"] };
const SIZE_RE = /^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|\d{2,3})$/i;
const ZARA_URL_RE = /https?:\/\/(?:www\.)?zara\.com\/[^\s"'<>]+/gi;
const MIN = 60_000;
const HELP = "Share or paste a Zara product link here to watch it.\n" +
             "• Sizes: S and XS by default; write e.g. \"size M\" with the link to change.\n" +
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

function itemKey(url, sizes) {
  const { page, v1 } = urlsFor(url);
  const s = (sizes || []).map(x => String(x).toUpperCase()).sort().join(",");
  return `${v1 || page}|${s || "any"}`;
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
//   watch   (bot):               added [{url, sizes, addedAt}], bought [keys or base ids]
//   state   (minute check):      available {key: {item, sizes, since}}, problem info, aliveAt
async function kvGet(env, key) {
  const v = (await env.STATE.get(key, "json")) || {};
  if (key === "watch") { v.added ??= []; v.bought ??= []; }
  if (key === "state") { v.available ??= {}; }
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

function cbData(action, key) {
  const d = `${action}:${key}`;
  return new TextEncoder().encode(d).length <= 64 ? d : `${action}#${hash(key)}`;
}

const buttons = (page, key, stopLabel = "Bought ✓") =>
  [{ text: "Open", url: page }, { text: stopLabel, callback_data: cbData("b", key) }];

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
  return { name: data.product.name, colour: colour.name, sizes: colour.sizes.map(s => [s.name, s.availability]) };
}

// ---------- shared text ----------

function parseShare(text) {
  const urls = [...new Set((text.match(ZARA_URL_RE) || []).map(u => u.replace(/[).,]+$/, "")))];
  const m = text.match(/\bsizes?\s*[:=]?\s*([A-Za-z0-9 ,/]+)/i);
  const sizes = m ? m[1].split(/[\s,/]+/).filter(t => SIZE_RE.test(t)).map(t => t.toUpperCase()) : [];
  const stop = /\b(bought|stop|remove)\b/i.test(text);
  return { urls, sizes, stop };
}

async function loadLists() {
  const settings = { ...DEFAULTS };
  try { Object.assign(settings, await getJson(`${REPO_RAW}/settings.json`)); } catch { /* defaults */ }
  let repoItems = [], repoError = null;
  try { repoItems = await getJson(`${REPO_RAW}/items.json`); } catch (e) { repoError = e.message; }
  return { settings, repoItems, repoError };
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
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: key ? "Stopped ✓ No more reminders for this one." : "Couldn't find that item." });
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
  if (text.startsWith("/list")) return send(env, chatId, await listText(env));

  const share = parseShare(text);
  if (!share.urls.length) return send(env, chatId, `I didn't find a Zara link in that.\n\n${HELP}`);

  const watch = await kvGet(env, "watch");
  const before = JSON.stringify(watch);
  const { settings } = await loadLists();
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
    const sizes = share.sizes.length ? share.sizes : settings.defaultSizes;
    const key = itemKey(url, sizes);
    watch.bought = watch.bought.filter(b => b !== key && b !== base);   // re-sharing re-arms
    watch.added = watch.added.filter(a => itemKey(a.url, a.sizes) !== key);
    watch.added.push({ url: page, sizes, addedAt: new Date().toISOString() });
    try {
      const info = await readZara(url);
      const want = sizes.map(s => s.toUpperCase());
      const watched = info.sizes.filter(([s]) => want.includes(s.toUpperCase()));
      const now = watched.length
        ? watched.map(([s, a]) => `${s} ${a.replace(/_/g, " ")}`).join(", ")
        : `none of ${want.join("/")} exist for this item (it has ${info.sizes.map(s => s[0]).join("/")}); send the link again with "size …"`;
      replies.push([`👀 Now watching ${titleCase(info.name)} (${info.colour}), sizes ${want.join(", ")}.\nNow: ${now}.`, buttons(page, key, "Stop")]);
    } catch (e) {
      replies.push([`👀 Added ${nameFromUrl(page)}, but I can't read it yet (${e.message}). I'll keep trying.`, buttons(page, key, "Stop")]);
    }
  }
  await kvPutIfChanged(env, "watch", watch, before);
  for (const [t, b] of replies) await send(env, chatId, t, b);
}

async function listText(env) {
  const [watch, state] = await Promise.all([kvGet(env, "watch"), kvGet(env, "state")]);
  const { repoItems } = await loadLists();
  const lines = [];
  for (const [key, item] of mergeWatch(repoItems, watch)) {
    if (isBought(watch, key, item)) continue;
    const a = state.available[key];
    const sizes = (item.sizes || []).join(", ") || "any";
    lines.push(`${a ? "🛍️" : "⏳"} ${a ? a.item : nameFromUrl(item.url)}: ${sizes}${a ? `, IN STOCK: ${a.sizes.join(", ")}` : ""}`);
  }
  return lines.length ? `Watching ${lines.length}:\n${lines.join("\n")}` : "Nothing is being watched. Share a Zara link here to start.";
}

// ---------- the minute check ----------

async function runCheck(env, now = Date.now()) {
  now = Math.floor(now / MIN) * MIN;   // cron runs on whole minutes
  const [config, watch, state] = await Promise.all([kvGet(env, "config"), kvGet(env, "watch"), kvGet(env, "state")]);
  const before = JSON.stringify(state);
  const problems = [];
  const { settings, repoItems, repoError } = await loadLists();
  if (repoError) problems.push(`can't read items.json: ${repoError}`);
  const remindMs = Math.max(1, settings.remindEveryMin) * MIN;
  const chatId = config.chatId;
  if (!env.TELEGRAM_TOKEN) problems.push("secret TELEGRAM_TOKEN is missing");
  else if (!chatId) problems.push("no Telegram chat linked yet: open the bot and press Start");
  const canSend = Boolean(env.TELEGRAM_TOKEN && chatId);

  const list = mergeWatch(repoItems, watch);
  for (const [key, item] of list) {
    if (isBought(watch, key, item)) { delete state.available[key]; continue; }
    let info;
    try { info = await readZara(item.url); }
    catch (e) { problems.push(`${nameFromUrl(item.url)}: ${e.message}`); continue; }

    const want = (item.sizes || []).map(s => String(s).toUpperCase());
    const watched = info.sizes.filter(([s]) => !want.length || want.includes(s.toUpperCase()));
    if (want.length && !watched.length) {
      problems.push(`${titleCase(info.name)} (${info.colour}): sizes ${want.join("/")} don't exist (has ${info.sizes.map(s => s[0]).join("/")})`);
      continue;
    }
    const hits = watched.filter(([, a]) => BUYABLE.has(a)).map(([s]) => s);
    if (!hits.length) { delete state.available[key]; continue; }
    if (!canSend) continue;   // alert once a chat is linked

    // Reminders are timed from the first alert, so they need no storage writes
    // (free plan allows ~1,000 writes/day): remind in the minute each full interval completes.
    const prev = state.available[key] || {};
    const fresh = hits.filter(s => !(prev.sizes || []).includes(s));
    const since = prev.since ? Date.parse(prev.since) : null;
    const age = since === null ? 0 : now - since;
    const reminderDue = since !== null && age >= remindMs && age % remindMs < MIN;
    const isNew = since === null || fresh.length > 0;
    let sinceIso = prev.since || null;
    const page = urlsFor(item.url).page;

    if (isNew || reminderDue) {
      const text = isNew
        ? `🛍️ Back in stock: ${titleCase(info.name)}\n${info.colour}, size ${(fresh.length ? fresh : hits).join(", ")}`
        : `⏰ Still in stock: ${titleCase(info.name)}\n${info.colour}, size ${hits.join(", ")}. Tap Bought to stop reminders.`;
      try {
        await send(env, chatId, text, buttons(page, key));
        if (isNew) sinceIso = new Date(now).toISOString();   // restart the reminder clock
      } catch (e) {
        problems.push(`sending alert: ${e.message}`);
        if (isNew) continue;   // not recorded, so the next minute retries the alert
      }
    }
    state.available[key] = { item: `${titleCase(info.name)} (${info.colour})`, sizes: hits, since: sinceIso };
  }

  for (const key of Object.keys(state.available)) if (!list.has(key)) delete state.available[key];

  // don't fail silently: one message if problems persist 30+ min, then at most daily
  if (problems.length) {
    state.problemSince ??= new Date(now).toISOString();
    state.lastProblem = problems[0].slice(0, 300);
    const persisting = now - Date.parse(state.problemSince) >= 30 * MIN;
    const quiet = !state.problemPushedAt || now - Date.parse(state.problemPushedAt) >= 24 * 60 * MIN;
    if (persisting && quiet && canSend) {
      try {
        await send(env, chatId, `⚠️ Zara watcher needs a look: ${problems.length} problem(s), e.g. ${problems[0]}`);
        state.problemPushedAt = new Date(now).toISOString();
      } catch { /* Telegram down; the status page still shows it */ }
    }
  } else {
    delete state.problemSince; delete state.lastProblem; delete state.problemPushedAt;
  }

  // keep KV writes low: note "alive" every 30 min, not every minute
  if (!state.aliveAt || now - Date.parse(state.aliveAt) >= 30 * MIN) state.aliveAt = new Date(now).toISOString();
  await kvPutIfChanged(env, "state", state, before);
  return { state, problems };
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
  const ok = (good, yes, no) => (good ? `✅ ${yes}` : `❌ ${no}`);
  const rows = Object.values(state.available).map(a =>
    `<li>🛍️ <b>${esc(a.item)}</b>: ${esc(a.sizes.join(", "))} in stock (alerted ${esc(a.since || "-")})</li>`).join("");
  const shared = watch.added.map(a => {
    const stopped = isBought(watch, itemKey(a.url, a.sizes));
    return `<li>${esc(nameFromUrl(a.url))}: ${esc((a.sizes || []).join(", ") || "any")}${stopped ? " (stopped)" : ""}</li>`;
  }).join("");
  const botLink = bot ? `<a href="https://t.me/${esc(bot.username)}">@${esc(bot.username)}</a>` : "your bot";
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zara watcher</title><body style="font:16px system-ui;max-width:640px;margin:24px auto;padding:0 16px">
<h1>Zara watcher</h1>
<p>${ok(env.TELEGRAM_TOKEN && !botError, `Telegram bot ${botLink}`, botError ? `Telegram: ${esc(botError)}` : "secret TELEGRAM_TOKEN missing")}<br>
${ok(config.webhookUrl, "bot connected to this Worker", "bot not connected yet")}<br>
${ok(config.chatId, "chat linked", `no chat linked: open ${botLink} and press Start`)}<br>
${ok(env.STATE, "storage (KV) bound", "KV binding STATE missing")}<br>
last alive: ${esc(state.aliveAt || "not run yet: add the cron trigger * * * * *")}</p>
${state.lastProblem ? `<p>⚠️ Since ${esc(state.problemSince)}: ${esc(state.lastProblem)}</p>` : "<p>✅ No problems</p>"}
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
  _test: { runCheck, handleRequest, onUpdate, parseShare, itemKey, urlsFor, hash },   // local tests only
};
