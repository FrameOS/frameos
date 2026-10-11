import type { Scene, Canvas } from "frameos";

// Conway's Game of Life on a torus. Two Uint8Array generations are
// allocated once in init() and swapped; render() fills one rect per live
// cell. Per generation this allocates nothing, which is what keeps a scene
// that redraws every second alive on an 8 MB board.

let cols = 0;
let rows = 0;
let cell = 12;
let current: Uint8Array = new Uint8Array(0);
let next: Uint8Array = new Uint8Array(0);
let generation = 0;
let stale = 0;
let lastPopulation = -1;

function seed(scene: Scene) {
  const density = Math.min(0.9, Math.max(0.05, Number(scene.state.density) || 0.3));
  for (let i = 0; i < current.length; i++) current[i] = Math.random() < density ? 1 : 0;
  generation = 0;
  stale = 0;
  lastPopulation = -1;
}

function setup(scene: Scene) {
  cell = Math.max(4, Math.round(Number(scene.state.cellSize) || 12));
  cols = Math.max(8, Math.floor(scene.frame.width / cell));
  rows = Math.max(8, Math.floor(scene.frame.height / cell));
  current = new Uint8Array(cols * rows);
  next = new Uint8Array(cols * rows);
  seed(scene);
}

export function init(scene: Scene) {
  setup(scene);
}

function step(): number {
  let population = 0;
  for (let y = 0; y < rows; y++) {
    const up = ((y + rows - 1) % rows) * cols;
    const mid = y * cols;
    const down = ((y + 1) % rows) * cols;
    for (let x = 0; x < cols; x++) {
      const left = (x + cols - 1) % cols;
      const right = (x + 1) % cols;
      const n = current[up + left] + current[up + x] + current[up + right]
        + current[mid + left] + current[mid + right]
        + current[down + left] + current[down + x] + current[down + right];
      const alive = current[mid + x] === 1 ? (n === 2 || n === 3) : n === 3;
      next[mid + x] = alive ? 1 : 0;
      if (alive) population += 1;
    }
  }
  const swap = current; current = next; next = swap;
  generation += 1;
  return population;
}

export function render(scene: Scene, canvas: Canvas) {
  // The options changed under us: rebuild the grid.
  const wantCell = Math.max(4, Math.round(Number(scene.state.cellSize) || 12));
  if (wantCell !== cell || current.length === 0) setup(scene);

  const population = step();
  // A still life or an oscillator is boring after a while: reseed.
  if (population === lastPopulation) stale += 1; else stale = 0;
  lastPopulation = population;
  if (stale > 12 || population === 0) seed(scene);

  canvas.clear("#000000");
  const offX = Math.floor((canvas.width - cols * cell) / 2);
  const offY = Math.floor((canvas.height - rows * cell) / 2);
  const gap = cell >= 8 ? 1 : 0;
  for (let y = 0; y < rows; y++) {
    const row = y * cols;
    const py = offY + y * cell;
    for (let x = 0; x < cols; x++) {
      if (current[row + x]) canvas.fillRect(offX + x * cell, py, cell - gap, cell - gap, 0xffffff);
    }
  }
  canvas.text(`gen ${generation}  pop ${population}`, 8, canvas.height - 26, { size: 16, color: "#666666" });
}

export function onEvent(scene: Scene, event: string) {
  // Any button on the frame starts a fresh board.
  if (event === "buttonPress" || event === "keyDown") seed(scene);
}
