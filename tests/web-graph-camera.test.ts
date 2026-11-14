import { expect, test } from "bun:test";
import {
  boundingSphere,
  cameraAxes,
  cameraEye,
  clampCamera,
  DEFAULT_CAMERA,
  ease,
  fitSphere,
  fly,
  FOV_Y,
  MAX_DIST,
  MAX_TARGET,
  MIN_DIST,
  mixCamera,
  orbit,
  pan,
  project,
  viewProjection,
  zoomAt,
  type Camera,
  type Vec3,
} from "../src/web/lib/graph-camera.ts";

const camera = (over: Partial<Camera> = {}): Camera => ({ yaw: 0.7, pitch: -0.4, dist: 2.5, target: [0.3, -0.2, 0.5], ...over });
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const screen = (c: Camera, p: Vec3, aspect = 1.6) => project(viewProjection(c, aspect), p[0], p[1], p[2]);

test("the camera axes are unit length, at right angles, and match what the matrix draws", () => {
  const c = camera();
  const { right, up, forward } = cameraAxes(c);
  for (const axis of [right, up, forward]) expect(Math.hypot(...axis)).toBeCloseTo(1, 6);
  expect(dot(right, up)).toBeCloseTo(0, 6);
  expect(dot(right, forward)).toBeCloseTo(0, 6);
  expect(dot(up, forward)).toBeCloseTo(0, 6);

  const t = c.target;
  const centre = screen(c, t);
  expect(centre.nx).toBeCloseTo(0, 5);
  expect(centre.ny).toBeCloseTo(0, 5);
  expect(centre.depth).toBeCloseTo(c.dist, 5);
  // A step along `right` moves right on screen only; along `up`, up only; along `forward`, away.
  const r = screen(c, [t[0] + right[0] * 0.1, t[1] + right[1] * 0.1, t[2] + right[2] * 0.1]);
  expect(r.nx).toBeGreaterThan(0.01);
  expect(r.ny).toBeCloseTo(0, 5);
  const u = screen(c, [t[0] + up[0] * 0.1, t[1] + up[1] * 0.1, t[2] + up[2] * 0.1]);
  expect(u.ny).toBeGreaterThan(0.01);
  expect(u.nx).toBeCloseTo(0, 5);
  const f = screen(c, [t[0] + forward[0] * 0.1, t[1] + forward[1] * 0.1, t[2] + forward[2] * 0.1]);
  expect(f.depth).toBeCloseTo(c.dist + 0.1, 5);
  // The eye sits at depth zero.
  expect(screen(c, cameraEye(c)).depth).toBeCloseTo(0, 5);
});

test("panning keeps the point under the pointer under the pointer", () => {
  const c = camera();
  const height = 600;
  const aspect = 1.6;
  const before = screen(c, c.target, aspect);
  const dx = 80;
  const dy = -45;
  const after = screen(pan(c, dx, dy, height), c.target, aspect);
  // NDC to CSS pixels: x spans width = height * aspect, y is flipped.
  expect(((after.nx - before.nx) / 2) * height * aspect).toBeCloseTo(dx, 3);
  expect((-(after.ny - before.ny) / 2) * height).toBeCloseTo(dy, 3);
});

test("zooming holds the point under the pointer still, and stops at the distance limits", () => {
  const c = camera();
  const aspect = 1.6;
  const nx = 0.5;
  const ny = -0.3;
  // The point of the target plane that shows at (nx, ny).
  const { right, up } = cameraAxes(c);
  const half = c.dist * Math.tan(FOV_Y / 2);
  const p: Vec3 = [
    c.target[0] + right[0] * nx * aspect * half + up[0] * ny * half,
    c.target[1] + right[1] * nx * aspect * half + up[1] * ny * half,
    c.target[2] + right[2] * nx * aspect * half + up[2] * ny * half,
  ];
  expect(screen(c, p, aspect).nx).toBeCloseTo(nx, 5);
  for (const factor of [0.5, 1.8]) {
    const z = zoomAt(c, factor, nx, ny, aspect);
    expect(z.dist).toBeCloseTo(c.dist * factor, 6);
    const s = screen(z, p, aspect);
    expect(s.nx).toBeCloseTo(nx, 5);
    expect(s.ny).toBeCloseTo(ny, 5);
  }
  expect(zoomAt(c, 0.0001, 0, 0, aspect).dist).toBe(MIN_DIST);
  expect(zoomAt(c, 1000, 0, 0, aspect).dist).toBe(MAX_DIST);
  // At a limit nothing moves, so the pointer cannot drag the scene sideways.
  const stuck = zoomAt(camera({ dist: MAX_DIST }), 2, 0.9, 0.9, aspect);
  expect(stuck.target).toEqual(camera().target);
});

