// WebGL2 graph renderer: shaped points and lines in 3D, with a camera that orbits, pans, zooms and flies.
// It draws on demand. A frame loop runs only while something moves (a camera flight, a fade, a held key,
// auto-rotate) and stops again, so an idle graph costs nothing.
// Motion is short and any input cancels it; with "reduce motion" set, the camera jumps and nothing fades.
// No library: the page's CSP allows only bundled scripts, and the graphs are a few hundred nodes.

import {
  boundingSphere,
  cloneCamera,
  DEFAULT_CAMERA,
  ease,
  fitSphere,
  fly,
  mixCamera,
  orbit,
  pan,
  viewProjection,
  zoomAt,
  type Camera,
} from "./graph-camera.ts";

export interface RenderNode {
  type: string; // document | concept | code
  degree: number;
  group: number; // hyperedge group, -1 for none
  grounded: boolean;
}
export interface RenderGraph {
  nodes: RenderNode[];
  edges: { source: number; target: number }[];
}
export type Theme = "light" | "dark";

export interface GraphRendererOptions {
  theme: Theme;
  onSelect?: (index: number) => void;
  onHover?: (index: number) => void;
  // Called after each frame with projected screen positions: x, y, depth, visible (1/0) per node.
  onFrame?: (screen: Float32Array) => void;
}

// Each type has a shape as well as a colour, so the type never rests on colour alone.
// The index is the shader's shape code: 0 rounded square, 1 circle, 2 diamond. Unknown types draw as documents.
const TYPES = ["document", "concept", "code"];
const TYPE_VARS = ["--hig-node-document", "--hig-node-concept", "--hig-node-code"];

interface Palette {
  types: number[][];
  edge: number[];
  selection: number[];
  hover: number[];
  // Ring around highlighted nodes.
  mark: number[];
}

// Colours come from the theme tokens in app.css; a 2D context turns any CSS colour into #rrggbb.
function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const ctx = document.createElement("canvas").getContext("2d");
  const rgb = (name: string, fallback: number[]): number[] => {
    const value = style.getPropertyValue(name).trim();
    if (!ctx || !value) return fallback;
    ctx.fillStyle = "#000";
    ctx.fillStyle = value;
    const hex = String(ctx.fillStyle);
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  };
  return {
    types: TYPE_VARS.map((name) => rgb(name, [0.5, 0.5, 0.5])),
    edge: rgb("--hig-label3", [0.56, 0.56, 0.58]),
    selection: rgb("--hig-accent-text", [0, 0.38, 0.84]),
    hover: rgb("--hig-label2", [0.4, 0.4, 0.41]),
    mark: rgb("--hig-label", [0, 0, 0]),
  };
}

