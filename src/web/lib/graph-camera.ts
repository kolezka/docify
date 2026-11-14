// Orbit camera maths for the graph view. No WebGL and no DOM here, so `bun test` can run it.
// The camera looks at `target` from `dist` away; yaw and pitch turn it around that point.

export type Vec3 = [number, number, number];

export interface Camera {
  yaw: number;
  pitch: number;
  dist: number;
  target: Vec3;
}

export const FOV_Y = (42 * Math.PI) / 180;
export const MIN_DIST = 0.15;
export const MAX_DIST = 8;
const MAX_PITCH = 1.45;
// The layout radius is 1.25; this keeps the camera from flying off into empty space.
export const MAX_TARGET = 2.5;
const NEAR = 0.02;
const FAR = 50;

// Far enough that the layout radius (1.25) fits the 42 degree vertical field of view.
export const DEFAULT_CAMERA: Camera = { yaw: 0.55, pitch: 0.3, dist: 3.5, target: [0, 0, 0] };

export function cloneCamera(c: Camera): Camera {
  return { yaw: c.yaw, pitch: c.pitch, dist: c.dist, target: [c.target[0], c.target[1], c.target[2]] };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function clampCamera(c: Camera): Camera {
  const t = c.target;
  const len = Math.hypot(t[0], t[1], t[2]);
  const k = len > MAX_TARGET ? MAX_TARGET / len : 1;
  return { yaw: c.yaw, pitch: clamp(c.pitch, -MAX_PITCH, MAX_PITCH), dist: clamp(c.dist, MIN_DIST, MAX_DIST), target: [t[0] * k, t[1] * k, t[2] * k] };
}

// The camera's own axes in world space: right and up span the screen, forward points into it.
export function cameraAxes(c: Camera): { right: Vec3; up: Vec3; forward: Vec3 } {
  const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
  const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  return { right: [cy, 0, sy], up: [sp * sy, cp, -sp * cy], forward: [cp * sy, -sp, -cp * cy] };
}

export function cameraEye(c: Camera): Vec3 {
  const { forward } = cameraAxes(c);
  return [c.target[0] - forward[0] * c.dist, c.target[1] - forward[1] * c.dist, c.target[2] - forward[2] * c.dist];
}

export function orbit(c: Camera, dYaw: number, dPitch: number): Camera {
  return clampCamera({ ...c, yaw: c.yaw + dYaw, pitch: c.pitch + dPitch });
}

// Moves the target along the camera axes, in world units.
export function fly(c: Camera, right: number, up: number, forward: number): Camera {
  const a = cameraAxes(c);
  const t = c.target;
  return clampCamera({
    ...c,
    target: [
      t[0] + a.right[0] * right + a.up[0] * up + a.forward[0] * forward,
      t[1] + a.right[1] * right + a.up[1] * up + a.forward[1] * forward,
      t[2] + a.right[2] * right + a.up[2] * up + a.forward[2] * forward,
    ],
  });
}

// Drags the scene by a pointer delta in CSS pixels: what was under the pointer stays under it.
export function pan(c: Camera, dx: number, dy: number, viewportHeight: number): Camera {
  const unitsPerPixel = (2 * c.dist * Math.tan(FOV_Y / 2)) / Math.max(1, viewportHeight);
  return fly(c, -dx * unitsPerPixel, dy * unitsPerPixel, 0);
}

// Scales the distance by `factor` while the point under the pointer stays put.
// nx and ny are the pointer in normalized device coordinates: -1..1, y up.
export function zoomAt(c: Camera, factor: number, nx: number, ny: number, aspect: number): Camera {
  const dist = clamp(c.dist * factor, MIN_DIST, MAX_DIST);
  const shift = (c.dist - dist) * Math.tan(FOV_Y / 2);
  return fly({ ...c, dist }, nx * aspect * shift, ny * shift, 0);
}

// Centre and radius of a set of points; `indices` picks nodes out of a flat x,y,z array.
export function boundingSphere(positions: Float32Array, indices?: ArrayLike<number>): { centre: Vec3; radius: number } {
  const count = indices ? indices.length : positions.length / 3;
  const centre: Vec3 = [0, 0, 0];
  if (!count) return { centre, radius: 0 };
  const at = (k: number) => (indices ? indices[k]! : k) * 3;
  for (let k = 0; k < count; k++) for (let a = 0; a < 3; a++) centre[a]! += positions[at(k) + a]! / count;
  let radius = 0;
  for (let k = 0; k < count; k++) {
    const i = at(k);
    radius = Math.max(radius, Math.hypot(positions[i]! - centre[0], positions[i + 1]! - centre[1], positions[i + 2]! - centre[2]));
  }
  return { centre, radius };
}

// Same viewing angle, moved and pulled back so the sphere fits the narrower side of the viewport.
export function fitSphere(c: Camera, centre: Vec3, radius: number, aspect: number): Camera {
  const halfY = FOV_Y / 2;
  const half = Math.min(halfY, Math.atan(Math.tan(halfY) * aspect));
  // A lone node has no radius; 0.25 keeps it from filling the view.
  const dist = (Math.max(radius, 0.25) / Math.sin(half)) * 1.12;
  return clampCamera({ ...c, target: [centre[0], centre[1], centre[2]], dist });
}

export function ease(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

// Blend of two cameras. Yaw takes the short way round and distance scales evenly, so zooming feels steady.
export function mixCamera(a: Camera, b: Camera, t: number): Camera {
  const turn = ((((b.yaw - a.yaw + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return {
    yaw: a.yaw + turn * t,
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    dist: a.dist * Math.pow(b.dist / a.dist, t),
    target: [a.target[0] + (b.target[0] - a.target[0]) * t, a.target[1] + (b.target[1] - a.target[1]) * t, a.target[2] + (b.target[2] - a.target[2]) * t],
  };
}

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

// Column-major view-projection matrix, as WebGL takes it.
export function viewProjection(c: Camera, aspect: number): Float32Array {
  const t = c.target;
  const view = mul(translate(0, 0, -c.dist), mul(rotX(c.pitch), mul(rotY(c.yaw), translate(-t[0], -t[1], -t[2]))));
  return mul(perspective(FOV_Y, aspect, NEAR, FAR), view);
}

// A world point in normalized device coordinates (y up) plus its clip depth; depth <= NEAR means behind the camera.
export function project(vp: Float32Array, x: number, y: number, z: number): { nx: number; ny: number; depth: number } {
  const cx = vp[0]! * x + vp[4]! * y + vp[8]! * z + vp[12]!;
  const cy = vp[1]! * x + vp[5]! * y + vp[9]! * z + vp[13]!;
  const cw = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!;
  return { nx: cx / cw, ny: cy / cw, depth: cw };
}
