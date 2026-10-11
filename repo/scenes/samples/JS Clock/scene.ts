import type { Scene, Canvas } from "frameos";

// A clock: the time as large as the frame allows, the date under it, and a
// thin bar showing how far the day has come. Nothing is allocated per
// render beyond a few strings; the canvas is drawn in place.

export function render(scene: Scene, canvas: Canvas) {
  const dark = scene.state.dark === true;
  const ink = dark ? "#f5f5f5" : "#111111";
  const paper = dark ? "#111111" : "#ffffff";
  const accent = dark ? "#ffb347" : "#d14b00";
  canvas.clear(paper);

  const now = scene.now();
  const time = scene.state.twentyFourHour === false
    ? scene.format(now, "{hour/ap}:{minute/2}")
    : scene.format(now, "{hour/2}:{minute/2}");
  const date = scene.format(now, "{weekday}, {day} {month/n} {year/4}");

  const w = canvas.width;
  const h = canvas.height;
  const pad = Math.round(Math.min(w, h) * 0.06);

  // The time fills the top two thirds; `fit` shrinks it until it does.
  canvas.text(time, pad, pad, {
    width: w - 2 * pad, height: Math.round(h * 0.6), size: h, fit: true,
    align: "center", valign: "middle", color: ink,
  });
  canvas.text(date, pad, Math.round(h * 0.66), {
    width: w - 2 * pad, height: Math.round(h * 0.14), size: Math.round(h * 0.09), fit: true,
    align: "center", valign: "middle", color: ink,
  });
  const label = String(scene.state.label || "");
  if (label) {
    canvas.text(label, pad, Math.round(h * 0.8), {
      width: w - 2 * pad, height: Math.round(h * 0.1), size: Math.round(h * 0.06), fit: true,
      align: "center", valign: "middle", color: accent,
    });
  }

  // Day progress: a hairline with the elapsed part in the accent color.
  const secondsToday = Number(scene.format(now, "{hour}")) * 3600 + Number(scene.format(now, "{minute}")) * 60;
  const progress = secondsToday / 86400;
  const barY = h - pad;
  canvas.fillRect(pad, barY, w - 2 * pad, 2, dark ? "#444444" : "#dddddd");
  canvas.fillRect(pad, barY - 2, Math.round((w - 2 * pad) * progress), 6, accent);

  // Wake up on the next full minute, so the display never shows a stale minute.
  scene.setNextSleep(60 - (Math.floor(now) % 60));
}