// Force layout in 3D. Hyperedge groups get their own anchor on a sphere so they read as islands.
// Pairwise repulsion is O(n^2) per step, so larger graphs get fewer steps.
export function layoutGraph(graph: RenderGraph): Float32Array {
  const n = graph.nodes.length;
  const pos = new Float32Array(n * 3);
  if (!n) return pos;
  const slots = new Map<number, number>();
  for (const node of graph.nodes) if (node.group >= 0 && !slots.has(node.group)) slots.set(node.group, slots.size);
  const slotCount = Math.max(1, slots.size);
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const centres = new Float32Array(slotCount * 3);
  for (let k = 0; k < slotCount; k++) {
    const y = 1 - (2 * (k + 0.5)) / slotCount;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    centres[k * 3] = Math.cos(k * golden) * r * 1.25;
    centres[k * 3 + 1] = y * 0.8;
    centres[k * 3 + 2] = Math.sin(k * golden) * r * 1.25;
  }
  graph.nodes.forEach((node, i) => {
    const slot = slots.get(node.group);
    const c = slot === undefined ? [0, 0, 0] : [centres[slot * 3]!, centres[slot * 3 + 1]!, centres[slot * 3 + 2]!];
    const spread = slot === undefined ? 1.6 : 0.3;
    pos[i * 3] = c[0]! + (rand() - 0.5) * spread;
    pos[i * 3 + 1] = c[1]! + (rand() - 0.5) * spread;
    pos[i * 3 + 2] = c[2]! + (rand() - 0.5) * spread;
  });
  const degree = graph.nodes.map((node) => node.degree);
  const steps = n > 2000 ? 60 : n > 1000 ? 150 : n > 600 ? 260 : 420;
  const disp = new Float32Array(n * 3);
  for (let iter = 0; iter < steps; iter++) {
    const step = 0.02 * (1 - iter / steps) + 0.0006;
    disp.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i * 3]! - pos[j * 3]!;
        let dy = pos[i * 3 + 1]! - pos[j * 3 + 1]!;
        let dz = pos[i * 3 + 2]! - pos[j * 3 + 2]!;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-4) {
          dx = (rand() - 0.5) * 0.01;
          dy = (rand() - 0.5) * 0.01;
          dz = (rand() - 0.5) * 0.01;
          d2 = 1e-4;
        }
        const f = 0.0018 / (d2 * Math.sqrt(d2));
        disp[i * 3]! += dx * f;
        disp[i * 3 + 1]! += dy * f;
        disp[i * 3 + 2]! += dz * f;
        disp[j * 3]! -= dx * f;
        disp[j * 3 + 1]! -= dy * f;
        disp[j * 3 + 2]! -= dz * f;
      }
    }
    for (const { source: s, target: t } of graph.edges) {
      const dx = pos[t * 3]! - pos[s * 3]!;
      const dy = pos[t * 3 + 1]! - pos[s * 3 + 1]!;
      const dz = pos[t * 3 + 2]! - pos[s * 3 + 2]!;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
      const rest = 0.1 + 0.014 * Math.min(degree[s]!, degree[t]!);
      const f = ((d - rest) / d) * 0.07;
      disp[s * 3]! += dx * f;
      disp[s * 3 + 1]! += dy * f;
      disp[s * 3 + 2]! += dz * f;
      disp[t * 3]! -= dx * f;
      disp[t * 3 + 1]! -= dy * f;
      disp[t * 3 + 2]! -= dz * f;
    }
    for (let i = 0; i < n; i++) {
      const slot = slots.get(graph.nodes[i]!.group);
      const pull = slot === undefined ? 0.003 : 0.0065;
      const cx = slot === undefined ? 0 : centres[slot * 3]!;
      const cy = slot === undefined ? 0 : centres[slot * 3 + 1]!;
      const cz = slot === undefined ? 0 : centres[slot * 3 + 2]!;
      disp[i * 3]! += (cx - pos[i * 3]!) * pull;
      disp[i * 3 + 1]! += (cy - pos[i * 3 + 1]!) * pull;
      disp[i * 3 + 2]! += (cz - pos[i * 3 + 2]!) * pull;
      const l = Math.hypot(disp[i * 3]!, disp[i * 3 + 1]!, disp[i * 3 + 2]!) || 1;
      const k = Math.min(l, step) / l;
      pos[i * 3]! += disp[i * 3]! * k;
      pos[i * 3 + 1]! += disp[i * 3 + 1]! * k;
      pos[i * 3 + 2]! += disp[i * 3 + 2]! * k;
    }
  }
  // Centre and scale to a fixed radius, so one camera distance fits every graph.
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) c[a]! += pos[i * 3 + a]! / n;
  let radius = 1e-3;
  for (let i = 0; i < n; i++) radius = Math.max(radius, Math.hypot(pos[i * 3]! - c[0]!, pos[i * 3 + 1]! - c[1]!, pos[i * 3 + 2]! - c[2]!));
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) pos[i * 3 + a] = ((pos[i * 3 + a]! - c[a]!) * 1.25) / radius;
  return pos;
}

