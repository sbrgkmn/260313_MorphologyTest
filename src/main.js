import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const app = document.querySelector(".app");
const canvas = document.querySelector("#scene");
const statusNode = document.querySelector("#status");
const statsNode = document.querySelector("#stats");

const seedInput = document.querySelector("#seed");
const randomizeButton = document.querySelector("#randomize");
const regenerateButton = document.querySelector("#regenerate");
const sampleBurstButton = document.querySelector("#sample-burst");

const ridgeToggle = document.querySelector("#toggle-ridges");
const surfacesToggle = document.querySelector("#toggle-surfaces");

const rangeControls = [
  { id: "max-depth", outputId: "max-depth-value", format: (v) => `${Math.round(v)}` },
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
scene.fog = new THREE.Fog(0xe9edf2, 260, 1300);

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
    trunkLength: Number(document.querySelector("#trunk-length").value),
    lengthDecay: Number(document.querySelector("#length-decay").value),
    branchChance: Number(document.querySelector("#branch-chance").value),
    splitAngleDeg: Number(document.querySelector("#split-angle").value),
    jitterDeg: Number(document.querySelector("#jitter").value),
    ridgeHeight: Number(document.querySelector("#ridge-height").value),
    heightDecay: Number(document.querySelector("#height-decay").value),
    roofWidth: Number(document.querySelector("#roof-width").value),
    widthDecay: Number(document.querySelector("#width-decay").value),
    doubleBranchChance: 0.42,
    eaveHeight: 0,
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
  const axisDir = new THREE.Vector2(1, 0);
  const jitterInfluence = clamp(params.jitterDeg / 130, 0, 0.24);
  const queue = [
    {
      start: new THREE.Vector3(-params.trunkLength * 0.55, 0, params.ridgeHeight),
      dir: axisDir.clone(),
      depth: 0,
      length: params.trunkLength,
      width: params.roofWidth,
      height: params.ridgeHeight,
      parentIndex: -1,
      isPrimary: true
    }
  ];
  const segments = [];

  while (queue.length > 0 && segments.length < params.maxSegments) {
    const state = queue.shift();
    const dir = state.dir.clone().normalize();

    if (
      state.length < params.minLength ||
      state.width < params.minWidth ||
      state.height <= params.minHeight
    ) {
      continue;
    }

    if (dir.dot(axisDir) < -PLANAR_EPSILON) {
      continue;
    }

    const lengthScale = 1 + randomRange(rng, -jitterInfluence, jitterInfluence * 0.8);
    const segmentLength = state.length * Math.max(0.35, lengthScale);
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

    const segmentIndex = segments.length;
    segments.push({
      start: state.start.clone(),
      end: end.clone(),
      width: state.width,
      depth: state.depth,
      isPrimary: state.isPrimary
    });

    if (state.depth >= params.maxDepth) {
      continue;
    }

    const nextDepth = state.depth + 1;
    const baseLength = state.length * params.lengthDecay;
    const baseWidth = state.width * params.widthDecay;

    const shouldContinue = state.isPrimary || rng() >= 0.17;
    if (shouldContinue) {
      queue.push({
        start: end.clone(),
        dir: dir.clone(),
        depth: nextDepth,
        length: baseLength * randomRange(rng, 0.88, 1.12),
        width: baseWidth * randomRange(rng, 0.9, 1.06),
        height: endHeight * randomRange(rng, 0.93, 1.04),
        parentIndex: segmentIndex,
        isPrimary: state.isPrimary
      });
    }

    if (state.isPrimary) {
      const branchRoll = rng();
      let sideBranchCount = 0;
      if (branchRoll < params.branchChance * params.doubleBranchChance) {
        sideBranchCount = 2;
      } else if (branchRoll < params.branchChance) {
        sideBranchCount = 1;
      }

      if (sideBranchCount > 0) {
        const firstSide = rng() < 0.5 ? -1 : 1;
        for (let i = 0; i < sideBranchCount; i += 1) {
          const side = i === 0 ? firstSide : -firstSide;
          const sideDirection = rotateVec2(dir, side * Math.PI * 0.5).normalize();
          queue.push({
            start: end.clone(),
            dir: sideDirection,
            depth: nextDepth,
            length: baseLength * randomRange(rng, 0.58, 0.92),
            width: baseWidth * randomRange(rng, 0.76, 1),
            height: endHeight * randomRange(rng, 0.86, 0.99),
            parentIndex: segmentIndex,
            isPrimary: false
          });
        }
      }
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
    if (node.incident.length === 1) {
      const endpoint = endpoints[node.incident[0]];
      const left = planarToEave(endpoint.leftPoint ?? endpoint.leftOrigin, params.eaveHeight);
      const right = planarToEave(endpoint.rightPoint ?? endpoint.rightOrigin, params.eaveHeight);
      pushTriangle(surfacePositions, nodeTop, left, right);
      pushSegment(edgePositions, left, right);
      continue;
    }

    const ringPlanar = [];
    for (const endpointId of node.incident) {
      const endpoint = endpoints[endpointId];
      ringPlanar.push(endpoint.leftPoint ?? endpoint.leftOrigin);
      ringPlanar.push(endpoint.rightPoint ?? endpoint.rightOrigin);
    }

    const uniqueRing = dedupePlanarPoints(ringPlanar, 1e-4).sort(
      (a, b) =>
        Math.atan2(a.y - node.planar.y, a.x - node.planar.x) -
        Math.atan2(b.y - node.planar.y, b.x - node.planar.x)
    );

    if (uniqueRing.length < 3) {
      continue;
    }

    for (let i = 0; i < uniqueRing.length; i += 1) {
      const current = planarToEave(uniqueRing[i], params.eaveHeight);
      const next = planarToEave(uniqueRing[(i + 1) % uniqueRing.length], params.eaveHeight);
      pushTriangle(surfacePositions, nodeTop, current, next);
      pushSegment(edgePositions, current, next);
    }
  }

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
      color: 0x87b9ff,
      roughness: 0.68,
      metalness: 0.05,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.8
    })
  );

  return {
    ridgeObject,
    edgeObject,
    surfaceObject,
    triangleCount: surfacePositions.length / 9
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
  surfaceGroup.add(geometry.surfaceObject);
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
  )} roof triangles | ${elapsed.toFixed(2)} ms`;
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
