import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";

const app = document.querySelector(".app");
const canvas = document.querySelector("#scene");
const statusNode = document.querySelector("#status");
const statsNode = document.querySelector("#stats");

const seedInput = document.querySelector("#seed");
const randomizeButton = document.querySelector("#randomize");
const regenerateButton = document.querySelector("#regenerate");
const sampleBurstButton = document.querySelector("#sample-burst");
const downloadFormButton = document.querySelector("#download-form");

const ridgeToggle = document.querySelector("#toggle-ridges");
const surfacesToggle = document.querySelector("#toggle-surfaces");

const rangeControls = [
  { id: "max-depth", outputId: "max-depth-value", format: (v) => `${Math.round(v)}` },
  { id: "initial-arms", outputId: "initial-arms-value", format: (v) => `${Math.round(v)}` },
  { id: "global-angle", outputId: "global-angle-value", format: (v) => `${Math.round(v)}deg` },
  { id: "trunk-length", outputId: "trunk-length-value", format: (v) => `${v.toFixed(1)}` },
  { id: "length-decay", outputId: "length-decay-value", format: (v) => v.toFixed(2) },
  { id: "branch-chance", outputId: "branch-chance-value", format: (v) => `${Math.round(v * 100)}%` },
  { id: "split-angle", outputId: "split-angle-value", format: (v) => `${Math.round(v)}deg` },
  { id: "jitter", outputId: "jitter-value", format: (v) => `${Math.round(v)}deg` },
  { id: "ridge-height", outputId: "ridge-height-value", format: (v) => `${v.toFixed(1)}` },
  { id: "height-decay", outputId: "height-decay-value", format: (v) => v.toFixed(2) },
  { id: "roof-width", outputId: "roof-width-value", format: (v) => `${v.toFixed(1)}` },
  { id: "width-decay", outputId: "width-decay-value", format: (v) => v.toFixed(2) }
].map((control) => ({
  ...control,
  input: document.querySelector(`#${control.id}`),
  output: document.querySelector(`#${control.outputId}`)
}));

const renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9edf2);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.up.set(0, 0, 1);
camera.position.set(220, -220, 200);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;

scene.add(new THREE.AmbientLight(0xffffff, 0.7));

const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
keyLight.position.set(170, -220, 260);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xbad6ff, 0.6);
fillLight.position.set(-120, 140, 110);
scene.add(fillLight);

const grid = new THREE.GridHelper(140, 28, 0x93a2af, 0xc7d0d9);
grid.rotateX(Math.PI / 2);
scene.add(grid);

const axes = new THREE.AxesHelper(22);
scene.add(axes);

const modelRoot = new THREE.Group();
const ridgeGroup = new THREE.Group();
ridgeGroup.name = "Ridge";
const surfaceGroup = new THREE.Group();
surfaceGroup.name = "Surfaces";
modelRoot.add(surfaceGroup, ridgeGroup);
scene.add(modelRoot);

let hasFramed = false;
let pendingHandle = 0;
let pendingRefit = false;
let burstRunning = false;

function setStatus(message) {
  statusNode.textContent = message;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomSeed() {
  return Math.floor(Math.random() * 0xffffffff) + 1;
}

function sanitizeSeed(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return randomSeed();
  }

  return clamp(parsed, 1, 0xffffffff);
}

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRange(rng, min, max) {
  return min + (max - min) * rng();
}

function rotateVec2(vector, angleRadians) {
  const cos = Math.cos(angleRadians);
  const sin = Math.sin(angleRadians);
  return new THREE.Vector2(vector.x * cos - vector.y * sin, vector.x * sin + vector.y * cos);
}

function orientDirectionOutward(origin, direction, rng, minDot = -0.1, flipProbability = 0.8) {
  const radial = new THREE.Vector2(origin.x, origin.y);
  const normalized = direction.clone().normalize();
  if (radial.lengthSq() <= 1e-6) {
    return normalized;
  }

  const outward = radial.normalize();
  if (normalized.dot(outward) < minDot && rng() < flipProbability) {
    normalized.multiplyScalar(-1);
  }

  return normalized;
}

const PLANAR_EPSILON = 1e-5;

function toPlanar(vector3) {
  return new THREE.Vector2(vector3.x, vector3.y);
}

function pointsEqual2D(a, b, epsilon = PLANAR_EPSILON) {
  return a.distanceToSquared(b) <= epsilon * epsilon;
}

function cross2D(a, b) {
  return a.x * b.y - a.y * b.x;
}

