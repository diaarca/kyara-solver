// Define in a Kyara DevTools snippet, then run await kyaraInvestigatePrices().
// A small read-only investigation, not a full-catalogue scrape. It records no
// request credentials, account responses, or token-bearing URLs.
globalThis.kyaraInvestigatePrices = async function ({ catalog = null, includeSources = false } = {}) {
  if (location.origin !== "https://kyara.games") throw new Error("Run on https://kyara.games");
  const report = { schema_version: 1, investigated_at: new Date().toISOString(),
    responses: {}, errors: {}, comparisons: [], client_sources: {} };
  let last = 0;
  async function request(path, asText = false) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 1100 - (Date.now() - last))));
    last = Date.now();
    const headers = { Accept: asText ? "text/javascript" : "application/json" };
    const token = localStorage.getItem("kyara_token"), device = localStorage.getItem("kyara_device");
    if (!asText && token) headers.Authorization = `Bearer ${token}`;
    if (!asText && device) headers["x-device-id"] = device;
    const response = await fetch(path, { method: "GET", headers, credentials: "same-origin",
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      report.errors[path] = { status: response.status };
      if ([401, 403, 429, 503].includes(response.status)) throw new Error(`HTTP ${response.status}: investigation stopped`);
      return null;
    }
    if (asText) return response.text();
    if (!(response.headers.get("content-type") || "").includes("json")) throw new Error("Non-JSON response; stopped");
    const body = await response.json();
    report.responses[path] = { fetched_at: new Date().toISOString(), body };
    return body;
  }
  try {
    const cards = catalog || await request("/api/characters");
    if (!Array.isArray(cards)) throw new Error("Unexpected catalogue schema");
    // Compare two cards per rarity, so the diagnostic is small and varied.
    const ids = [...new Set(["C", "U", "R", "E", "L", "M"].flatMap(r =>
      cards.filter(c => c.rarity === r).slice(0, 2).map(c => String(c.id))))];
    const batchIds = cards.slice(0, 200).map(c => String(c.id));
    ids.forEach(id => { if (!batchIds.includes(id)) batchIds.unshift(id); });
    batchIds.length = Math.min(batchIds.length, 200);
    // Confirmed in Kyara's own cached client; response schema and unrestricted
    // catalogue coverage still need live validation after service recovery.
    await request(`/api/me/collection/prices?ids=${ids.join(",")}`);
    const fair = await request(`/api/fair-play/prices?ids=${batchIds.join(",")}`);
    // One read-only check for a bulk version of the known market-price route.
    await request(`/api/market/prices?ids=${ids.join(",")}`);
    for (const id of ids) {
      const price = await request(`/api/market/prices/${encodeURIComponent(id)}`);
      if (!price) continue;
      report.comparisons.push({ id, fair_price: fair?.[id] ?? null,
        median7d: price.median7d ?? null, median30d: price.median30d ?? null,
        matches7d: typeof fair?.[id] === "number" && fair[id] === price.median7d,
        matches30d: typeof fair?.[id] === "number" && fair[id] === price.median30d });
    }
    const resources = performance.getEntriesByType("resource").map(e => new URL(e.name, location.href));
    const scripts = [...new Set(resources.filter(u => u.origin === location.origin &&
      u.pathname.startsWith("/_app/immutable/") && u.pathname.endsWith(".js")).map(u => u.pathname))];
    // Capture the public software only; never include page HTML or account state.
    for (const path of includeSources ? scripts.slice(0, 10) : []) {
      const source = await request(path, true);
      if (source !== null) report.client_sources[path] = source;
    }
    console.table(report.comparisons);
    console.info("Investigation complete. Matching sample prices do not prove identical semantics.");
  } finally {
    report.finished_at = new Date().toISOString();
    globalThis.kyaraPriceInvestigation = report;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = "kyara-price-investigation.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  return report.comparisons;
};
