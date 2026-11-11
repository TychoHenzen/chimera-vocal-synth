export interface CanvasFrame {
  ctx: CanvasRenderingContext2D;
  w: number; // css px
  h: number;
  dpr: number;
  dt: number;
  now: number;
}

/** Canvas font in the Hershey stack (heavier weights map to its medium cut; IPA falls back to Archivo). */
export function font(size: number, weight = 450, width = 100): string {
  void width;
  return `${weight >= 550 ? 500 : 300} ${size}px "Hershey", "Archivo", system-ui, sans-serif`;
}
