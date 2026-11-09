// WebGL2 graph renderer: points and lines in 3D, orbit camera, click to select.
// No library: the page's CSP allows only bundled scripts, and the graphs are a few hundred nodes.

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

const TYPES = ["document", "concept", "code"];
// Indigo, sky and fuchsia, matching the legend swatches (Tailwind 500 in dark, 700 in light).
const TYPE_COLOR: Record<Theme, number[][]> = {
  dark: [[0.55, 0.47, 1.0], [0.33, 0.75, 0.98], [0.8, 0.55, 1.0]],
  light: [[0.3, 0.25, 0.85], [0.02, 0.45, 0.72], [0.58, 0.24, 0.78]],
};
const EDGE_COLOR: Record<Theme, number[]> = { dark: [0.62, 0.64, 0.74], light: [0.45, 0.46, 0.53] };
const BACKGROUND: Record<Theme, number[]> = { dark: [0.035, 0.035, 0.043], light: [0.98, 0.98, 0.98] };

type Mat4 = Float32Array;
function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) o[j * 4 + i] = a[i]! * b[j * 4]! + a[4 + i]! * b[j * 4 + 1]! + a[8 + i]! * b[j * 4 + 2]! + a[12 + i]! * b[j * 4 + 3]!;
  return o;
}
function identity(): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const o = new Float32Array(16);
  o[0] = f / aspect;
  o[5] = f;
  o[10] = (far + near) / (near - far);
  o[11] = -1;
  o[14] = (2 * far * near) / (near - far);
  return o;
}
function translate(x: number, y: number, z: number): Mat4 {
  const o = identity();
  o[12] = x;
  o[13] = y;
  o[14] = z;
  return o;
}
function rotX(a: number): Mat4 {
  const o = identity();
  o[5] = Math.cos(a);
  o[6] = Math.sin(a);
  o[9] = -Math.sin(a);
  o[10] = Math.cos(a);
  return o;
}
function rotY(a: number): Mat4 {
  const o = identity();
  o[0] = Math.cos(a);
  o[2] = -Math.sin(a);
  o[8] = Math.sin(a);
  o[10] = Math.cos(a);
  return o;
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

const POINT_VS = `#version 300 es
in vec3 aPos; in float aSize; in vec3 aColor; in float aAlpha;
uniform mat4 uVP; uniform float uScale;
out vec3 vColor; out float vAlpha;
void main() {
  vec4 clip = uVP * vec4(aPos, 1.0);
  gl_Position = clip;
  gl_PointSize = clamp(aSize * uScale / max(clip.w, 0.05), 1.5, 30.0);
  vColor = aColor; vAlpha = aAlpha;
}`;
const POINT_FS = `#version 300 es
precision highp float;
in vec3 vColor; in float vAlpha; uniform float uGlow; out vec4 outColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = uGlow > 0.5 ? pow(smoothstep(1.0, 0.0, r), 1.9) * 0.95 : smoothstep(0.95, 0.55, r);
  if (a <= 0.002) discard;
  outColor = vec4(vColor, a * vAlpha);
}`;
const LINE_VS = `#version 300 es
in vec3 aPos; in float aAlpha; uniform mat4 uVP; out float vAlpha;
void main() { gl_Position = uVP * vec4(aPos, 1.0); vAlpha = aAlpha; }`;
const LINE_FS = `#version 300 es
precision highp float;
in float vAlpha; uniform vec3 uColor; out vec4 outColor;
void main() { outColor = vec4(uColor, vAlpha); }`;
const RING_VS = `#version 300 es
uniform vec3 uPos; uniform float uSize; uniform mat4 uVP; uniform float uScale;
void main() { vec4 clip = uVP * vec4(uPos, 1.0); gl_Position = clip; gl_PointSize = clamp(uSize * uScale / max(clip.w, 0.05), 6.0, 80.0); }`;
const RING_FS = `#version 300 es
precision highp float;
uniform vec3 uColor; uniform float uStyle; out vec4 outColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = uStyle < 0.5 ? smoothstep(0.14, 0.0, abs(r - 0.78)) : smoothstep(1.0, 0.15, r) * 0.35;
  if (a <= 0.003) discard;
  outColor = vec4(uColor, a);
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

// Far enough that the layout radius (1.25) fits the 42 degree vertical field of view.
const DEFAULT_CAMERA = { yaw: 0.55, pitch: 0.3, dist: 3.5 };

export class GraphRenderer {
  readonly positions: Float32Array;
  readonly screen: Float32Array;
  private gl: WebGL2RenderingContext;
  private n: number;
  private theme: Theme;
  private selected = -1;
  private hovered = -1;
  private camera = { ...DEFAULT_CAMERA };
  private target = [0, 0, 0];
  private frame = 0;
  private sizes: Float32Array;
  private neighbours: number[][];
  private programs: { point: WebGLProgram; line: WebGLProgram; ring: WebGLProgram };
  private buffers: { color: WebGLBuffer; alpha: WebGLBuffer; edgeAlpha: WebGLBuffer };
  private vaos: { point: WebGLVertexArrayObject; line: WebGLVertexArrayObject; ring: WebGLVertexArrayObject };
  private edgeCount: number;
  private cleanup: (() => void)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private graph: RenderGraph,
    private options: GraphRendererOptions,
  ) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!gl) throw new Error("This browser cannot create a WebGL2 context.");
    this.gl = gl;
    this.n = graph.nodes.length;
    this.theme = options.theme;
    this.positions = layoutGraph(graph);
    this.screen = new Float32Array(this.n * 4);
    this.sizes = new Float32Array(graph.nodes.map((node) => 1.4 + Math.sqrt(node.degree) * 0.55));
    this.neighbours = graph.nodes.map(() => []);
    for (const e of graph.edges) {
      this.neighbours[e.source]!.push(e.target);
      this.neighbours[e.target]!.push(e.source);
    }
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
    const color = attribute(this.programs.point, "aColor", new Float32Array(this.n * 3), 3, gl.DYNAMIC_DRAW);
    const alpha = attribute(this.programs.point, "aAlpha", new Float32Array(this.n), 1, gl.DYNAMIC_DRAW);

    this.edgeCount = graph.edges.length;
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
    this.buffers = { color, alpha, edgeAlpha };
    this.restyle();
    this.bindInput();
    this.invalidate();
  }

  setTheme(theme: Theme) {
    if (theme === this.theme) return;
    this.theme = theme;
    this.restyle();
  }

  select(index: number, { center = true } = {}) {
    this.selected = index;
    if (center) {
      this.target = index >= 0 ? [this.positions[index * 3]!, this.positions[index * 3 + 1]!, this.positions[index * 3 + 2]!] : [0, 0, 0];
      if (index >= 0) this.camera.dist = Math.min(this.camera.dist, 1.4);
    }
    this.restyle();
  }

  resetCamera() {
    this.camera = { ...DEFAULT_CAMERA };
    this.target = [0, 0, 0];
    this.invalidate();
  }

  // Draws once on the next animation frame; nothing renders while the graph is idle.
  invalidate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    for (const fn of this.cleanup) fn();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  // Colours and alphas for the current theme and selection; the selection's neighbourhood stays lit.
  private restyle() {
    const gl = this.gl;
    const dark = this.theme === "dark";
    const focus = this.hovered >= 0 ? this.hovered : this.selected;
    const lit = new Uint8Array(this.n);
    if (focus >= 0) {
      lit[focus] = 1;
      for (const j of this.neighbours[focus]!) lit[j] = 1;
    }
    const colors = new Float32Array(this.n * 3);
    const alphas = new Float32Array(this.n);
    this.graph.nodes.forEach((node, i) => {
      const c = TYPE_COLOR[this.theme][Math.max(0, TYPES.indexOf(node.type))]!;
      const dim = focus >= 0 && !lit[i] ? 0.72 : 1;
      colors.set([c[0]! * dim, c[1]! * dim, c[2]! * dim], i * 3);
      // Ungrounded nodes are drawn faint: no passage backs them.
      const base = node.grounded ? 1 : dark ? 0.42 : 0.55;
      alphas[i] = focus >= 0 && !lit[i] ? base * 0.3 : base;
    });
    const edgeAlphas = new Float32Array(this.edgeCount * 2);
    this.graph.edges.forEach((e, i) => {
      const a = focus < 0 ? (dark ? 0.24 : 0.26) : e.source === focus || e.target === focus ? 0.85 : 0.04;
      edgeAlphas[i * 2] = a;
      edgeAlphas[i * 2 + 1] = a;
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.color);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.alpha);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, alphas);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.edgeAlpha);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, edgeAlphas);
    this.invalidate();
  }

  private viewProjection(): Mat4 {
    const { canvas } = this;
    const t = this.target;
    const view = mul(translate(0, 0, -this.camera.dist), mul(rotX(this.camera.pitch), mul(rotY(this.camera.yaw), translate(-t[0]!, -t[1]!, -t[2]!))));
    return mul(perspective((42 * Math.PI) / 180, canvas.width / Math.max(1, canvas.height), 0.05, 50), view);
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

  private draw() {
    const gl = this.gl;
    this.resize();
    const dark = this.theme === "dark";
    const vp = this.viewProjection();
    const rect = this.canvas.getBoundingClientRect();
    for (let i = 0; i < this.n; i++) {
      const x = this.positions[i * 3]!, y = this.positions[i * 3 + 1]!, z = this.positions[i * 3 + 2]!;
      const cx = vp[0]! * x + vp[4]! * y + vp[8]! * z + vp[12]!;
      const cy = vp[1]! * x + vp[5]! * y + vp[9]! * z + vp[13]!;
      const cw = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!;
      const visible = cw > 0.05;
      this.screen[i * 4] = visible ? ((cx / cw) * 0.5 + 0.5) * rect.width : -1e4;
      this.screen[i * 4 + 1] = visible ? (0.5 - (cy / cw) * 0.5) * rect.height : -1e4;
      this.screen[i * 4 + 2] = cw;
      this.screen[i * 4 + 3] = visible ? 1 : 0;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const bg = BACKGROUND[this.theme];
    gl.clearColor(bg[0]!, bg[1]!, bg[2]!, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    // Additive glow reads well on a dark stage; on light it would wash out to white.
    gl.blendFunc(gl.SRC_ALPHA, dark ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    const scale = this.canvas.height * 0.034 * (dark ? 1 : 0.62);

    const { line, point, ring } = this.programs;
    gl.useProgram(line);
    gl.uniformMatrix4fv(gl.getUniformLocation(line, "uVP"), false, vp);
    gl.uniform3fv(gl.getUniformLocation(line, "uColor"), EDGE_COLOR[this.theme]);
    gl.bindVertexArray(this.vaos.line);
    gl.drawArrays(gl.LINES, 0, this.edgeCount * 2);

    gl.useProgram(point);
    gl.uniformMatrix4fv(gl.getUniformLocation(point, "uVP"), false, vp);
    gl.uniform1f(gl.getUniformLocation(point, "uScale"), scale);
    gl.uniform1f(gl.getUniformLocation(point, "uGlow"), dark ? 1 : 0);
    gl.bindVertexArray(this.vaos.point);
    gl.drawArrays(gl.POINTS, 0, this.n);

    const mark = (index: number, style: number, factor: number) => {
      if (index < 0) return;
      gl.useProgram(ring);
      gl.uniformMatrix4fv(gl.getUniformLocation(ring, "uVP"), false, vp);
      gl.uniform3f(gl.getUniformLocation(ring, "uPos"), this.positions[index * 3]!, this.positions[index * 3 + 1]!, this.positions[index * 3 + 2]!);
      gl.uniform1f(gl.getUniformLocation(ring, "uSize"), this.sizes[index]! * factor);
      gl.uniform1f(gl.getUniformLocation(ring, "uScale"), scale);
      gl.uniform1f(gl.getUniformLocation(ring, "uStyle"), style);
      gl.uniform3fv(gl.getUniformLocation(ring, "uColor"), dark ? [0.85, 0.85, 1] : [0.25, 0.25, 0.35]);
      gl.bindVertexArray(this.vaos.ring);
      gl.drawArrays(gl.POINTS, 0, 1);
    };
    mark(this.selected, 0, 1.9);
    if (this.hovered !== this.selected) mark(this.hovered, 1, 3.2);
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

  private bindInput() {
    const { canvas } = this;
    let drag: { x: number; y: number; moved: boolean } | null = null;
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    canvas.style.cursor = "grab";
    on(canvas, "pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    on(canvas, "pointermove", (e) => {
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        if (!drag.moved) return;
        this.camera.yaw += dx * 0.008;
        this.camera.pitch = Math.max(-1.45, Math.min(1.45, this.camera.pitch + dy * 0.006));
        drag.x = e.clientX;
        drag.y = e.clientY;
        canvas.style.cursor = "grabbing";
        this.setHover(-1);
        this.invalidate();
        return;
      }
      this.setHover(this.pick(e.clientX, e.clientY));
    });
    on(canvas, "pointerup", (e) => {
      const clicked = drag && !drag.moved;
      drag = null;
      canvas.style.cursor = this.hovered >= 0 ? "pointer" : "grab";
      if (!clicked) return;
      const index = this.pick(e.clientX, e.clientY);
      this.select(index, { center: false });
      this.options.onSelect?.(index);
    });
    on(canvas, "pointerleave", () => this.setHover(-1));
    on(
      canvas,
      "wheel",
      (e) => {
        e.preventDefault();
        this.camera.dist = Math.max(0.5, Math.min(7, this.camera.dist * Math.exp(e.deltaY * 0.0012)));
        this.invalidate();
      },
      { passive: false },
    );
    const observer = new ResizeObserver(() => this.invalidate());
    observer.observe(canvas);
    this.cleanup.push(() => observer.disconnect());
  }
}