function cross2DPoints(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment2D(a, b, p, epsilon = PLANAR_EPSILON) {
  return (
    p.x >= Math.min(a.x, b.x) - epsilon &&
    p.x <= Math.max(a.x, b.x) + epsilon &&
    p.y >= Math.min(a.y, b.y) - epsilon &&
    p.y <= Math.max(a.y, b.y) + epsilon
  );
}

function segmentsIntersect2D(a, b, c, d, epsilon = PLANAR_EPSILON) {
  const o1 = cross2DPoints(a, b, c);
  const o2 = cross2DPoints(a, b, d);
  const o3 = cross2DPoints(c, d, a);
  const o4 = cross2DPoints(c, d, b);

  const hasGeneralIntersection =
    ((o1 > epsilon && o2 < -epsilon) || (o1 < -epsilon && o2 > epsilon)) &&
    ((o3 > epsilon && o4 < -epsilon) || (o3 < -epsilon && o4 > epsilon));
  if (hasGeneralIntersection) {
    return true;
  }

  if (Math.abs(o1) <= epsilon && onSegment2D(a, b, c, epsilon)) {
    return true;
  }
  if (Math.abs(o2) <= epsilon && onSegment2D(a, b, d, epsilon)) {
    return true;
  }
  if (Math.abs(o3) <= epsilon && onSegment2D(c, d, a, epsilon)) {
    return true;
  }
  if (Math.abs(o4) <= epsilon && onSegment2D(c, d, b, epsilon)) {
    return true;
  }

  return false;
}

function segmentsShareEndpoint2D(a, b, c, d, epsilon = PLANAR_EPSILON) {
  return (
    pointsEqual2D(a, c, epsilon) ||
    pointsEqual2D(a, d, epsilon) ||
    pointsEqual2D(b, c, epsilon) ||
    pointsEqual2D(b, d, epsilon)
  );
}

function areColinearAndOverlapping(a, b, c, d, epsilon = PLANAR_EPSILON) {
  const direction = new THREE.Vector2().subVectors(b, a);
  if (direction.lengthSq() < epsilon * epsilon) {
    return false;
  }

  const axis = Math.abs(direction.x) >= Math.abs(direction.y) ? "x" : "y";
  if (
    Math.abs(cross2DPoints(a, b, c)) > epsilon ||
    Math.abs(cross2DPoints(a, b, d)) > epsilon
  ) {
    return false;
  }

  const aMin = Math.min(a[axis], b[axis]);
  const aMax = Math.max(a[axis], b[axis]);
  const cMin = Math.min(c[axis], d[axis]);
  const cMax = Math.max(c[axis], d[axis]);
  const overlap = Math.min(aMax, cMax) - Math.max(aMin, cMin);
  return overlap > epsilon;
}

function hasInteriorIntersection2D(candidateStart, candidateEnd, segments, parentIndex) {
  for (let i = 0; i < segments.length; i += 1) {
    if (i === parentIndex) {
      continue;
    }

    const other = segments[i];
    const otherStart = toPlanar(other.start);
    const otherEnd = toPlanar(other.end);
    const sharesEndpoint = segmentsShareEndpoint2D(
      candidateStart,
      candidateEnd,
      otherStart,
      otherEnd
    );

    if (sharesEndpoint) {
      if (areColinearAndOverlapping(candidateStart, candidateEnd, otherStart, otherEnd)) {
        return true;
      }
      continue;
    }

    if (segmentsIntersect2D(candidateStart, candidateEnd, otherStart, otherEnd)) {
      return true;
    }
  }

  return false;
}

function pointToSegmentDistanceSq2D(point, segmentStart, segmentEnd) {
  const segment = new THREE.Vector2().subVectors(segmentEnd, segmentStart);
  const segmentLengthSq = segment.lengthSq();
  if (segmentLengthSq <= PLANAR_EPSILON * PLANAR_EPSILON) {
    return point.distanceToSquared(segmentStart);
  }

  const t = clamp(
    new THREE.Vector2().subVectors(point, segmentStart).dot(segment) / segmentLengthSq,
    0,
    1
  );
  const closest = segmentStart.clone().addScaledVector(segment, t);
  return point.distanceToSquared(closest);
}

function segmentDistanceSq2D(a, b, c, d) {
  if (segmentsIntersect2D(a, b, c, d)) {
    return 0;
  }

  return Math.min(
    pointToSegmentDistanceSq2D(a, c, d),
    pointToSegmentDistanceSq2D(b, c, d),
    pointToSegmentDistanceSq2D(c, a, b),
    pointToSegmentDistanceSq2D(d, a, b)
  );
}

function hasFootprintCollision2D(candidateStart, candidateEnd, candidateWidth, segments, parentIndex) {
  for (let i = 0; i < segments.length; i += 1) {
    if (i === parentIndex) {
      continue;
    }

    const other = segments[i];
    const otherStart = toPlanar(other.start);
    const otherEnd = toPlanar(other.end);
    if (segmentsShareEndpoint2D(candidateStart, candidateEnd, otherStart, otherEnd)) {
      continue;
    }

    const distanceSq = segmentDistanceSq2D(candidateStart, candidateEnd, otherStart, otherEnd);
    const clearance = (candidateWidth + other.width) * 0.78;
    if (distanceSq < clearance * clearance) {
      return true;
    }
  }

  return false;
}

function lineIntersection2D(aOrigin, aDir, bOrigin, bDir, epsilon = PLANAR_EPSILON) {
  const denominator = cross2D(aDir, bDir);
  if (Math.abs(denominator) <= epsilon) {
    return null;
  }

  const delta = new THREE.Vector2().subVectors(bOrigin, aOrigin);
  const t = cross2D(delta, bDir) / denominator;
  const u = cross2D(delta, aDir) / denominator;
  return {
    point: aOrigin.clone().addScaledVector(aDir, t),
    t,
    u
  };
}

function clampMiterPoint(nodePlanar, hit, fallback, width) {
  if (!hit) {
    return fallback.clone();
  }

  if (!Number.isFinite(hit.point.x) || !Number.isFinite(hit.point.y)) {
    return fallback.clone();
  }

  const maxMiterDistance = Math.max(width * 3.6, 1.8);
  if (hit.point.distanceTo(nodePlanar) > maxMiterDistance) {
    return fallback.clone();
  }

  if (hit.t < -width * 1.35 || hit.u < -width * 1.35) {
    return fallback.clone();
  }

  return hit.point;
}

function dedupePlanarPoints(points, epsilon = 1e-4) {
  const unique = [];
  const epsilonSq = epsilon * epsilon;

  for (const point of points) {
    const hasMatch = unique.some((candidate) => candidate.distanceToSquared(point) <= epsilonSq);
    if (!hasMatch) {
      unique.push(point.clone());
    }
  }

  return unique;
}

function planarToEave(point, eaveHeight) {
  return new THREE.Vector3(point.x, point.y, eaveHeight);
}

function boundaryPointKey(point) {
  return `${point.x.toFixed(4)}|${point.y.toFixed(4)}|${point.z.toFixed(4)}`;
}

function boundaryEdgeKey(a, b) {
  const keyA = boundaryPointKey(a);
  const keyB = boundaryPointKey(b);
  return keyA < keyB ? `${keyA}=>${keyB}` : `${keyB}=>${keyA}`;
}

function appendBoundaryWalls(surfacePositions, edgePositions, eaveHeight, wallBaseHeight) {
  if (wallBaseHeight >= eaveHeight - 1e-4) {
    return 0;
  }

  const eaveEdgeMap = new Map();
  const eaveEpsilon = 1e-4;

  for (let i = 0; i < surfacePositions.length; i += 9) {
    const a = new THREE.Vector3(surfacePositions[i], surfacePositions[i + 1], surfacePositions[i + 2]);
    const b = new THREE.Vector3(surfacePositions[i + 3], surfacePositions[i + 4], surfacePositions[i + 5]);
    const c = new THREE.Vector3(surfacePositions[i + 6], surfacePositions[i + 7], surfacePositions[i + 8]);
    const edges = [
      [a, b],
      [b, c],
      [c, a]
    ];

    for (const [start, end] of edges) {
      const onEave =
        Math.abs(start.z - eaveHeight) <= eaveEpsilon && Math.abs(end.z - eaveHeight) <= eaveEpsilon;
      if (!onEave) {
        continue;
      }

      const key = boundaryEdgeKey(start, end);
      const existing = eaveEdgeMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        eaveEdgeMap.set(key, { count: 1, start: start.clone(), end: end.clone() });
      }
    }
  }

  let wallTriangleCount = 0;
  for (const edge of eaveEdgeMap.values()) {
    if (edge.count !== 1) {
      continue;
    }

    const topStart = edge.start;
    const topEnd = edge.end;
    const bottomStart = new THREE.Vector3(topStart.x, topStart.y, wallBaseHeight);
    const bottomEnd = new THREE.Vector3(topEnd.x, topEnd.y, wallBaseHeight);

    pushTriangle(surfacePositions, topStart, bottomStart, bottomEnd);
    pushTriangle(surfacePositions, topStart, bottomEnd, topEnd);
    wallTriangleCount += 2;

    pushSegment(edgePositions, topStart, bottomStart);
    pushSegment(edgePositions, topEnd, bottomEnd);
    pushSegment(edgePositions, bottomStart, bottomEnd);
  }

  return wallTriangleCount;
}