test("flying moves along the view, and orbit and target stay inside their limits", () => {
  const c = camera();
  const moved = fly(c, 0, 0, 0.5);
  const { forward } = cameraAxes(c);
  expect(moved.target[0]).toBeCloseTo(c.target[0] + forward[0] * 0.5, 6);
  expect(moved.target[1]).toBeCloseTo(c.target[1] + forward[1] * 0.5, 6);
  expect(moved.dist).toBe(c.dist);

  expect(Math.abs(orbit(c, 0, 10).pitch)).toBeLessThan(Math.PI / 2);
  expect(Math.abs(orbit(c, 0, -10).pitch)).toBeLessThan(Math.PI / 2);
  expect(orbit(c, 1, 0).yaw).toBeCloseTo(c.yaw + 1, 6);
  expect(Math.hypot(...fly(c, 100, 0, 0).target)).toBeCloseTo(MAX_TARGET, 5);
  expect(clampCamera(camera({ dist: 0 })).dist).toBe(MIN_DIST);
});

test("fitting a set of nodes puts all of them inside the viewport, wide or tall", () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, -0.5, 0.2, 0.9, 5, 5, 5]);
  const subset = [0, 1, 2, 3, 4];
  const { centre, radius } = boundingSphere(positions, subset);
  expect(radius).toBeGreaterThan(0.5);
  for (const aspect of [2.2, 1, 0.45]) {
    const fitted = fitSphere(camera(), centre, radius, aspect);
    expect(fitted.yaw).toBe(camera().yaw);
    for (const i of subset) {
      const s = screen(fitted, [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!], aspect);
      expect(Math.abs(s.nx)).toBeLessThan(1);
      expect(Math.abs(s.ny)).toBeLessThan(1);
      expect(s.depth).toBeGreaterThan(0);
    }
  }
  // All nodes when no subset is given; one node still gets a sane distance; none is not an error.
  expect(boundingSphere(positions).radius).toBeGreaterThan(radius);
  expect(fitSphere(camera(), [1, 1, 1], 0, 1).dist).toBeGreaterThan(MIN_DIST);
  expect(boundingSphere(new Float32Array(0))).toEqual({ centre: [0, 0, 0], radius: 0 });
});

test("a camera blend starts and ends exactly, and turns the short way round", () => {
  const a = camera({ yaw: 3 });
  const b = camera({ yaw: -3, dist: 0.5, pitch: 0.2, target: [1, 1, 1] });
  expect(mixCamera(a, b, 0)).toEqual(a);
  const end = mixCamera(a, b, 1);
  expect(end.dist).toBeCloseTo(b.dist, 6);
  expect(end.pitch).toBeCloseTo(b.pitch, 6);
  expect(end.target).toEqual(b.target);
  // From 3 to -3 radians is 0.28 the short way, not 6 the long way.
  expect(Math.abs(end.yaw - a.yaw)).toBeLessThan(0.3);
  expect(Math.cos(end.yaw)).toBeCloseTo(Math.cos(b.yaw), 6);
  expect(Math.sin(end.yaw)).toBeCloseTo(Math.sin(b.yaw), 6);
  // Distance scales evenly: halfway is the geometric mean.
  expect(mixCamera(a, b, 0.5).dist).toBeCloseTo(Math.sqrt(a.dist * b.dist), 6);

  expect(ease(0)).toBe(0);
  expect(ease(1)).toBe(1);
  expect(ease(0.5)).toBeCloseTo(0.5, 6);
  expect(ease(-1)).toBe(0);
  expect(ease(2)).toBe(1);
  for (let t = 0.05; t <= 1; t += 0.05) expect(ease(t)).toBeGreaterThan(ease(t - 0.05));
});

test("the default camera sees the whole layout radius", () => {
  for (const p of [[1.25, 0, 0], [0, 1.25, 0], [0, 0, 1.25], [-1.25, 0, 0], [0, -1.25, 0]] as Vec3[]) {
    const s = screen(DEFAULT_CAMERA, p, 1.5);
    expect(Math.abs(s.ny)).toBeLessThan(1);
    expect(Math.abs(s.nx)).toBeLessThan(1);
  }
});
