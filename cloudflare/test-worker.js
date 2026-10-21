// Zara watcher: Cloudflare reachability + capacity test.
// Paste into a new Cloudflare Worker, deploy, open its URL.
// It only READS: no notifications, nothing saved.
//
//   https://<your-worker>.workers.dev/          normal test
//   https://<your-worker>.workers.dev/?load=5   reads each product 5x (CPU headroom probe)

const ITEMS_URL = "https://raw.githubusercontent.com/jsva0ne/Zara-Stock-Test/main/items.json";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/141.0 Safari/537.36";

function urlsFor(shareUrl) {
  const u = new URL(shareUrl.trim());
  const v1 = u.searchParams.get("v1");
  const path = u.pathname.toLowerCase();
  const page = `https://www.zara.com${path}` + (v1 ? `?v1=${v1}` : "");
  const api = `https://www.zara.com${path}?ajax=true` + (v1 ? `&v1=${v1}` : "");
  return { page, api, v1 };
}

export default {
  async fetch(request) {
    const load = Math.max(1, Math.min(20, parseInt(new URL(request.url).searchParams.get("load") || "1", 10) || 1));
    const report = {
      ranAt: new Date().toISOString(),
      cloudflareDatacenter: request.cf?.colo ?? "?",
      load,
      verdict: "",
      items: [],
    };

    let items;
    try {
      items = await (await fetch(ITEMS_URL, { cf: { cacheTtl: 60 } })).json();
    } catch (e) {
      report.verdict = `Could not read items.json from GitHub: ${e}`;
      return Response.json(report, { status: 500 });
    }

    for (const item of items) {
      const { page, api, v1 } = urlsFor(typeof item === "string" ? item : item.url);
      const r = { page };
      try {
        const res = await fetch(api, {
          headers: { "User-Agent": UA, "Accept": "application/json", "Accept-Language": "en" },
        });
        r.zaraHttp = res.status;
        const text = await res.text();
        r.kilobytes = Math.round(text.length / 1024);
        if (text.trimStart().startsWith("<")) throw new Error("Zara sent a web page instead of JSON (bot check?)");
        let data;
        for (let i = 0; i < load; i++) data = JSON.parse(text);
        const colours = data.product.detail.colors;
        const colour = colours.find(c => String(c.productId) === String(v1)) ?? colours[0];
        r.name = data.product.name;
        r.colour = colour.name;
        r.sizes = Object.fromEntries(colour.sizes.map(s => [s.name, s.availability]));
      } catch (e) {
        r.error = String(e).slice(0, 200);
      }
      report.items.push(r);
    }

    const ok = report.items.filter(r => r.sizes).length;
    report.verdict = ok === report.items.length
      ? `PASS: Zara answered Cloudflare for all ${ok} items.`
      : `FAIL: ${report.items.length - ok} of ${report.items.length} items could not be read; see "error".`;
    return Response.json(report, { status: ok === report.items.length ? 200 : 502 });
  },
};