function buildChimneyGroup(nodes, params) {
  const chimneyGroup = new THREE.Group();
  const shaftMaterial = new THREE.MeshStandardMaterial({
    color: 0x8e4d37,
    roughness: 0.9,
    metalness: 0.02
  });
  const potMaterial = new THREE.MeshStandardMaterial({
    color: 0xd7d2c8,
    roughness: 0.92,
    metalness: 0.01
  });

  const rng = createRng(((params.seed ^ 0x7f4a7c15) >>> 0) || 1);
  const anchors = nodes.filter(
    (node) => node.incident.length >= 2 && node.position.z > params.eaveHeight + 1
  );
  if (anchors.length === 0) {
    return { chimneyGroup, chimneyCount: 0 };
  }

  const targetCount = clamp(Math.round(anchors.length * 0.28 + params.maxDepth * 0.35), 3, 22);
  const placed = [];
  let chimneyCount = 0;
  let attempts = 0;

  while (chimneyCount < targetCount && attempts < anchors.length * 7) {
    attempts += 1;
    const anchor = anchors[Math.floor(rng() * anchors.length)];
    if (!anchor || rng() > 0.78) {
      continue;
    }

    const planar = anchor.planar;
    const minSpacing = Math.max(params.roofWidth * 0.65, 2.2);
    if (placed.some((point) => point.distanceToSquared(planar) < minSpacing * minSpacing)) {
      continue;
    }

    const radial = planar.lengthSq() > 1e-6 ? planar.clone().normalize() : new THREE.Vector2(1, 0);
    const lateral = new THREE.Vector2(-radial.y, radial.x);
    const offset = radial
      .clone()
      .multiplyScalar(randomRange(rng, -0.6, 0.9))
      .add(lateral.multiplyScalar(randomRange(rng, -1.1, 1.1)));

    const shaftWidth = clamp(params.roofWidth * randomRange(rng, 0.13, 0.23), 0.9, 2.6);
    const shaftDepth = shaftWidth * randomRange(rng, 0.72, 1.26);
    const shaftHeight = randomRange(rng, params.ridgeHeight * 0.55, params.ridgeHeight * 1.2);

    const shaft = new THREE.Mesh(new THREE.BoxGeometry(shaftWidth, shaftDepth, shaftHeight), shaftMaterial);
    shaft.position.set(
      anchor.position.x + offset.x,
      anchor.position.y + offset.y,
      anchor.position.z + shaftHeight * 0.5 + randomRange(rng, 0.4, 1.5)
    );
    shaft.rotation.z = Math.atan2(radial.y, radial.x) + (rng() < 0.5 ? 0 : Math.PI * 0.5);
    chimneyGroup.add(shaft);

    const potCount = 2 + Math.floor(rng() * 3);
    for (let potIndex = 0; potIndex < potCount; potIndex += 1) {
      const column = potIndex % 2;
      const row = Math.floor(potIndex / 2);
      const potWidth = shaftWidth * randomRange(rng, 0.22, 0.3);
      const potDepth = potWidth * randomRange(rng, 0.85, 1.1);
      const potHeight = randomRange(rng, 1, 2.1);

      const pot = new THREE.Mesh(new THREE.BoxGeometry(potWidth, potDepth, potHeight), potMaterial);
      const local = new THREE.Vector3(
        (column - 0.5) * shaftWidth * 0.42 + randomRange(rng, -0.08, 0.08),
        (row - 0.2) * shaftDepth * 0.3 + randomRange(rng, -0.08, 0.08),
        shaftHeight * 0.5 + potHeight * 0.5 + randomRange(rng, 0.05, 0.28)
      );
      local.applyAxisAngle(new THREE.Vector3(0, 0, 1), shaft.rotation.z);
      pot.position.set(
        shaft.position.x + local.x,
        shaft.position.y + local.y,
        shaft.position.z + local.z
      );
      pot.rotation.z = shaft.rotation.z + randomRange(rng, -0.08, 0.08);
      chimneyGroup.add(pot);
    }

    placed.push(planar.clone());
    chimneyCount += 1;
  }

  return { chimneyGroup, chimneyCount };
}

