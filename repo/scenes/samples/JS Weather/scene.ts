import type { Scene, Canvas } from "frameos";
import { describe } from "./icons";

// Today in a large left cell, the next five days as a row of cells below.
// Each cell is a window onto the one canvas: no intermediate images, and
// a draw that overflows its cell is clipped instead of painting a neighbour.

type Forecast = {
  temperature: number; code: number; wind: number;
  days: { date: number; code: number; high: number; low: number }[];
};

let forecast: Forecast | null = null;
let fetchedAt = 0;
let error = "";

function load(scene: Scene) {
  const lat = Number(scene.state.latitude) || 0;
  const lon = Number(scene.state.longitude) || 0;
  const unit = scene.state.units === "fahrenheit" ? "fahrenheit" : "celsius";
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
    "&current=temperature_2m,weather_code,wind_speed_10m" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=6" +
    "&temperature_unit=" + unit;
  try {
    const data = scene.fetchJson(url);
    const days: Forecast["days"] = [];
    const daily = data.daily;
    for (let i = 1; i < Math.min(6, daily.time.length); i++) {
      days.push({
        date: scene.parseTs("{year/4}-{month/2}-{day/2}", daily.time[i]),
        code: daily.weather_code[i], high: daily.temperature_2m_max[i], low: daily.temperature_2m_min[i],
      });
    }
    // Keep only what is drawn; the response object goes out of scope here.
    forecast = {
      temperature: data.current.temperature_2m, code: data.current.weather_code,
      wind: data.current.wind_speed_10m, days,
    };
    fetchedAt = scene.now();
    error = "";
  } catch (e) {
    error = String((e && (e as Error).message) || e);
    scene.error("weather fetch failed", error);
  }
}

function icon(cell: Canvas, path: string, x: number, y: number, size: number, color: string) {
  cell.fillPath(path, color, { x, y, scale: size / 64 });
}

export function render(scene: Scene, canvas: Canvas) {
  if (!forecast || scene.now() - fetchedAt > 1500) load(scene);
  const w = canvas.width;
  const h = canvas.height;
  const pad = Math.round(Math.min(w, h) * 0.04);
  const unit = scene.state.units === "fahrenheit" ? "°F" : "°C";
  canvas.gradient(0, 0, w, h, { from: "#dbeafe", to: "#ffffff", angle: 180 });

  if (!forecast) {
    canvas.text(error ? "Weather unavailable\n" + error : "Loading…", pad, pad, {
      width: w - 2 * pad, height: h - 2 * pad, size: 28, fit: true, align: "center", valign: "middle", color: "#333333",
    });
    scene.setNextSleep(120);
    return;
  }

  // Today: the top 60% of the frame.
  const today = canvas.cell(0, 0, w, Math.round(h * 0.6));
  const now = describe(forecast.code);
  const big = Math.round(today.height * 0.5);
  icon(today, now.path, pad, pad, big, "#f59e0b");
  today.text(String(scene.state.city || ""), pad * 2 + big, pad, { size: Math.round(today.height * 0.14), color: "#1f2937" });
  today.text(Math.round(forecast.temperature) + unit, pad * 2 + big, pad + Math.round(today.height * 0.16), {
    width: today.width - pad * 3 - big, height: Math.round(today.height * 0.5), size: Math.round(today.height * 0.5),
    fit: true, color: "#111827",
  });
  today.text(now.label + "  ·  wind " + Math.round(forecast.wind) + " km/h", pad * 2 + big, pad + Math.round(today.height * 0.7), {
    size: Math.round(today.height * 0.1), color: "#374151",
  });

  // Five days in a row of equal cells.
  const rowY = Math.round(h * 0.6);
  const rowH = h - rowY;
  const n = forecast.days.length;
  const cellW = Math.floor(w / n);
  for (let i = 0; i < n; i++) {
    const day = forecast.days[i];
    const cell = canvas.cell(i * cellW, rowY, cellW, rowH);
    if (i > 0) cell.fillRect(0, pad, 1, rowH - 2 * pad, "#cbd5e1");
    const glyph = describe(day.code);
    const size = Math.round(Math.min(cellW, rowH) * 0.4);
    cell.text(scene.format(day.date, "{weekday/3}"), 0, pad, { width: cellW, align: "center", size: Math.round(rowH * 0.14), color: "#1f2937" });
    icon(cell, glyph.path, (cellW - size) / 2, pad + Math.round(rowH * 0.2), size, "#64748b");
    cell.text(Math.round(day.high) + "°  " + Math.round(day.low) + "°", 0, rowH - pad - Math.round(rowH * 0.18), {
      width: cellW, align: "center", size: Math.round(rowH * 0.14), color: "#111827",
    });
  }
  canvas.text("updated " + scene.format(fetchedAt, "{hour/2}:{minute/2}"), w - pad, pad, {
    size: 12, color: "#94a3b8", align: "right",
  });
}