// The canvas is transparent so the panel behind it shows through; every shader writes premultiplied colour.
// uFade is the entrance fade. aMark draws a ring around a node the search or a group highlights.
const POINT_VS = `#version 300 es
in vec3 aPos; in float aSize; in vec3 aColor; in float aAlpha; in float aShape; in float aMark;
uniform mat4 uVP; uniform float uScale;
out vec3 vColor; out float vAlpha; out float vMark; out float vGrow; flat out int vShape;
void main() {
  vec4 clip = uVP * vec4(aPos, 1.0);
  gl_Position = clip;
  float marked = step(0.001, aMark);
  float size = clamp(aSize * uScale / max(clip.w, 0.05), 4.0 + 3.0 * marked, 32.0);
  vGrow = 1.0 + 0.6 * marked;
  gl_PointSize = size * vGrow;
  vColor = aColor; vAlpha = aAlpha; vMark = aMark; vShape = int(aShape + 0.5);
}`;
const POINT_FS = `#version 300 es
precision highp float;
in vec3 vColor; in float vAlpha; in float vMark; in float vGrow; flat in int vShape;
uniform vec3 uMark; uniform float uFade;
out vec4 outColor;
void main() {
  vec2 p = (gl_PointCoord * 2.0 - 1.0) * vGrow;
  vec2 q = abs(p);
  float d;
  if (vShape == 1) d = length(p) - 0.8;
  else if (vShape == 2) d = (q.x + q.y) * 0.7071 - 0.66;
  else d = length(max(q - 0.52, 0.0)) + min(max(q.x, q.y) - 0.52, 0.0) - 0.18;
  float w = max(fwidth(d), 1e-3);
  float a = (1.0 - smoothstep(-w, w, d)) * vAlpha;
  vec3 color = vColor * a;
  if (vMark > 0.001) {
    float rd = abs(length(p) - 1.34) - 0.1;
    float rw = max(fwidth(rd), 1e-3);
    float ra = (1.0 - smoothstep(-rw, rw, rd)) * vMark;
    color = color * (1.0 - ra) + uMark * ra;
    a = a * (1.0 - ra) + ra;
  }
  if (a <= 0.002) discard;
  outColor = vec4(color, a) * uFade;
}`;
const LINE_VS = `#version 300 es
in vec3 aPos; in float aAlpha; uniform mat4 uVP; out float vAlpha;
void main() { gl_Position = uVP * vec4(aPos, 1.0); vAlpha = aAlpha; }`;
const LINE_FS = `#version 300 es
precision highp float;
in float vAlpha; uniform vec3 uColor; uniform float uFade; out vec4 outColor;
void main() { float a = vAlpha * uFade; outColor = vec4(uColor * a, a); }`;
const RING_VS = `#version 300 es
uniform vec3 uPos; uniform float uSize; uniform mat4 uVP; uniform float uScale;
void main() { vec4 clip = uVP * vec4(uPos, 1.0); gl_Position = clip; gl_PointSize = clamp(uSize * uScale / max(clip.w, 0.05), 6.0, 96.0); }`;
const RING_FS = `#version 300 es
precision highp float;
uniform vec3 uColor; uniform float uStyle; uniform float uFade; out vec4 outColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = (uStyle < 0.5 ? smoothstep(0.14, 0.0, abs(r - 0.78)) : smoothstep(1.0, 0.15, r) * 0.35) * uFade;
  if (a <= 0.003) discard;
  outColor = vec4(uColor * a, a);
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
  return program;
}

// Durations in ms. Short, so nobody waits for the camera; any input cancels a flight.
const FLY_MS = 480;
const ZOOM_MS = 180;
const INTRO_MS = 800;
const RING_MS = 260;
// Time constant of highlight fades.
const FADE_MS = 70;
// Auto-rotate: one turn takes about a minute.
const ROTATE_SPEED = 0.0001;
const FLY_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

export class GraphRenderer {
  readonly positions: Float32Array;
  readonly screen: Float32Array;
  private gl: WebGL2RenderingContext;
  private n: number;
  private theme: Theme;
  private palette: Palette;
  private selected = -1;
  private hovered = -1;
  private camera: Camera = cloneCamera(DEFAULT_CAMERA);
  private flight: { from: Camera; to: Camera; start: number; ms: number } | null = null;
  private frame = 0;
  private lastTime = 0;
  private introStart = -1;
  private ringStart = -1;
  private autoRotate = false;
  private dragging = false;
  private keys = new Set<string>();
  private shift = false;
  private motion: MediaQueryList;
  private sizes: Float32Array;
  private neighbours: number[][];
  private hidden: Uint8Array;
  private highlight: Uint8Array | null = null;
  // Style now and where it is heading: node alpha, colour dimming and match ring, edge alpha.
  private fading = true;
  private alphaNow: Float32Array;
  private alphaTo: Float32Array;
  private dimNow: Float32Array;
  private dimTo: Float32Array;
  private markNow: Float32Array;
  private markTo: Float32Array;
  private edgeNow: Float32Array;
  private edgeTo: Float32Array;
  private programs: { point: WebGLProgram; line: WebGLProgram; ring: WebGLProgram };
  private buffers: { color: WebGLBuffer; alpha: WebGLBuffer; mark: WebGLBuffer; edgeAlpha: WebGLBuffer };
  private vaos: { point: WebGLVertexArrayObject; line: WebGLVertexArrayObject; ring: WebGLVertexArrayObject };
  private edgeCount: number;
  private cleanup: (() => void)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private graph: RenderGraph,
    private options: GraphRendererOptions,
  ) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: true });
    if (!gl) throw new Error("This browser cannot create a WebGL2 context.");
    this.gl = gl;
    this.n = graph.nodes.length;
    this.theme = options.theme;
    this.palette = readPalette();
    this.motion = matchMedia("(prefers-reduced-motion: reduce)");
    this.positions = layoutGraph(graph);
    this.screen = new Float32Array(this.n * 4);
    this.sizes = new Float32Array(graph.nodes.map((node) => 1.4 + Math.sqrt(node.degree) * 0.55));
    this.neighbours = graph.nodes.map(() => []);
    for (const e of graph.edges) {
      this.neighbours[e.source]!.push(e.target);
      this.neighbours[e.target]!.push(e.source);
    }
    this.edgeCount = graph.edges.length;
    this.hidden = new Uint8Array(this.n);
    this.alphaNow = new Float32Array(this.n);
    this.alphaTo = new Float32Array(this.n);
    this.dimNow = new Float32Array(this.n);
    this.dimTo = new Float32Array(this.n);
    this.markNow = new Float32Array(this.n);
    this.markTo = new Float32Array(this.n);
    this.edgeNow = new Float32Array(this.edgeCount);
    this.edgeTo = new Float32Array(this.edgeCount);
    this.programs = { point: compile(gl, POINT_VS, POINT_FS), line: compile(gl, LINE_VS, LINE_FS), ring: compile(gl, RING_VS, RING_FS) };

    const attribute = (program: WebGLProgram, name: string, data: Float32Array, size: number, usage: number) => {
      const buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      const loc = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      return buffer;
    };

    const point = gl.createVertexArray()!;
    gl.bindVertexArray(point);
    attribute(this.programs.point, "aPos", this.positions, 3, gl.STATIC_DRAW);
    attribute(this.programs.point, "aSize", this.sizes, 1, gl.STATIC_DRAW);
    const shapes = new Float32Array(graph.nodes.map((node) => Math.max(0, TYPES.indexOf(node.type))));
    attribute(this.programs.point, "aShape", shapes, 1, gl.STATIC_DRAW);
    const color = attribute(this.programs.point, "aColor", new Float32Array(this.n * 3), 3, gl.DYNAMIC_DRAW);
    const alpha = attribute(this.programs.point, "aAlpha", new Float32Array(this.n), 1, gl.DYNAMIC_DRAW);
    const mark = attribute(this.programs.point, "aMark", new Float32Array(this.n), 1, gl.DYNAMIC_DRAW);

    const edgePos = new Float32Array(this.edgeCount * 6);
    graph.edges.forEach((e, i) => {
      edgePos.set(this.positions.subarray(e.source * 3, e.source * 3 + 3), i * 6);
      edgePos.set(this.positions.subarray(e.target * 3, e.target * 3 + 3), i * 6 + 3);
    });
    const line = gl.createVertexArray()!;
    gl.bindVertexArray(line);
    attribute(this.programs.line, "aPos", edgePos, 3, gl.STATIC_DRAW);
    const edgeAlpha = attribute(this.programs.line, "aAlpha", new Float32Array(this.edgeCount * 2), 1, gl.DYNAMIC_DRAW);
    const ring = gl.createVertexArray()!;
    gl.bindVertexArray(null);

    this.vaos = { point, line, ring };
    this.buffers = { color, alpha, mark, edgeAlpha };
    this.restyle();
    // The first frame shows the settled style; only later changes fade.
    this.alphaNow.set(this.alphaTo);
    this.dimNow.set(this.dimTo);
    this.markNow.set(this.markTo);
    this.edgeNow.set(this.edgeTo);
    // Entrance: the graph fades in while the camera settles into the default view.
    if (!this.still) {
      this.camera = { ...cloneCamera(DEFAULT_CAMERA), yaw: DEFAULT_CAMERA.yaw - 0.55, dist: DEFAULT_CAMERA.dist * 1.25 };
      this.flyTo(DEFAULT_CAMERA, INTRO_MS);
      this.introStart = 0;
    }
    this.bindInput();
    this.invalidate();
  }

  // True when the system asks for reduced motion: the camera jumps and nothing fades.
  private get still(): boolean {
    return this.motion.matches;
  }

  private get aspect(): number {
    const rect = this.canvas.getBoundingClientRect();
    return rect.width / Math.max(1, rect.height);
  }

  // Re-reads the colour tokens as well, since they switch with the theme.
  setTheme(theme: Theme) {
    this.theme = theme;
    this.palette = readPalette();
    this.restyle();
  }

  // Selects a node; with `center` the camera flies to it and moves in if it is far away.
  select(index: number, { center = true } = {}) {
    if (index !== this.selected && index >= 0) this.ringStart = 0;
    this.selected = index;
    if (center && index >= 0) {
      const base = this.flight?.to ?? this.camera;
      const p = this.positions;
      this.flyTo({ ...base, target: [p[index * 3]!, p[index * 3 + 1]!, p[index * 3 + 2]!], dist: Math.min(base.dist, 1.4) });
    }
    this.restyle();
  }

  // Marks a set of nodes (search matches, a group) and dims the rest; null clears it.
  setHighlight(indices: readonly number[] | null) {
    if (!indices) this.highlight = null;
    else {
      this.highlight = new Uint8Array(this.n);
      for (const i of indices) if (i >= 0 && i < this.n) this.highlight[i] = 1;
    }
    this.restyle();
  }

  // Hides nodes, with their links, by a per-node flag. A hidden selection or hover is dropped.
  setHidden(hidden: ArrayLike<boolean | number>) {
    for (let i = 0; i < this.n; i++) this.hidden[i] = hidden[i] ? 1 : 0;
    if (this.hovered >= 0 && this.hidden[this.hovered]) this.hovered = -1;
    this.restyle();
  }

  // Moves the camera so these nodes fill the view; without a list, every node that is not hidden.
  frameNodes(indices?: readonly number[]) {
    const ids = (indices ?? Array.from({ length: this.n }, (_, i) => i)).filter((i) => !this.hidden[i]);
    if (!ids.length) return;
    const { centre, radius } = boundingSphere(this.positions, ids);
    this.flyTo(fitSphere(this.flight?.to ?? this.camera, centre, radius, this.aspect));
  }

  // Zooms on the middle of the view; factor below 1 moves in.
  zoomBy(factor: number) {
    this.flyTo(zoomAt(this.flight?.to ?? this.camera, factor, 0, 0, this.aspect), ZOOM_MS);
  }

  resetCamera() {
    this.flyTo(DEFAULT_CAMERA);
  }

  setAutoRotate(on: boolean) {
    this.autoRotate = on;
    this.invalidate();
  }

  // Draws on the next animation frame. The loop keeps going only while something moves.
  invalidate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame((now) => {
      this.frame = 0;
      this.tick(now);
    });
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const fn of this.cleanup) fn();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  private flyTo(to: Camera, ms = FLY_MS) {
    if (this.still || ms <= 0) {
      this.flight = null;
      this.camera = cloneCamera(to);
    } else {
      // start 0 means "the next frame"; the frame clock is not known here.
      this.flight = { from: cloneCamera(this.camera), to: cloneCamera(to), start: 0, ms };
    }
    this.invalidate();
  }

  // Target colours and alphas for the theme, selection, hover, highlight and hidden types.
  // Hover or selection lights its neighbourhood; otherwise a highlight lights its nodes.
  private restyle() {
    const dark = this.theme === "dark";
    const focus = this.hovered >= 0 ? this.hovered : this.selected >= 0 && !this.hidden[this.selected] ? this.selected : -1;
    const marks = this.highlight;
    let lit: Uint8Array | null = null;
    if (focus >= 0) {
      lit = new Uint8Array(this.n);
      lit[focus] = 1;
      for (const j of this.neighbours[focus]!) lit[j] = 1;
    } else if (marks) lit = marks;
    this.graph.nodes.forEach((node, i) => {
      // Ungrounded nodes are drawn faint: no passage backs them.
      const base = node.grounded ? 1 : dark ? 0.42 : 0.55;
      const dimmed = lit !== null && !lit[i];
      const marked = !!marks?.[i] && !this.hidden[i];
      // A match outside the focused neighbourhood stays readable.
      this.alphaTo[i] = this.hidden[i] ? 0 : dimmed ? base * (marked ? 0.6 : 0.3) : base;
      this.dimTo[i] = dimmed && !marked ? 0.72 : 1;
      this.markTo[i] = marked ? (dimmed ? 0.55 : 1) : 0;
    });
    const idle = dark ? 0.24 : 0.26;
    this.graph.edges.forEach((e, i) => {
      let a = idle;
      if (this.hidden[e.source] || this.hidden[e.target]) a = 0;
      else if (focus >= 0) a = e.source === focus || e.target === focus ? 0.85 : 0.04;
      else if (marks) a = marks[e.source] && marks[e.target] ? 0.7 : 0.05;
      this.edgeTo[i] = a;
    });
    this.fading = true;
    this.invalidate();
  }

  // Moves the style towards its target and uploads it. Returns true while it is still moving.
  private stepStyle(dt: number): boolean {
    const k = this.still ? 1 : 1 - Math.exp(-dt / FADE_MS);
    let moving = false;
    const step = (now: Float32Array, to: Float32Array) => {
      for (let i = 0; i < now.length; i++) {
        const d = to[i]! - now[i]!;
        if (Math.abs(d) < 0.004) now[i] = to[i]!;
        else {
          now[i] = now[i]! + d * k;
          moving = true;
        }
      }
    };
    step(this.alphaNow, this.alphaTo);
    step(this.dimNow, this.dimTo);
    step(this.markNow, this.markTo);
    step(this.edgeNow, this.edgeTo);

    const gl = this.gl;
    const colors = new Float32Array(this.n * 3);
    this.graph.nodes.forEach((node, i) => {
      const c = this.palette.types[Math.max(0, TYPES.indexOf(node.type))]!;
      const dim = this.dimNow[i]!;
      colors.set([c[0]! * dim, c[1]! * dim, c[2]! * dim], i * 3);
    });
    const edges = new Float32Array(this.edgeCount * 2);
    for (let i = 0; i < this.edgeCount; i++) edges[i * 2] = edges[i * 2 + 1] = this.edgeNow[i]!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.color);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.alpha);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.alphaNow);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.mark);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.markNow);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.edgeAlpha);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, edges);
    return moving;
  }

  // One frame: advance whatever is moving, draw, and ask for another frame only if something still moves.
  private tick(now: number) {
    // After an idle stretch the gap is not a frame time; long frames are capped so nothing jumps.
    const dt = this.lastTime ? Math.min(now - this.lastTime, 50) : 16;
    let moving = false;

    if (this.flight) {
      if (!this.flight.start) this.flight.start = now;
      const t = (now - this.flight.start) / this.flight.ms;
      if (t >= 1) {
        this.camera = this.flight.to;
        this.flight = null;
      } else {
        this.camera = mixCamera(this.flight.from, this.flight.to, ease(t));
        moving = true;
      }
    }
    if (this.keys.size) {
      this.moveByKeys(dt);
      moving = true;
    }
    if (this.autoRotate && !this.flight && !this.dragging && !this.keys.size) {
      this.camera = orbit(this.camera, ROTATE_SPEED * dt, 0);
      moving = true;
    }
    if (this.fading) {
      this.fading = this.stepStyle(dt);
      moving ||= this.fading;
    }
    let fade = 1;
    if (this.introStart >= 0) {
      if (!this.introStart) this.introStart = now;
      const t = (now - this.introStart) / INTRO_MS;
      if (t >= 1) this.introStart = -1;
      else {
        fade = ease(Math.min(1, t * 1.6));
        moving = true;
      }
    }
    let ring = 1;
    if (this.ringStart >= 0) {
      if (!this.ringStart) this.ringStart = now;
      const t = this.still ? 1 : (now - this.ringStart) / RING_MS;
      if (t >= 1) this.ringStart = -1;
      else {
        ring = ease(t);
        moving = true;
      }
    }

    this.draw(fade, ring);
    this.lastTime = moving ? now : 0;
    if (moving) this.invalidate();
  }

  // Held keys: W A S D fly along the view, Q and E go down and up, arrows orbit, Shift with arrows pans.
  private moveByKeys(dt: number) {
    const has = (code: string) => (this.keys.has(code) ? 1 : 0);
    // Speed follows the distance, so crossing the view takes about a second at any zoom.
    const move = this.camera.dist * 0.0007 * dt;
    const turn = 0.0019 * dt;
    let right = has("KeyD") - has("KeyA");
    let up = has("KeyE") - has("KeyQ");
    const forward = has("KeyW") - has("KeyS");
    const ax = has("ArrowRight") - has("ArrowLeft");
    const ay = has("ArrowUp") - has("ArrowDown");
    let camera = this.camera;
    if (this.shift) {
      right += ax;
      up += ay;
    } else if (ax || ay) camera = orbit(camera, -ax * turn, ay * turn);
    this.camera = fly(camera, right * move, up * move, forward * move);
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private draw(fade: number, ringGrow: number) {
    const gl = this.gl;
    this.resize();
    const vp = viewProjection(this.camera, this.canvas.width / Math.max(1, this.canvas.height));
    const rect = this.canvas.getBoundingClientRect();
    for (let i = 0; i < this.n; i++) {
      const x = this.positions[i * 3]!, y = this.positions[i * 3 + 1]!, z = this.positions[i * 3 + 2]!;
      const cx = vp[0]! * x + vp[4]! * y + vp[8]! * z + vp[12]!;
      const cy = vp[1]! * x + vp[5]! * y + vp[9]! * z + vp[13]!;
      const cw = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!;
      const visible = cw > 0.05 && !this.hidden[i];
      this.screen[i * 4] = visible ? ((cx / cw) * 0.5 + 0.5) * rect.width : -1e4;
      this.screen[i * 4 + 1] = visible ? (0.5 - (cy / cw) * 0.5) * rect.height : -1e4;
      this.screen[i * 4 + 2] = cw;
      this.screen[i * 4 + 3] = visible ? 1 : 0;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const scale = this.canvas.height * 0.034 * 0.72;

    const { line, point, ring } = this.programs;
    gl.useProgram(line);
    gl.uniformMatrix4fv(gl.getUniformLocation(line, "uVP"), false, vp);
    gl.uniform3fv(gl.getUniformLocation(line, "uColor"), this.palette.edge);
    gl.uniform1f(gl.getUniformLocation(line, "uFade"), fade);
    gl.bindVertexArray(this.vaos.line);
    gl.drawArrays(gl.LINES, 0, this.edgeCount * 2);

    gl.useProgram(point);
    gl.uniformMatrix4fv(gl.getUniformLocation(point, "uVP"), false, vp);
    gl.uniform1f(gl.getUniformLocation(point, "uScale"), scale);
    gl.uniform1f(gl.getUniformLocation(point, "uFade"), fade);
    gl.uniform3fv(gl.getUniformLocation(point, "uMark"), this.palette.mark);
    gl.bindVertexArray(this.vaos.point);
    gl.drawArrays(gl.POINTS, 0, this.n);

    const mark = (index: number, style: number, factor: number, alpha: number) => {
      if (index < 0 || this.hidden[index]) return;
      gl.useProgram(ring);
      gl.uniformMatrix4fv(gl.getUniformLocation(ring, "uVP"), false, vp);
      gl.uniform3f(gl.getUniformLocation(ring, "uPos"), this.positions[index * 3]!, this.positions[index * 3 + 1]!, this.positions[index * 3 + 2]!);
      gl.uniform1f(gl.getUniformLocation(ring, "uSize"), this.sizes[index]! * factor);
      gl.uniform1f(gl.getUniformLocation(ring, "uScale"), scale);
      gl.uniform1f(gl.getUniformLocation(ring, "uStyle"), style);
      gl.uniform1f(gl.getUniformLocation(ring, "uFade"), alpha);
      gl.uniform3fv(gl.getUniformLocation(ring, "uColor"), style === 0 ? this.palette.selection : this.palette.hover);
      gl.bindVertexArray(this.vaos.ring);
      gl.drawArrays(gl.POINTS, 0, 1);
    };
    // A new selection's ring closes in on the node.
    mark(this.selected, 0, 2.4 + (1 - ringGrow) * 1.6, fade * ringGrow);
    if (this.hovered !== this.selected) mark(this.hovered, 1, 3.2, fade);
    gl.bindVertexArray(null);
    this.options.onFrame?.(this.screen);
  }

  private pick(clientX: number, clientY: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = -1;
    let bestDistance = 14;
    for (let i = 0; i < this.n; i++) {
      if (!this.screen[i * 4 + 3]) continue;
      const d = Math.hypot(this.screen[i * 4]! - x, this.screen[i * 4 + 1]! - y) - this.sizes[i]! * 0.5;
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    return best;
  }

  private setHover(index: number) {
    if (index === this.hovered) return;
    this.hovered = index;
    this.canvas.style.cursor = index >= 0 ? "pointer" : "grab";
    this.options.onHover?.(index);
    this.restyle();
  }

  // Pointer position in normalized device coordinates: -1..1, y up.
  private ndc(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1, 1 - ((clientY - rect.top) / Math.max(1, rect.height)) * 2];
  }

  private bindInput() {
    const { canvas } = this;
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    // Every pointer that is down. One drags (orbit or pan); two pinch to zoom and pan.
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { mode: "orbit" | "pan"; moved: boolean; click: boolean } | null = null;
    const pinch = () => {
      const [a, b] = [...pointers.values()];
      return { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2, d: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)) };
    };
    let lastPinch: { x: number; y: number; d: number } | null = null;

    canvas.style.cursor = "grab";
    on(canvas, "pointerdown", (e) => {
      this.flight = null;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        lastPinch = pinch();
        if (drag) drag.moved = true;
        return;
      }
      const panning = e.button !== 0 || e.shiftKey;
      drag = { mode: panning ? "pan" : "orbit", moved: false, click: e.button === 0 && !e.shiftKey };
      this.dragging = true;
    });
    on(canvas, "pointermove", (e) => {
      const p = pointers.get(e.pointerId);
      if (!p || !drag) {
        this.setHover(this.pick(e.clientX, e.clientY));
        return;
      }
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (pointers.size >= 2) {
        p.x = e.clientX;
        p.y = e.clientY;
        const next = pinch();
        if (lastPinch) {
          const rect = canvas.getBoundingClientRect();
          const [nx, ny] = this.ndc(next.x, next.y);
          this.camera = pan(zoomAt(this.camera, lastPinch.d / next.d, nx, ny, this.aspect), next.x - lastPinch.x, next.y - lastPinch.y, rect.height);
        }
        lastPinch = next;
        this.invalidate();
        return;
      }
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) <= 2) return;
      drag.moved = true;
      p.x = e.clientX;
      p.y = e.clientY;
      if (drag.mode === "pan") this.camera = pan(this.camera, dx, dy, canvas.getBoundingClientRect().height);
      else this.camera = orbit(this.camera, dx * 0.008, dy * 0.006);
      canvas.style.cursor = drag.mode === "pan" ? "move" : "grabbing";
      this.setHover(-1);
      this.invalidate();
    });
    const release = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      lastPinch = null;
      if (pointers.size) return;
      const clicked = drag?.click && !drag.moved && e.type === "pointerup";
      drag = null;
      this.dragging = false;
      canvas.style.cursor = this.hovered >= 0 ? "pointer" : "grab";
      // Auto-rotate waits while a pointer is down; this starts it again.
      this.invalidate();
      if (!clicked) return;
      const index = this.pick(e.clientX, e.clientY);
      this.select(index, { center: false });
      this.options.onSelect?.(index);
    };
    on(canvas, "pointerup", release);
    on(canvas, "pointercancel", release);
    on(canvas, "pointerleave", () => {
      if (!pointers.size) this.setHover(-1);
    });
    // The secondary button pans, so its menu would only get in the way.
    on(canvas, "contextmenu", (e) => e.preventDefault());
    // Double click: fly to the node, or move in on the empty spot under the pointer.
    on(canvas, "dblclick", (e) => {
      const index = this.pick(e.clientX, e.clientY);
      if (index >= 0) {
        this.select(index);
        this.options.onSelect?.(index);
      } else {
        const [nx, ny] = this.ndc(e.clientX, e.clientY);
        this.flyTo(zoomAt(this.camera, 0.55, nx, ny, this.aspect), ZOOM_MS + 80);
      }
    });
    on(
      canvas,
      "wheel",
      (e) => {
        e.preventDefault();
        this.flight = null;
        // Lines and pages, not pixels, from some mice.
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        if (e.shiftKey) {
          // Shift turns a wheel sideways in most browsers, so take whichever axis moved.
          const rect = canvas.getBoundingClientRect();
          this.camera = pan(this.camera, -(e.deltaX || e.deltaY) * unit, e.deltaX ? -e.deltaY * unit : 0, rect.height);
        } else {
          const [nx, ny] = this.ndc(e.clientX, e.clientY);
          // A trackpad pinch arrives as a wheel event with ctrlKey and small deltas.
          const rate = e.ctrlKey ? 0.01 : 0.0012;
          this.camera = zoomAt(this.camera, Math.exp(Math.max(-400, Math.min(400, e.deltaY * unit)) * rate), nx, ny, this.aspect);
        }
        this.invalidate();
      },
      { passive: false },
    );

    // Keyboard, while the canvas has focus. Command, Control and Option combinations stay with the browser and the app.
    on(canvas, "keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      this.shift = e.shiftKey;
      if (FLY_KEYS.includes(e.code)) {
        e.preventDefault();
        this.flight = null;
        if (!this.keys.has(e.code)) {
          this.keys.add(e.code);
          // One step right away, so a tap shorter than a frame still moves.
          this.moveByKeys(16);
        }
        this.invalidate();
        return;
      }
      if (e.repeat && e.code !== "Equal" && e.code !== "Minus" && e.code !== "NumpadAdd" && e.code !== "NumpadSubtract") return;
      if (e.code === "Equal" || e.code === "NumpadAdd") this.zoomBy(0.7);
      else if (e.code === "Minus" || e.code === "NumpadSubtract") this.zoomBy(1 / 0.7);
      else if (e.code === "Digit0" || e.code === "Numpad0" || e.code === "Home") this.resetCamera();
      else if (e.code === "KeyF") this.frameNodes();
      else if (e.code === "Escape" && this.selected >= 0) {
        this.select(-1);
        this.options.onSelect?.(-1);
      } else return;
      e.preventDefault();
    });
    on(canvas, "keyup", (e) => {
      this.shift = e.shiftKey;
      this.keys.delete(e.code);
    });
    on(canvas, "blur", () => this.keys.clear());

    const observer = new ResizeObserver(() => this.invalidate());
    observer.observe(canvas);
    this.cleanup.push(() => observer.disconnect());
  }
}