function updateControlOutputs() {
  for (const control of rangeControls) {
    const value = Number(control.input.value);
    control.output.textContent = control.format(value);
  }
}

function readParams() {
  const seed = sanitizeSeed(seedInput.value);
  seedInput.value = `${seed}`;

  return {
    seed,
    maxDepth: Number.parseInt(document.querySelector("#max-depth").value, 10),
    initialArms: Number.parseInt(document.querySelector("#initial-arms").value, 10),
    globalAngleDeg: Number(document.querySelector("#global-angle").value),
    trunkLength: Number(document.querySelector("#trunk-length").value),
    lengthDecay: Number(document.querySelector("#length-decay").value),
    branchChance: Number(document.querySelector("#branch-chance").value),
    splitAngleDeg: Number(document.querySelector("#split-angle").value),
    jitterDeg: Number(document.querySelector("#jitter").value),
    ridgeHeight: Number(document.querySelector("#ridge-height").value),
    heightDecay: Number(document.querySelector("#height-decay").value),
    roofWidth: Number(document.querySelector("#roof-width").value),
    widthDecay: Number(document.querySelector("#width-decay").value),
    eaveHeight: 0,
    wallBaseHeight: -Math.max(2.4, Number(document.querySelector("#ridge-height").value) * 0.78),
    minLength: 3,
    minWidth: 0.85,
    minHeight: 0.7,
    maxSegments: 640
  };
}

function clearGroup(group) {
  group.traverse((child) => {
    if (child.geometry) {
      child.geometry.dispose();
    }

    if (Array.isArray(child.material)) {
      child.material.forEach((material) => material.dispose());
    } else if (child.material) {
      child.material.dispose();
    }
  });

  group.clear();
}

function pushSegment(array, a, b) {
  array.push(a.x, a.y, a.z, b.x, b.y, b.z);
}

function pushTriangle(array, a, b, c) {
  array.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
}

