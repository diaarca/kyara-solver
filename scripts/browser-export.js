// Run this file as a DevTools Sources > Snippets snippet on https://kyara.games.
// Then run: await kyaraExport({ packIds: ["season-2026-fall"] })
// To collect every booster pool and every card price: packIds: ["*"]
// Requests are sequential and at least 1.1 seconds apart. No packs are opened.
globalThis.kyaraExport = async function ({ packIds = ["season-2026-fall"] } = {}) {
  if (location.origin !== "https://kyara.games") throw new Error("Run on https://kyara.games");
  if (!Array.isArray(packIds) || !packIds.length || packIds.some(id => typeof id !== "string" || !id)) {
    throw new Error("packIds must be a nonempty array of booster IDs");
  }
  if (globalThis.kyaraExportRunning) throw new Error("An export is already running");
  globalThis.kyaraExportRunning = true;
  globalThis.kyaraExportAbort = false;
  const raw = { characters: {}, prices: {}, pack_pools: {}, rules: {}, fetched_at: {} };
  let lastStart = 0;
  let completed = false;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function get(path) {
    if (globalThis.kyaraExportAbort) throw new Error("Export stopped by user");
    await pause(Math.max(0, 1100 - (Date.now() - lastStart)));
    if (globalThis.kyaraExportAbort) throw new Error("Export stopped by user");
    lastStart = Date.now();
    const headers = { Accept: "application/json" };
    // Read credentials locally, send them only to this exact origin, never export.
    const token = localStorage.getItem("kyara_token");
    const device = localStorage.getItem("kyara_device");
    if (token) headers.Authorization = `Bearer ${token}`;
    if (device) headers["x-device-id"] = device;
    const response = await fetch(`/api${path}`, {
      method: "GET", headers, credentials: "same-origin", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} at ${path}; export paused`);
    if (!(response.headers.get("content-type") || "").includes("json")) {
      throw new Error(`Non-JSON response at ${path}; export paused`);
    }
    const body = await response.json();
    raw.fetched_at[path] = new Date().toISOString();
    return body;
  }
  function download() {
    if (!raw.catalog || !raw.packs) return;
    raw.collected_at = new Date().toISOString();
    const blob = new Blob([JSON.stringify(raw, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `kyara-${completed ? "export" : "partial"}-${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  try {
    raw.catalog = await get("/characters");
    raw.packs = await get("/packs");
    if (!Array.isArray(raw.catalog) || !Array.isArray(raw.packs)) throw new Error("Unexpected catalogue schema");
    raw.rules.rates = await get("/rates");
    const config = await get("/config");
    const allowed = ["catalogSize", "dropWeights", "pity", "golden", "godPackChance", "godPackSlots", "recycle"];
    raw.rules.config = Object.fromEntries(allowed.filter(k => k in config).map(k => [k, config[k]]));
    const selected = packIds.includes("*") ? raw.packs : raw.packs.filter(p => packIds.includes(String(p.id)));
    if (!packIds.includes("*") && selected.length !== new Set(packIds).size) throw new Error("Unknown booster ID");
    const wanted = new Set();
    for (const pack of selected) {
      const bid = String(pack.id);
      const pool = await get(`/packs/${encodeURIComponent(bid)}/characters`);
      if (!Array.isArray(pool) || pool.some(id => !["number", "string"].includes(typeof id))) {
        throw new Error(`Unexpected card-pool schema for ${bid}`);
      }
      raw.pack_pools[bid] = pool;
      pool.forEach(id => wanted.add(String(id)));
    }
    console.info(`Collecting ${wanted.size} cards; allow roughly ${Math.ceil(wanted.size * 1.1 / 60)} minutes. Stop with kyaraExportAbort = true.`);
    let count = 0;
    for (const cid of wanted) {
      const detail = await get(`/characters/${encodeURIComponent(cid)}`);
      if (String(detail.id) !== cid) throw new Error(`Unexpected character response for ${cid}`);
      raw.characters[cid] = detail;
      if (Object.prototype.hasOwnProperty.call(detail, "prices")) {
        raw.prices[cid] = detail.prices;
        raw.fetched_at[`/market/prices/${cid}`] = raw.fetched_at[`/characters/${cid}`];
      } else {
        raw.prices[cid] = await get(`/market/prices/${encodeURIComponent(cid)}`);
      }
      if (++count % 25 === 0) console.info(`Collected ${count}/${wanted.size} cards`);
    }
    completed = true;
    console.info("Export complete; downloading response bundle.");
  } catch (error) {
    console.warn("Export stopped. Downloading captured responses if available.");
    throw error;
  } finally {
    // Keep an in-memory recovery copy if the browser blocks automatic downloads.
    globalThis.kyaraExportData = raw;
    globalThis.kyaraExportRunning = false;
    download();
  }
  return { cards: Object.keys(raw.characters).length, pools: Object.keys(raw.pack_pools).length };
};
