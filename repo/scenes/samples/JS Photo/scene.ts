import type { Scene, Canvas } from "frameos";

// A photo with a caption. `canvas.image(url, …)` streams the download
// straight into the canvas rectangle at the panel's resolution — on an
// ESP32 that is the difference between a 20 MB native-size bitmap and a
// few rows of decoder scratch. Nothing here keeps the picture around.

let failures = 0;

export function render(scene: Scene, canvas: Canvas) {
  const url = String(scene.state.imageUrl || "");
  const fit = scene.state.fit === "contain" ? "contain" : "cover";
  canvas.clear("#000000");

  const ok = url && canvas.image(url, { fit });
  if (!ok) {
    failures += 1;
    canvas.text(url ? "Could not load the picture" : "Set an image URL in the scene's options", 0, 0, {
      width: canvas.width, height: canvas.height, size: 32, fit: true,
      align: "center", valign: "middle", color: "#ffffff",
    });
    canvas.text(url, 24, canvas.height - 48, { width: canvas.width - 48, size: 18, color: "#888888", wrap: false });
    // Try again soon rather than waiting out the whole interval.
    scene.setNextSleep(Math.min(300, 30 * failures));
    return;
  }
  failures = 0;

  const caption = String(scene.state.caption || "");
  if (!caption) return;
  const size = Math.max(18, Math.round(canvas.height * 0.045));
  const measured = canvas.measureText(caption, { size, width: canvas.width - 2 * size });
  const barHeight = Math.round(measured.height + size);
  // A translucent bar: the fill blends over the photo, no layer allocated.
  canvas.fillRect(0, canvas.height - barHeight, canvas.width, barHeight, "#00000099");
  canvas.text(caption, size, canvas.height - barHeight + size / 2, {
    width: canvas.width - 2 * size, size, color: "#ffffff", align: "left",
  });
}