function generateRidgeSegments(params) {
  const rng = createRng(params.seed);
  const jitterRadians = THREE.MathUtils.degToRad(params.jitterDeg);
  const deviationRadians = THREE.MathUtils.degToRad(params.splitAngleDeg);
  const queue = [];
  const segments = [];

  const center = new THREE.Vector3(0, 0, params.ridgeHeight);
  const initialBranchCount = clamp(params.initialArms, 3, 8);
  const globalAngle = THREE.MathUtils.degToRad(params.globalAngleDeg);
  for (let i = 0; i < initialBranchCount; i += 1) {
    const axisIndex = i % 4;
    const laneIndex = Math.floor(i / 4);
    const baseAngle = globalAngle + axisIndex * (Math.PI / 2);
    const angle = baseAngle + randomRange(rng, -jitterRadians * 0.45, jitterRadians * 0.45);
    const direction = new THREE.Vector2(Math.cos(angle), Math.sin(angle));
    const lateral = new THREE.Vector2(-direction.y, direction.x);
    const lateralOffset = laneIndex === 0 ? 0 : randomRange(rng, -1.1, 1.1) * params.roofWidth * 0.58;

    queue.push({
      start: new THREE.Vector3(
        center.x + lateral.x * lateralOffset,
        center.y + lateral.y * lateralOffset,
        center.z
      ),
      dir: direction,
      depth: 0,
      length: params.trunkLength * randomRange(rng, 0.72, 1.08),
      width: params.roofWidth * randomRange(rng, 0.9, 1.07),
      height: params.ridgeHeight,
      parentIndex: -1,
      clusterMode: false
    });
  }

  while (queue.length > 0 && segments.length < params.maxSegments) {
    const state = queue.shift();
    if (!state || state.dir.lengthSq() < PLANAR_EPSILON * PLANAR_EPSILON) {
      continue;
    }
    const dir = state.dir.clone().normalize();

    if (
      state.length < params.minLength ||
      state.width < params.minWidth ||
      state.height <= params.minHeight
    ) {
      continue;
    }

    const lengthScale = 1 + randomRange(rng, -0.2, 0.16);
    const segmentLength = state.length * Math.max(0.4, lengthScale);
    const endHeight = Math.max(
      params.eaveHeight + 0.45,
      state.height * params.heightDecay + randomRange(rng, -0.35, 0.35)
    );
    const end = new THREE.Vector3(
      state.start.x + dir.x * segmentLength,
      state.start.y + dir.y * segmentLength,
      endHeight
    );
    const candidateStart = toPlanar(state.start);
    const candidateEnd = toPlanar(end);

    if (hasInteriorIntersection2D(candidateStart, candidateEnd, segments, state.parentIndex)) {
      continue;
    }
    if (hasFootprintCollision2D(candidateStart, candidateEnd, state.width, segments, state.parentIndex)) {
      continue;
    }

    const segmentIndex = segments.length;
    segments.push({
      start: state.start.clone(),
      end: end.clone(),
      width: state.width,
      depth: state.depth
    });

    if (state.depth >= params.maxDepth) {
      continue;
    }

    const nextDepth = state.depth + 1;
    const baseLength = state.length * params.lengthDecay;
    const baseWidth = state.width * params.widthDecay;

    const continuationBaseTurn =
      rng() < 0.2 ? (rng() < 0.5 ? -1 : 1) * (Math.PI / 2) : 0;
    const continuationTurn =
      continuationBaseTurn + randomRange(rng, -jitterRadians * 0.4, jitterRadians * 0.4);
    const continuationDirection = orientDirectionOutward(
      end,
      rotateVec2(dir, continuationTurn),
      rng,
      state.clusterMode ? -0.35 : -0.12
    );
    const shouldContinue = rng() < (state.clusterMode ? 0.46 : 0.82);
    if (shouldContinue) {
      queue.push({
        start: end.clone(),
        dir: continuationDirection,
        depth: nextDepth,
        length: baseLength * randomRange(rng, 0.88, 1.12),
        width: baseWidth * randomRange(rng, 0.9, 1.06),
        height: endHeight * randomRange(rng, 0.93, 1.04),
        parentIndex: segmentIndex,
        clusterMode: state.clusterMode
      });
    }

    const branchChance = state.clusterMode ? params.branchChance * 0.38 : params.branchChance;
    const branchRoll = rng();
    const sideBranchCount =
      branchRoll < branchChance ? (state.clusterMode ? 1 : rng() < params.branchChance * 0.55 ? 2 : 1) : 0;

    if (sideBranchCount > 0) {
      const firstSide = rng() < 0.5 ? -1 : 1;
      for (let i = 0; i < sideBranchCount; i += 1) {
        const side = i === 0 ? firstSide : -firstSide;
        const split = side * (Math.PI / 2 + randomRange(rng, -deviationRadians, deviationRadians));
        const sideDirection = orientDirectionOutward(
          end,
          rotateVec2(dir, split),
          rng,
          state.clusterMode ? -0.45 : -0.18
        );
        queue.push({
          start: end.clone(),
          dir: sideDirection,
          depth: nextDepth,
          length: baseLength * randomRange(rng, state.clusterMode ? 0.4 : 0.52, state.clusterMode ? 0.72 : 0.9),
          width: baseWidth * randomRange(rng, 0.66, 0.94),
          height: endHeight * randomRange(rng, 0.84, 0.98),
          parentIndex: segmentIndex,
          clusterMode: true
        });
      }
    }

    if (!state.clusterMode && rng() < params.branchChance * 0.9) {
      const spurSide = rng() < 0.5 ? -1 : 1;
      const spurTurn = spurSide * (Math.PI / 2 + randomRange(rng, -deviationRadians * 0.6, deviationRadians * 0.6));
      const spurStart = state.start.clone().lerp(end, randomRange(rng, 0.25, 0.68));
      const spurDirection = orientDirectionOutward(
        spurStart,
        rotateVec2(dir, spurTurn),
        rng,
        -0.52,
        0.45
      );

      queue.push({
        start: spurStart,
        dir: spurDirection,
        depth: nextDepth,
        length: baseLength * randomRange(rng, 0.3, 0.56),
        width: baseWidth * randomRange(rng, 0.58, 0.8),
        height: endHeight * randomRange(rng, 0.88, 1),
        parentIndex: segmentIndex,
        clusterMode: true
      });
    }
  }

  return segments;
}

