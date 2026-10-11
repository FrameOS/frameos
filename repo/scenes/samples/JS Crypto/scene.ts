import type { Scene, Canvas } from "frameos";

// Price and a seven-day sparkline. The API response is reduced to one
// Float32Array of prices the moment it arrives; the parsed JSON is dropped
// before anything is drawn, so the heap holds a few KB, not the payload.

const MAX_POINTS = 400;
let prices = new Float32Array(0);
let points = new Float32Array(MAX_POINTS * 2);
let latest = 0;
let first = 0;
let fetchedAt = 0;
let error = "";

function load(scene: Scene) {
  // Kraken's public OHLC: hourly candles, the last seven days of them.
  const pair = encodeURIComponent(String(scene.state.pair || "XBTEUR").trim().toUpperCase());
  const since = Math.floor(scene.now()) - 7 * 24 * 3600;
  try {
    const data = scene.fetchJson(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=60&since=${since}`);
    if (data && data.error && data.error.length) throw new Error(String(data.error[0]));
    const result = (data && data.result) || {};
    let raw: (number | string)[][] = [];
    for (const key in result) if (key !== "last") raw = result[key];
    if (!raw || raw.length === 0) throw new Error("no candles in the response");
    // Thin to what the chart can show: every n-th close, at most MAX_POINTS.
    const stride = Math.max(1, Math.ceil(raw.length / MAX_POINTS));
    const count = Math.ceil(raw.length / stride);
    prices = new Float32Array(count);
    for (let i = 0, j = 0; i < raw.length; i += stride, j++) prices[j] = Number(raw[i][4]);
    first = Number(raw[0][4]);
    latest = Number(raw[raw.length - 1][4]);
    fetchedAt = scene.now();
    error = "";
  } catch (e) {
    error = String((e && (e as Error).message) || e);
    scene.error("crypto fetch failed", error);
  }
}

function money(value: number, currency: string): string {
  const digits = value >= 100 ? 0 : value >= 1 ? 2 : 4;
  const text = value.toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${text} ${currency.toUpperCase()}`;
}

export function render(scene: Scene, canvas: Canvas) {
  if (prices.length === 0 || scene.now() - fetchedAt > 600) load(scene);
  const w = canvas.width;
  const h = canvas.height;
  const pad = Math.round(Math.min(w, h) * 0.06);
  canvas.clear("#ffffff");

  const pair = String(scene.state.pair || "XBTEUR").toUpperCase();
  const currency = pair.length > 3 ? pair.slice(-3) : "";
  canvas.text(pair, pad, pad, { size: Math.round(h * 0.08), color: "#444444" });

  if (prices.length === 0) {
    canvas.text(error || "Loading…", pad, pad * 3, { width: w - 2 * pad, size: 24, color: "#aa0000" });
    scene.setNextSleep(120);
    return;
  }

  const change = first > 0 ? ((latest - first) / first) * 100 : 0;
  const up = change >= 0;
  const ink = up ? "#1a7f37" : "#b42318";
  canvas.text(money(latest, currency), pad, pad + Math.round(h * 0.1), {
    width: w - 2 * pad, height: Math.round(h * 0.22), size: Math.round(h * 0.2), fit: true, color: "#111111",
  });
  canvas.text(`${up ? "+" : "-"}${Math.abs(change).toFixed(2)}% over 7 days`, pad, pad + Math.round(h * 0.32), {
    size: Math.round(h * 0.06), color: ink,
  });

  // The sparkline: min/max to the chart box, then one polyline call.
  const top = Math.round(h * 0.52);
  const bottom = h - pad * 2;
  let min = prices[0];
  let max = prices[0];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] < min) min = prices[i];
    if (prices[i] > max) max = prices[i];
  }
  const span = max - min || 1;
  const n = prices.length;
  for (let i = 0; i < n; i++) {
    points[i * 2] = pad + ((w - 2 * pad) * i) / (n - 1);
    points[i * 2 + 1] = bottom - ((prices[i] - min) / span) * (bottom - top);
  }
  // Baseline and the line itself; subarray() views the same buffer.
  canvas.line(pad, bottom + 0.5, w - pad, bottom + 0.5, "#dddddd", 1);
  canvas.polyline(points.subarray(0, n * 2), ink, Math.max(2, Math.round(h / 200)), { join: "round", cap: "round" });
  canvas.fillCircle(points[(n - 1) * 2], points[(n - 1) * 2 + 1], Math.max(4, h / 80), ink);
  canvas.text(money(max, currency), pad, top - Math.round(h * 0.05), { size: Math.round(h * 0.035), color: "#888888" });
  canvas.text(money(min, currency), pad, bottom + 4, { size: Math.round(h * 0.035), color: "#888888" });
  canvas.text("updated " + scene.format(fetchedAt, "{hour/2}:{minute/2}"), w - pad, h - pad - Math.round(h * 0.035), {
    size: Math.round(h * 0.03), color: "#888888", align: "right", width: 0,
  });
}