function buildRoofGeometry(segments, params) {
  const ridgePositions = [];
  const edgePositions = [];
  const surfacePositions = [];

  const nodes = [];
  const nodeByKey = new Map();
  const endpoints = [];
  const segmentEndpointRefs = new Array(segments.length);

  function nodeKey(position) {
    return `${position.x.toFixed(5)}|${position.y.toFixed(5)}|${position.z.toFixed(5)}`;
  }

  function getNode(position) {
    const key = nodeKey(position);
    if (nodeByKey.has(key)) {
      return nodes[nodeByKey.get(key)];
    }

    const node = {
      id: nodes.length,
      position: position.clone(),
      planar: new THREE.Vector2(position.x, position.y),
      incident: []
    };
    nodes.push(node);
    nodeByKey.set(key, node.id);
    return node;
  }

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const planDelta = new THREE.Vector2(
      segment.end.x - segment.start.x,
      segment.end.y - segment.start.y
    );
    if (planDelta.lengthSq() < PLANAR_EPSILON * PLANAR_EPSILON) {
      continue;
    }

    const tangent = planDelta.normalize();
    const startNode = getNode(segment.start);
    const endNode = getNode(segment.end);

    const startEndpoint = {
      nodeId: startNode.id,
      segmentIndex,
      atStart: true,
      dir: tangent.clone(),
      width: segment.width,
      leftOrigin: startNode.planar
        .clone()
        .add(new THREE.Vector2(-tangent.y, tangent.x).multiplyScalar(segment.width)),
      rightOrigin: startNode.planar
        .clone()
        .add(new THREE.Vector2(tangent.y, -tangent.x).multiplyScalar(segment.width)),
      leftPoint: null,
      rightPoint: null
    };
    const endTangent = tangent.clone().multiplyScalar(-1);
    const endEndpoint = {
      nodeId: endNode.id,
      segmentIndex,
      atStart: false,
      dir: endTangent,
      width: segment.width,
      leftOrigin: endNode.planar
        .clone()
        .add(new THREE.Vector2(-endTangent.y, endTangent.x).multiplyScalar(segment.width)),
      rightOrigin: endNode.planar
        .clone()
        .add(new THREE.Vector2(endTangent.y, -endTangent.x).multiplyScalar(segment.width)),
      leftPoint: null,
      rightPoint: null
    };

    const startEndpointId = endpoints.length;
    endpoints.push(startEndpoint);
    nodes[startNode.id].incident.push(startEndpointId);

    const endEndpointId = endpoints.length;
    endpoints.push(endEndpoint);
    nodes[endNode.id].incident.push(endEndpointId);

    segmentEndpointRefs[segmentIndex] = {
      startEndpointId,
      endEndpointId
    };
  }

  for (const node of nodes) {
    const incidentEndpoints = node.incident
      .map((endpointId) => endpoints[endpointId])
      .sort((a, b) => Math.atan2(a.dir.y, a.dir.x) - Math.atan2(b.dir.y, b.dir.x));

    if (incidentEndpoints.length === 0) {
      continue;
    }

    if (incidentEndpoints.length === 1) {
      const onlyEndpoint = incidentEndpoints[0];
      onlyEndpoint.leftPoint = onlyEndpoint.leftOrigin.clone();
      onlyEndpoint.rightPoint = onlyEndpoint.rightOrigin.clone();
      continue;
    }

    for (let i = 0; i < incidentEndpoints.length; i += 1) {
      const current = incidentEndpoints[i];
      const ccwNeighbor = incidentEndpoints[(i + 1) % incidentEndpoints.length];
      const cwNeighbor =
        incidentEndpoints[(i - 1 + incidentEndpoints.length) % incidentEndpoints.length];

      const leftHit = lineIntersection2D(
        current.leftOrigin,
        current.dir,
        ccwNeighbor.rightOrigin,
        ccwNeighbor.dir
      );
      const rightHit = lineIntersection2D(
        current.rightOrigin,
        current.dir,
        cwNeighbor.leftOrigin,
        cwNeighbor.dir
      );

      current.leftPoint = clampMiterPoint(node.planar, leftHit, current.leftOrigin, current.width);
      current.rightPoint = clampMiterPoint(node.planar, rightHit, current.rightOrigin, current.width);
    }
  }

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const refs = segmentEndpointRefs[segmentIndex];
    if (!refs) {
      continue;
    }

    const startEndpoint = endpoints[refs.startEndpointId];
    const endEndpoint = endpoints[refs.endEndpointId];

    const startLeftPlanar = startEndpoint.leftPoint ?? startEndpoint.leftOrigin;
    const startRightPlanar = startEndpoint.rightPoint ?? startEndpoint.rightOrigin;
    const endLeftPlanar = endEndpoint.rightPoint ?? endEndpoint.rightOrigin;
    const endRightPlanar = endEndpoint.leftPoint ?? endEndpoint.leftOrigin;

    const start = segment.start;
    const end = segment.end;
    const leftStart = planarToEave(startLeftPlanar, params.eaveHeight);
    const rightStart = planarToEave(startRightPlanar, params.eaveHeight);
    const leftEnd = planarToEave(endLeftPlanar, params.eaveHeight);
    const rightEnd = planarToEave(endRightPlanar, params.eaveHeight);

    pushSegment(ridgePositions, start, end);
    pushSegment(edgePositions, leftStart, leftEnd);
    pushSegment(edgePositions, rightStart, rightEnd);
    pushSegment(edgePositions, start, leftStart);
    pushSegment(edgePositions, start, rightStart);
    pushSegment(edgePositions, end, leftEnd);
    pushSegment(edgePositions, end, rightEnd);

    pushTriangle(surfacePositions, start, end, leftEnd);
    pushTriangle(surfacePositions, start, leftEnd, leftStart);
    pushTriangle(surfacePositions, start, rightStart, rightEnd);
    pushTriangle(surfacePositions, start, rightEnd, end);
  }

  for (const node of nodes) {
    if (node.incident.length === 0) {
      continue;
    }

    const nodeTop = node.position;
    const incidentEndpoints = node.incident
      .map((endpointId) => endpoints[endpointId])
      .sort((a, b) => Math.atan2(a.dir.y, a.dir.x) - Math.atan2(b.dir.y, b.dir.x));

    if (node.incident.length === 1) {
      const endpoint = incidentEndpoints[0];
      const left = planarToEave(endpoint.leftPoint ?? endpoint.leftOrigin, params.eaveHeight);
      const right = planarToEave(endpoint.rightPoint ?? endpoint.rightOrigin, params.eaveHeight);
      pushTriangle(surfacePositions, nodeTop, left, right);
      pushSegment(edgePositions, left, right);
      continue;
    }

    for (let i = 0; i < incidentEndpoints.length; i += 1) {
      const current = incidentEndpoints[i];
      const next = incidentEndpoints[(i + 1) % incidentEndpoints.length];

      const currentRight = planarToEave(
        current.rightPoint ?? current.rightOrigin,
        params.eaveHeight
      );
      const currentLeft = planarToEave(
        current.leftPoint ?? current.leftOrigin,
        params.eaveHeight
      );
      const nextRight = planarToEave(next.rightPoint ?? next.rightOrigin, params.eaveHeight);

      pushTriangle(surfacePositions, nodeTop, currentRight, currentLeft);
      pushSegment(edgePositions, currentRight, currentLeft);

      if (currentLeft.distanceTo(nextRight) > 1e-3) {
        pushTriangle(surfacePositions, nodeTop, currentLeft, nextRight);
        pushSegment(edgePositions, currentLeft, nextRight);
      }
    }
  }

  const wallTriangleCount = appendBoundaryWalls(
    surfacePositions,
    edgePositions,
    params.eaveHeight,
    params.wallBaseHeight
  );
  const chimneyData = buildChimneyGroup(nodes, params);

  const ridgeGeometry = new THREE.BufferGeometry();
  ridgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(ridgePositions, 3));
  const ridgeObject = new THREE.LineSegments(
    ridgeGeometry,
    new THREE.LineBasicMaterial({ color: 0xf28c48 })
  );

  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edgePositions, 3));
  const edgeObject = new THREE.LineSegments(
    edgeGeometry,
    new THREE.LineBasicMaterial({ color: 0x314052, transparent: true, opacity: 0.78 })
  );

  const surfaceGeometry = new THREE.BufferGeometry();
  surfaceGeometry.setAttribute("position", new THREE.Float32BufferAttribute(surfacePositions, 3));
  surfaceGeometry.computeVertexNormals();
  const surfaceObject = new THREE.Mesh(
    surfaceGeometry,
    new THREE.MeshStandardMaterial({
      color: 0x6f6456,
      roughness: 0.9,
      metalness: 0.03,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1
    })
  );

  return {
    ridgeObject,
    edgeObject,
    surfaceObject,
    chimneyObject: chimneyData.chimneyGroup,
    chimneyCount: chimneyData.chimneyCount,
    triangleCount: surfacePositions.length / 9,
    wallTriangleCount
  };
}

function frameModel(root) {
  const bounds = new THREE.Box3().setFromObject(root);
  if (bounds.isEmpty()) {
    return;
  }

  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const distance = Math.max(sphere.radius * 2.3, 34);

  camera.position.set(
    sphere.center.x + distance,
    sphere.center.y - distance,
    sphere.center.z + distance * 0.88
  );
  controls.target.copy(sphere.center);
  controls.update();

  axes.position.copy(sphere.center);
  grid.scale.setScalar(Math.max(0.7, (sphere.radius * 3.4) / 140));
}

function resize() {
  const width = app.clientWidth;
  const height = app.clientHeight;
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

function rebuildModel({ refit = false } = {}) {
  const startedAt = performance.now();
  updateControlOutputs();

  const params = readParams();
  const segments = generateRidgeSegments(params);
  const geometry = buildRoofGeometry(segments, params);

  clearGroup(ridgeGroup);
  clearGroup(surfaceGroup);

  ridgeGroup.add(geometry.edgeObject, geometry.ridgeObject);
  surfaceGroup.add(geometry.surfaceObject, geometry.chimneyObject);
  ridgeGroup.visible = ridgeToggle.checked;
  surfaceGroup.visible = surfacesToggle.checked;

  if (refit || !hasFramed) {
    frameModel(modelRoot);
    hasFramed = true;
  }

  const elapsed = performance.now() - startedAt;
  setStatus(`Seed ${params.seed}`);
  statsNode.textContent = `${segments.length} ridge segments | ${Math.round(
    geometry.triangleCount
  )} surface triangles (${geometry.wallTriangleCount} wall) | ${geometry.chimneyCount} chimneys | ${elapsed.toFixed(2)} ms`;
}

function scheduleRebuild(refit = false) {
  pendingRefit = pendingRefit || refit;
  if (pendingHandle) {
    return;
  }

  pendingHandle = requestAnimationFrame(() => {
    pendingHandle = 0;
    const shouldRefit = pendingRefit;
    pendingRefit = false;
    rebuildModel({ refit: shouldRefit });
  });
}

function randomizeSeed({ rebuild = true, refit = true } = {}) {
  seedInput.value = `${randomSeed()}`;
  if (rebuild) {
    scheduleRebuild(refit);
  }
}

function downloadCurrentForm() {
  const hasMesh = surfaceGroup.children.some((child) => child.isMesh);
  if (!hasMesh) {
    setStatus("Nothing to download");
    return;
  }

  const exporter = new OBJExporter();
  const obj = exporter.parse(surfaceGroup);
  const blob = new Blob([obj], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `roof-form-seed-${sanitizeSeed(seedInput.value)}.obj`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setStatus(`Downloaded OBJ for seed ${sanitizeSeed(seedInput.value)}`);
}

async function runSampleBurst() {
  if (burstRunning) {
    return;
  }

  burstRunning = true;
  sampleBurstButton.disabled = true;
  setStatus("Sampling...");

  for (let i = 0; i < 12; i += 1) {
    randomizeSeed({ rebuild: false });
    rebuildModel({ refit: i === 0 });
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  sampleBurstButton.disabled = false;
  burstRunning = false;
}

for (const control of rangeControls) {
  control.input.addEventListener("input", () => scheduleRebuild(false));
}

seedInput.addEventListener("change", () => {
  seedInput.value = `${sanitizeSeed(seedInput.value)}`;
  scheduleRebuild(true);
});

randomizeButton.addEventListener("click", () => randomizeSeed({ rebuild: true, refit: true }));
regenerateButton.addEventListener("click", () => scheduleRebuild(true));
sampleBurstButton.addEventListener("click", () => {
  runSampleBurst().catch((error) => {
    console.error(error);
    setStatus(`Sampling failed: ${error.message}`);
    sampleBurstButton.disabled = false;
    burstRunning = false;
  });
});

downloadFormButton.addEventListener("click", () => {
  try {
    downloadCurrentForm();
  } catch (error) {
    console.error(error);
    setStatus(`Download failed: ${error.message}`);
  }
});

ridgeToggle.addEventListener("change", () => {
  ridgeGroup.visible = ridgeToggle.checked;
});

surfacesToggle.addEventListener("change", () => {
  surfaceGroup.visible = surfacesToggle.checked;
});

window.addEventListener("resize", resize);
window.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    randomizeSeed({ rebuild: true, refit: true });
  }
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

resize();
updateControlOutputs();
rebuildModel({ refit: true });
