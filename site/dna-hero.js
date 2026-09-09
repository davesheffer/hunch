import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.module.min.js";

const canvas = document.getElementById("holdline");
const hero = document.querySelector("header.hero");
const ctaCanvas = document.getElementById("cta-dna");
const ctaSection = document.querySelector("section.cta");

if (canvas && hero) {
  try {
    initParticleDna();
  } catch (error) {
    canvas.removeAttribute("data-dna-ready");
    console.warn("Hunch DNA renderer fell back to canvas.", error);
  }
}

function initParticleDna() {
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarsePointer = matchMedia("(pointer: coarse)").matches;
  const rtl = document.documentElement.dir === "rtl";
  const rows = coarsePointer ? 124 : 220;
  const columns = coarsePointer ? 54 : 96;
  const strandColumns = columns / 2;
  const pointCount = rows * columns;
  const sheetHalfHeight = coarsePointer ? 5.35 : 5.65;
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  const range = (from, to, value) => {
    const unit = clamp((value - from) / (to - from));
    return unit * unit * (3 - 2 * unit);
  };

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: !coarsePointer,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  canvas.dataset.dnaReady = "true";
  document.documentElement.classList.add("dna-webgl");

  const ctaRenderer = ctaCanvas && ctaSection
    ? new THREE.WebGLRenderer({
      canvas: ctaCanvas,
      alpha: true,
      antialias: !coarsePointer,
      powerPreference: "high-performance",
    })
    : null;
  if (ctaRenderer) {
    ctaRenderer.setClearColor(0x000000, 0);
    ctaRenderer.outputColorSpace = THREE.SRGBColorSpace;
    ctaRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    ctaRenderer.toneMappingExposure = 1.05;
    ctaCanvas.dataset.dnaReady = "true";
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 70);
  camera.position.set(0, 0, 11.15);
  const ctaScene = ctaRenderer ? new THREE.Scene() : null;
  const ctaCamera = ctaRenderer ? new THREE.PerspectiveCamera(35, 1, 0.1, 70) : null;
  if (ctaCamera) ctaCamera.position.set(0, 0, 11.4);

  const dotTexture = makeDotTexture();
  const sculpture = new THREE.Group();
  scene.add(sculpture);

  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(pointCount * 3);
  const colors = new Float32Array(pointCount * 3);
  const surfaceNormals = new Float32Array(pointCount * 3);
  const grain = Float32Array.from({ length: pointCount }, (_, index) => seeded(index, 47));
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("aSurfaceNormal", new THREE.BufferAttribute(surfaceNormals, 3));
  geometry.setAttribute("aGrain", new THREE.BufferAttribute(grain, 1));

  const coordinates = Array.from({ length: pointCount }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const ringAngle = column % strandColumns / (strandColumns - 1) * Math.PI * 2;
    return {
      u: column / (columns - 1) * 2 - 1,
      v: row / (rows - 1) * 2 - 1,
      seed: seeded(index, 11),
      strand: column < strandColumns ? 0 : 1,
      ringCos: Math.cos(ringAngle),
      ringSin: Math.sin(ringAngle),
    };
  });
  const backboneFrames = Array.from({ length: rows * 2 }, () => ({
    center: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    binormal: new THREE.Vector3(),
  }));
  const backboneTangent = new THREE.Vector3();
  const basePairs = makeBasePairs();
  sculpture.add(basePairs.particles);
  const scatterUniforms = {
    pointer: { value: new THREE.Vector2(2, 2) },
    amount: { value: 0 },
    time: { value: 0 },
  };

  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: coarsePointer ? 0.044 : 0.035,
      map: dotTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.96,
      alphaTest: 0.28,
      depthWrite: true,
      sizeAttenuation: true,
    }),
  );
  points.renderOrder = 2;
  addPointerScatter(points.material, 1);
  addSurfaceLighting(points.material);
  sculpture.add(points);

  const softLayer = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: coarsePointer ? 0.082 : 0.064,
      map: dotTexture,
      color: 0x5f9f80,
      transparent: true,
      opacity: 0.055,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  softLayer.renderOrder = 1;
  addPointerScatter(softLayer.material, 0.58);
  sculpture.add(softLayer);

  const surroundings = makeDeepSpaceParticles();
  scene.add(surroundings.group);

  const farColor = new THREE.Color(0x9cc9b1);
  const midColor = new THREE.Color(0x518c6d);
  const nearColor = new THREE.Color(0x164d34);
  const locusColor = new THREE.Color(0x0c3f2c);
  const mappedColor = new THREE.Color(0x2a9765);
  const quietColor = new THREE.Color(0xcfe2d8);
  const memoryColor = new THREE.Color(0x0d563a);
  const geneLoci = [
    { center: -0.84, span: 0.052, phase: 1 },
    { center: -0.65, span: 0.036, phase: 3 },
    { center: -0.39, span: 0.068, phase: 0 },
    { center: -0.13, span: 0.042, phase: 4 },
    { center: 0.08, span: 0.03, phase: 2 },
    { center: 0.32, span: 0.072, phase: 5 },
    { center: 0.58, span: 0.044, phase: 1 },
    { center: 0.79, span: 0.058, phase: 3 },
  ];
  const mappedSamples = [];
  // Gene membership never changes as the sculpture turns. Compute it once so
  // animation spends its frame budget on movement and lighting.
  coordinates.forEach((coordinate, sourceIndex) => {
    const { u, v } = coordinate;
    coordinate.locusWeight = 0;
    coordinate.pairedWeight = 0;
    coordinate.locusTone = 0;
    let mapped = false;
    for (let locusIndex = 0; locusIndex < geneLoci.length; locusIndex += 1) {
      const locus = geneLoci[locusIndex];
      const broadBand = Math.exp(-Math.pow((v - locus.center) / locus.span, 6));
      const pairOffset = locus.span * 0.4;
      const pairWidth = Math.max(0.012, locus.span * 0.24);
      const pairA = Math.exp(-Math.pow((v - locus.center - pairOffset) / pairWidth, 2));
      const pairB = Math.exp(-Math.pow((v - locus.center + pairOffset) / pairWidth, 2));
      const lane = (Math.floor((u + 1) * 15 + locus.phase) % 5) < 3;
      const pairedBand = Math.max(pairA, pairB);
      if (broadBand > coordinate.locusWeight) {
        coordinate.locusWeight = broadBand;
        coordinate.locusTone = locusIndex % 2;
      }
      coordinate.pairedWeight = Math.max(coordinate.pairedWeight, pairedBand * (lane ? 1 : 0.16));
      if (!mapped && pairedBand > 0.26 && lane) {
        mappedSamples.push({ sourceIndex, tone: locusIndex % 2, locusIndex });
        mapped = true;
      }
    }
  });
  const mappedPositions = new Float32Array(mappedSamples.length * 3);
  const mappedColors = new Float32Array(mappedSamples.length * 3);
  const mappedNormals = new Float32Array(mappedSamples.length * 3);
  mappedSamples.forEach((sample, index) => {
    const mappedTone = sample.tone ? mappedColor : locusColor;
    mappedColors[index * 3] = mappedTone.r;
    mappedColors[index * 3 + 1] = mappedTone.g;
    mappedColors[index * 3 + 2] = mappedTone.b;
  });
  const mappedGeometry = new THREE.BufferGeometry();
  mappedGeometry.setAttribute("position", new THREE.BufferAttribute(mappedPositions, 3));
  mappedGeometry.setAttribute("color", new THREE.BufferAttribute(mappedColors, 3));
  mappedGeometry.setAttribute("aSurfaceNormal", new THREE.BufferAttribute(mappedNormals, 3));
  mappedGeometry.setAttribute("aGrain", new THREE.BufferAttribute(
    Float32Array.from(mappedSamples, ({ sourceIndex }) => grain[sourceIndex]), 1,
  ));
  const mappedLoci = new THREE.Points(
    mappedGeometry,
    new THREE.PointsMaterial({
      size: coarsePointer ? 0.036 : 0.027,
      map: dotTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      alphaTest: 0.07,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  mappedLoci.renderOrder = 3;
  addPointerScatter(mappedLoci.material, 0.78);
  addSurfaceLighting(mappedLoci.material);
  sculpture.add(mappedLoci);
  const thoughtCount = coarsePointer ? 72 : 120;
  const thoughtPulseOffsets = [0, 0.31, 0.63];
  const thoughtHeadSize = coarsePointer ? 0.09 : 0.07;
  const thoughtHaloSize = coarsePointer ? 0.2 : 0.17;
  const thoughtSamples = Array.from({ length: thoughtCount }, (_, index) => {
    const t = index / (thoughtCount - 1);
    const row = Math.round(t * (rows - 1));
    const v = row / (rows - 1) * 2 - 1;
    const laneU = 0.48 + Math.sin(v * 4.8 + 1.1) * 0.13 + Math.sin(v * 11.2) * 0.025;
    const column = Math.round(clamp((laneU + 1) * 0.5) * (columns - 1));
    return { sourceIndex: row * columns + column, t, v };
  });
  const thoughtPositions = new Float32Array(thoughtCount * 3);
  const thoughtColors = new Float32Array(thoughtCount * 3);
  const thoughtGeometry = new THREE.BufferGeometry();
  thoughtGeometry.setAttribute("position", new THREE.BufferAttribute(thoughtPositions, 3));
  thoughtGeometry.setAttribute("color", new THREE.BufferAttribute(thoughtColors, 3));
  const thoughtTrace = new THREE.Points(
    thoughtGeometry,
    new THREE.PointsMaterial({
      size: coarsePointer ? 0.045 : 0.034,
      map: dotTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      alphaTest: 0.06,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  thoughtTrace.renderOrder = 4;
  addPointerScatter(thoughtTrace.material, 0.52);
  sculpture.add(thoughtTrace);
  const thoughtHeadGeometry = new THREE.BufferGeometry();
  const thoughtHeadPosition = new Float32Array(thoughtPulseOffsets.length * 3);
  thoughtHeadGeometry.setAttribute("position", new THREE.BufferAttribute(thoughtHeadPosition, 3));
  const thoughtHalo = new THREE.Points(
    thoughtHeadGeometry,
    new THREE.PointsMaterial({
      size: thoughtHaloSize,
      map: dotTexture,
      color: 0x2a9765,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  thoughtHalo.renderOrder = 5;
  sculpture.add(thoughtHalo);
  const thoughtHead = new THREE.Points(
    thoughtHeadGeometry,
    new THREE.PointsMaterial({
      size: thoughtHeadSize,
      map: dotTexture,
      color: 0x0d563a,
      transparent: true,
      opacity: 0.96,
      alphaTest: 0.05,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  thoughtHead.renderOrder = 6;
  sculpture.add(thoughtHead);

  const ctaSculpture = ctaScene ? new THREE.Group() : null;
  const ctaSurroundings = ctaScene ? surroundings.group.clone(true) : null;
  if (ctaSculpture) {
    ctaSculpture.add(new THREE.Points(basePairs.particles.geometry, basePairs.particles.material));
    for (const source of [points, softLayer, mappedLoci, thoughtTrace, thoughtHalo, thoughtHead]) {
      const layer = new THREE.Points(source.geometry, source.material);
      layer.renderOrder = source.renderOrder;
      ctaSculpture.add(layer);
    }
    ctaScene.add(ctaSculpture, ctaSurroundings);
  }
  const color = new THREE.Color();
  const mappedPulseColor = new THREE.Color(0x42bd80);
  const mappedBaseColor = new THREE.Color();
  const thoughtColor = new THREE.Color();
  const thoughtRestColor = new THREE.Color(0xc7ddd2);
  const pointer = new THREE.Vector2();
  const pointerTarget = new THREE.Vector2();
  const scatterPointer = new THREE.Vector2(2, 2);
  let compact = false;
  let ctaCompact = false;
  let baseScale = 1.24;
  let baseX = 1.57;
  let baseY = -2.38;
  let baseZ = 1.54;
  let scrollTarget = 0;
  let scrollProgress = 0;
  let scatterEnergy = 0;
  let scatterImpulse = 0;
  let heroVisible = true;
  let ctaVisible = false;
  let active = true;
  let frameHandle = 0;
  const codeSignals = makeCodeSignals();

  function makeCodeSignals() {
    const layer = document.createElement("div");
    layer.className = "hero-signals";
    layer.setAttribute("aria-hidden", "true");
    const signalCanvas = document.createElement("canvas");
    layer.append(signalCanvas);
    hero.append(layer);
    const context = signalCanvas.getContext("2d");
    const projected = new THREE.Vector3();
    const mono = '"IBM Plex Mono", monospace';
    // Small examples of the kinds of engineering memory carried by a strand.
    const memories = [
      { kind: "DECISION", code: 'sourceOfTruth = "git"', path: "src/store/hunchStore.ts" },
      { kind: "FINDING", code: "packagePaths.checked", path: "test/package-paths.test.ts" },
      { kind: "CONSTRAINT", code: "writes.mustBeAtomic", path: "src/core/io.ts" },
    ];
    const code = ["0101", "ctx", "{ }", "1010", "src", "=>", "0011", "git", "fn", "1100", "[ ]", "AI"];
    let width = 1;
    let height = 1;
    let bounds = [];
    let tags = [];
    let lastDraw = -Infinity;
    let lastLayout = -Infinity;

    function measure() {
      const rect = signalCanvas.getBoundingClientRect();
      bounds = [...hero.querySelectorAll("h1, .lede, .hero-cta .btn")].map((element) => {
        const box = element.getBoundingClientRect();
        return { x: box.left - rect.left - 16, y: box.top - rect.top - 16,
          w: box.width + 32, h: box.height + 32 };
      });
      const tagWidth = Math.min(222, width - 48);
      const tagHeight = 72;
      const mirror = (x) => rtl ? width - x - tagWidth : x;
      const clear = (box) => box.y >= 72 && box.y + box.h <= height - 16
        && ![...bounds, ...tags].some((other) => box.x < other.x + other.w + 8
          && box.x + box.w > other.x - 8 && box.y < other.y + other.h + 12
          && box.y + box.h > other.y - 12);
      tags = [];
      const candidates = [
        [width - tagWidth - 34, Math.max(82, height * 0.15)],
        [width - tagWidth - 56, height - tagHeight - 34],
        [width - tagWidth - 24, height * 0.48],
        [width * 0.48, 82],
        [width - tagWidth - 24, height * 0.7],
      ];
      for (const [x, y] of candidates) {
        const box = { x: mirror(Math.max(24, Math.min(width - tagWidth - 24, x))), y,
          w: tagWidth, h: tagHeight };
        if (clear(box)) tags.push(box);
        if (tags.length === (width < 760 ? 2 : 3)) break;
      }
      signalCanvas.dataset.memoryTags = String(tags.length);
    }

    function drawMatrix(time) {
      context.font = `10px ${mono}`;
      const streamCount = width < 720 ? 10 : 17;
      for (let stream = 0; stream < streamCount; stream += 1) {
        const x = width * (0.49 + seeded(stream, 104) * 0.48);
        const head = (time * (0.012 + seeded(stream, 108) * 0.012)
          + seeded(stream, 111) * (height + 280)) % (height + 280) - 80;
        for (let index = 0; index < 12; index += 1) {
          const y = head - index * 17;
          if (y < 70 || y > height - 12) continue;
          const fade = (1 - index / 12) * Math.min(1, (y - 70) / 65, (height - y) / 65);
          context.fillStyle = `rgba(40,112,74,${fade * (index === 0 ? 0.58 : 0.3)})`;
          const character = Math.floor(time / 1800 + stream * 3 + index * 7) % code.length;
          context.fillText(code[character], rtl ? width - x : x, y);
        }
      }
    }

    function drawMemory(tag, index, time) {
      const y = tag.y + (reduceMotion ? 0 : Math.sin(time * 0.00045 + index * 2) * 3);
      const centerX = tag.x + tag.w / 2;
      const centerY = y + tag.h / 2;
      let anchor = null;
      let best = Infinity;
      // Project the actual moving backbone, so every leader stays attached.
      for (let row = 0; row < rows; row += 3) {
        for (let strand = 0; strand < 2; strand += 1) {
          projected.copy(backboneFrames[row * 2 + strand].center)
            .applyMatrix4(sculpture.matrixWorld).project(camera);
          const x = (projected.x * 0.5 + 0.5) * width;
          const py = (0.5 - projected.y * 0.5) * height;
          if (x < 20 || x > width - 20 || py < 75 || py > height - 20) continue;
          if (x > tag.x - 28 && x < tag.x + tag.w + 28 && py > y - 28 && py < y + tag.h + 28) continue;
          if (bounds.some((box) => x > box.x && x < box.x + box.w && py > box.y && py < box.y + box.h)) continue;
          const distance = Math.abs(x - centerX) * 0.65 + Math.abs(py - centerY);
          if (distance < best) { best = distance; anchor = { x, y: py }; }
        }
      }
      if (!anchor) return;
      const aboveOrBelow = anchor.x > tag.x && anchor.x < tag.x + tag.w;
      const edgeX = aboveOrBelow ? Math.max(tag.x + 22, Math.min(tag.x + tag.w - 22, anchor.x))
        : anchor.x < centerX ? tag.x : tag.x + tag.w;
      const edgeY = aboveOrBelow ? (anchor.y < centerY ? y : y + tag.h) : centerY;
      const bendX = aboveOrBelow ? edgeX : edgeX + (anchor.x < centerX ? -22 : 22);
      const bendY = aboveOrBelow ? edgeY + (anchor.y < centerY ? -18 : 18) : edgeY;
      context.lineWidth = 0.8;
      context.strokeStyle = "rgba(49,116,79,.42)";
      context.beginPath();
      context.moveTo(anchor.x, anchor.y);
      context.lineTo(bendX, bendY);
      context.lineTo(edgeX, edgeY);
      context.stroke();
      context.fillStyle = "#397b55";
      context.beginPath();
      context.arc(anchor.x, anchor.y, 2.4, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = "rgba(63,131,88,.24)";
      context.beginPath();
      context.arc(anchor.x, anchor.y, 6, 0, Math.PI * 2);
      context.stroke();
      const progress = (time * 0.00013 + index * 0.31) % 1;
      context.fillStyle = "#56a879";
      context.beginPath();
      context.arc(THREE.MathUtils.lerp(anchor.x, bendX, progress),
        THREE.MathUtils.lerp(anchor.y, bendY, progress), 1.7, 0, Math.PI * 2);
      context.fill();

      context.shadowColor = "rgba(43,90,60,.07)";
      context.shadowBlur = 22;
      context.shadowOffsetY = 5;
      context.fillStyle = "rgba(250,253,250,.88)";
      context.beginPath();
      context.roundRect(tag.x, y, tag.w, tag.h, 7);
      context.fill();
      context.shadowColor = "transparent";
      context.strokeStyle = "rgba(82,137,103,.25)";
      context.stroke();
      context.textAlign = "left";
      const memory = memories[index];
      context.fillStyle = "#47765b";
      context.font = `9px ${mono}`;
      context.fillText(memory.kind, tag.x + 14, y + 18);
      context.fillStyle = "#91ab9a";
      context.fillText("↗", tag.x + tag.w - 22, y + 18);
      context.fillStyle = "#27573c";
      context.font = `12px ${mono}`;
      context.fillText(memory.code, tag.x + 14, y + 38);
      context.fillStyle = "#6d8776";
      context.font = `9px ${mono}`;
      context.fillText(memory.path, tag.x + 14, y + 57);
    }

    return {
      resize() {
        const rect = canvas.getBoundingClientRect();
        width = rect.width;
        height = rect.height;
        const ratio = Math.min(devicePixelRatio || 1, 1.65);
        signalCanvas.width = Math.round(width * ratio);
        signalCanvas.height = Math.round(height * ratio);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        measure();
        lastDraw = -Infinity;
      },
      draw(time) {
        if (!reduceMotion && time - lastDraw < 32) return;
        lastDraw = time;
        if (reduceMotion || time - lastLayout > 160) { measure(); lastLayout = time; }
        context.clearRect(0, 0, width, height);
        context.save();
        // Keep decorative code and connections clear of the live page copy.
        for (const box of bounds) {
          context.beginPath();
          context.rect(0, 0, width, height);
          context.roundRect(box.x, box.y, box.w, box.h, 14);
          context.clip("evenodd");
        }
        drawMatrix(time);
        tags.forEach((tag, index) => drawMemory(tag, index, time));
        context.restore();
      },
      dispose() { layer.remove(); },
    };
  }

  function makeDotTexture() {
    const textureCanvas = document.createElement("canvas");
    textureCanvas.width = 48;
    textureCanvas.height = 48;
    const context = textureCanvas.getContext("2d");
    const gradient = context.createRadialGradient(24, 24, 1, 24, 24, 22);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.6, "rgba(255,255,255,.98)");
    gradient.addColorStop(0.78, "rgba(255,255,255,.58)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 48, 48);
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function seeded(index, salt = 0) {
    const value = Math.sin(index * 91.733 + salt * 37.719) * 43758.5453;
    return value - Math.floor(value);
  }

  function sampleBackbone(v, strand, time, rotation, frame) {
    const sway = v * 2.3 + time * 0.0002;
    const twist = v * 3.1 + time * 0.0003;
    const angle = -v * Math.PI * 2.1 + rotation + strand * Math.PI + Math.sin(twist) * 0.055;
    const angularSlope = -Math.PI * 2.1 + Math.cos(twist) * 0.1705;
    const radius = 1.38;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    frame.center.set(radius * c + Math.sin(sway) * 0.18, v * sheetHalfHeight,
      radius * s + Math.cos(sway) * 0.1);
    backboneTangent.set(-radius * s * angularSlope + Math.cos(sway) * 0.414,
      sheetHalfHeight, radius * c * angularSlope - Math.sin(sway) * 0.23).normalize();
    frame.normal.set(c, 0, s);
    frame.normal.addScaledVector(backboneTangent, -frame.normal.dot(backboneTangent)).normalize();
    frame.binormal.crossVectors(backboneTangent, frame.normal).normalize();
  }

  function makeBasePairs() {
    const count = 23;
    const samples = coarsePointer ? 38 : 64;
    const filaments = 3;
    const pairPositions = new Float32Array(count * samples * filaments * 3);
    const pairGeometry = new THREE.BufferGeometry();
    pairGeometry.setAttribute("position", new THREE.BufferAttribute(pairPositions, 3));
    const particles = new THREE.Points(pairGeometry, new THREE.PointsMaterial({
      color: 0x5b9375, map: dotTexture,
      size: coarsePointer ? 0.028 : 0.021,
      transparent: true, opacity: 0.48, depthWrite: false, sizeAttenuation: true,
    }));
    return {
      particles,
      update(time) {
        for (let pair = 0; pair < count; pair += 1) {
          const row = Math.round((pair + 0.5) / count * (rows - 1));
          const start = backboneFrames[row * 2].center;
          const end = backboneFrames[row * 2 + 1].center;
          const bow = 0.07 + Math.sin(pair * 1.7 + time * 0.0003) * 0.018;
          for (let sample = 0; sample < samples; sample += 1) {
            const t = (sample + 0.5) / samples;
            for (let filament = 0; filament < filaments; filament += 1) {
              const index = (pair * samples + sample) * filaments + filament;
              const offset = index * 3;
              const spread = (seeded(index, 71) - 0.5) * 0.028;
              pairPositions[offset] = THREE.MathUtils.lerp(start.x, end.x, t) + spread;
              pairPositions[offset + 1] = start.y + Math.sin(t * Math.PI) * bow
                + (filament - 1) * 0.022 + spread;
              pairPositions[offset + 2] = THREE.MathUtils.lerp(start.z, end.z, t) - spread;
            }
          }
        }
        pairGeometry.attributes.position.needsUpdate = true;
      },
    };
  }

  function sampleThoughtPulse(flow, target, targetOffset) {
    const scaled = clamp(flow) * (thoughtCount - 1);
    const index1 = Math.floor(scaled);
    const index0 = Math.max(0, index1 - 1);
    const index2 = Math.min(thoughtCount - 1, index1 + 1);
    const index3 = Math.min(thoughtCount - 1, index1 + 2);
    const t = scaled - index1;
    const t2 = t * t;
    const t3 = t2 * t;
    const sources = [index0, index1, index2, index3]
      .map((index) => thoughtSamples[index].sourceIndex * 3);

    for (let axis = 0; axis < 3; axis += 1) {
      const p0 = positions[sources[0] + axis];
      const p1 = positions[sources[1] + axis];
      const p2 = positions[sources[2] + axis];
      const p3 = positions[sources[3] + axis];
      target[targetOffset + axis] = 0.5 * (
        2 * p1
        + (-p0 + p2) * t
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
        + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
      );
    }
  }

  function addPointerScatter(material, layerStrength) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uScatterPointer = scatterUniforms.pointer;
      shader.uniforms.uScatterAmount = scatterUniforms.amount;
      shader.uniforms.uScatterTime = scatterUniforms.time;
      shader.uniforms.uScatterLayer = { value: layerStrength };
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
uniform vec2 uScatterPointer;
uniform float uScatterAmount;
uniform float uScatterTime;
uniform float uScatterLayer;`,
        )
        .replace(
          "#include <project_vertex>",
          `#include <project_vertex>
vec2 scatterNdc = gl_Position.xy / max(gl_Position.w, 0.0001);
vec2 scatterDelta = scatterNdc - uScatterPointer;
float scatterDistance = length(scatterDelta);
float scatterInfluence = 1.0 - smoothstep(0.0, 0.26, scatterDistance);
scatterInfluence *= scatterInfluence;
float scatterSeed = fract(sin(dot(position.xy + position.yz, vec2(12.9898, 78.233))) * 43758.5453);
float scatterWave = 0.72 + sin(uScatterTime * 0.003 + scatterSeed * 6.28318) * 0.28;
vec2 scatterRadial = scatterDistance > 0.0001 ? scatterDelta / scatterDistance : vec2(1.0, 0.0);
vec2 scatterTangent = vec2(-scatterRadial.y, scatterRadial.x) * (scatterSeed - 0.5) * 1.6;
vec2 scatterDirection = normalize(scatterRadial + scatterTangent);
gl_Position.xy += scatterDirection * scatterInfluence * scatterWave * uScatterAmount * uScatterLayer * gl_Position.w;`,
        )
        .replace(
          "gl_PointSize = size;",
          "gl_PointSize = size * (1.0 + scatterInfluence * min(uScatterAmount * 8.0, 0.22));",
        );
    };
    material.customProgramCacheKey = () => `hunch-pointer-scatter-${layerStrength}`;
  }

  function addSurfaceLighting(material) {
    const applyScatter = material.onBeforeCompile;
    const scatterCacheKey = material.customProgramCacheKey();
    material.onBeforeCompile = (shader) => {
      applyScatter(shader);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
attribute vec3 aSurfaceNormal;
attribute float aGrain;
varying vec3 vSurfaceNormal;
varying float vGrain;
varying float vViewDepth;`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>
vSurfaceNormal = normalize(normalMatrix * aSurfaceNormal);
vGrain = aGrain;`)
        .replace("#include <logdepthbuf_vertex>", `
vViewDepth = -mvPosition.z;
// A small circle of confusion softens the far fold without a postprocess pass.
float defocus = smoothstep(8.0, 16.0, vViewDepth);
gl_PointSize *= mix(0.86, 1.14, aGrain) * (1.0 + defocus * 0.38);
#include <logdepthbuf_vertex>`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
varying vec3 vSurfaceNormal;
varying float vGrain;
varying float vViewDepth;`)
        .replace("#include <alphatest_fragment>", `
diffuseColor.a *= mix(1.0, 0.64, smoothstep(8.0, 16.0, vViewDepth));
#include <alphatest_fragment>`)
        .replace("#include <opaque_fragment>", `
// Rounded strand normals give each grain depth without a solid surface.
vec3 sheetNormal = normalize(vSurfaceNormal);
sheetNormal *= sheetNormal.z < 0.0 ? -1.0 : 1.0;
vec2 grainUv = gl_PointCoord * 2.0 - 1.0;
vec3 grainNormal = normalize(vec3(grainUv.x, -grainUv.y,
  sqrt(max(0.001, 1.0 - dot(grainUv, grainUv)))));
vec3 lightDirection = normalize(vec3(-0.55, 0.8, 0.95));
vec3 halfDirection = normalize(lightDirection + vec3(0.0, 0.0, 1.0));
float diffuseLight = max(0.0, dot(sheetNormal, lightDirection));
float edgeLight = pow(1.0 - sheetNormal.z, 3.0);
float grainShade = 0.66 + 0.34 * max(0.0, dot(grainNormal, lightDirection));
float sheen = pow(max(0.0, dot(sheetNormal, halfDirection)), 24.0) * 0.24;
float glint = pow(max(0.0, dot(grainNormal, halfDirection)), 28.0) * 0.11;
outgoingLight *= (0.48 + diffuseLight * 0.88) * grainShade * mix(0.92, 1.06, vGrain);
outgoingLight += vec3(0.68, 0.88, 0.76) * (sheen + glint + edgeLight * 0.035);
#include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => `${scatterCacheKey}-surface-lighting-v1`;
  }

  function makeDeepSpaceParticles() {
    const group = new THREE.Group();
    const timeUniform = { value: 0 };
    const count = coarsePointer ? 780 : 1380;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const layers = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      // Most particles sit far away; a few soft, larger grains pass nearby.
      const layer = index < count * 0.7 ? 0 : index < count * 0.94 ? 1 : 2;
      const spread = [34, 20, 13][layer];
      positions[index * 3] = (seeded(index, 201) - 0.5) * spread;
      positions[index * 3 + 1] = (seeded(index, 203) - 0.5) * spread * 0.8;
      positions[index * 3 + 2] = seeded(index, 207);
      seeds[index] = seeded(index, 211);
      layers[index] = layer;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute("aLayer", new THREE.BufferAttribute(layers, 1));
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: timeUniform,
        uPixelRatio: { value: Math.min(devicePixelRatio || 1, 1.65) },
      },
      vertexShader: `
uniform float uTime;
uniform float uPixelRatio;
attribute float aSeed;
attribute float aLayer;
varying float vOpacity;
varying float vSoftness;
void main() {
  float nearLayer = step(1.5, aLayer);
  float midLayer = step(0.5, aLayer) - nearLayer;
  float depthSpan = mix(18.0, 12.0, midLayer);
  depthSpan = mix(depthSpan, 7.0, nearLayer);
  float farEdge = mix(-30.0, -13.0, midLayer);
  farEdge = mix(farEdge, -2.0, nearLayer);
  float speed = 0.045 + midLayer * 0.045 + nearLayer * 0.018;
  float travel = fract(position.z + uTime * speed / depthSpan);
  vec3 point = position;
  point.z = farEdge + travel * depthSpan;
  point.x += sin(uTime * 0.075 + aSeed * 31.0) * (0.15 + aLayer * 0.09);
  point.y += cos(uTime * 0.055 + aSeed * 47.0) * (0.18 + aLayer * 0.13);
  vec4 viewPosition = modelViewMatrix * vec4(point, 1.0);
  gl_Position = projectionMatrix * viewPosition;
  float size = 1.25 + aSeed * 0.85 + midLayer * 0.8 + nearLayer * 1.5;
  gl_PointSize = clamp(size * 24.0 / -viewPosition.z, 0.85, 11.0) * uPixelRatio;
  float fade = smoothstep(0.0, 0.06, travel) * (1.0 - smoothstep(0.94, 1.0, travel));
  vOpacity = (0.52 + aSeed * 0.32 - nearLayer * 0.34) * fade;
  vSoftness = nearLayer;
}`,
      fragmentShader: `
varying float vOpacity;
varying float vSoftness;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float crisp = 1.0 - smoothstep(0.25, 0.92, r);
  float soft = exp(-r * r * 4.5) * (1.0 - smoothstep(0.8, 1.0, r));
  float alpha = mix(crisp, soft, vSoftness) * vOpacity;
  gl_FragColor = vec4(vec3(0.09, 0.2, 0.15), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    });
    const particles = new THREE.Points(geometry, material);
    // The shader spreads normalized seed depths into the full star field.
    particles.frustumCulled = false;
    particles.renderOrder = -2;
    group.add(particles);
    return {
      group,
      update(time) { timeUniform.value = time * 0.001; },
      dispose() {
        geometry.dispose();
        material.dispose();
      },
    };
  }

  function updateSculpture(time, progress) {
    const direction = rtl ? -1 : 1;
    const rotation = time * 0.00003 + direction * (0.62 + progress * 1.05);

    for (let row = 0; row < rows; row += 1) {
      const v = row / (rows - 1) * 2 - 1;
      sampleBackbone(v, 0, time, rotation, backboneFrames[row * 2]);
      sampleBackbone(v, 1, time, rotation, backboneFrames[row * 2 + 1]);
    }
    basePairs.update(time);

    for (let index = 0; index < pointCount; index += 1) {
      const { v, seed, strand, ringCos, ringSin, locusWeight, pairedWeight, locusTone } = coordinates[index];
      const frame = backboneFrames[Math.floor(index / columns) * 2 + strand];
      const radius = 0.17 * (0.78 + seed * 0.44)
        * (1 + Math.sin(v * 17 + time * 0.00032) * 0.035);
      const offset = index * 3;
      const nx = frame.normal.x * ringCos + frame.binormal.x * ringSin;
      const ny = frame.normal.y * ringCos + frame.binormal.y * ringSin;
      const nz = frame.normal.z * ringCos + frame.binormal.z * ringSin;
      positions[offset] = frame.center.x + nx * radius;
      positions[offset + 1] = frame.center.y + ny * radius + (seed - 0.5) * 0.024;
      positions[offset + 2] = frame.center.z + nz * radius;
      surfaceNormals[offset] = nx;
      surfaceNormals[offset + 1] = ny;
      surfaceNormals[offset + 2] = nz;

      const depth = clamp(frame.center.z / 2.76 + 0.5);
      color.copy(farColor).lerp(midColor, clamp(depth * 1.15));
      color.lerp(nearColor, clamp((depth - 0.48) * 1.4));

      color.lerp(quietColor, locusWeight * 0.26);
      color.lerp(locusTone ? mappedColor : locusColor, pairedWeight * 0.62);
      color.offsetHSL(0, 0, (seed - 0.5) * 0.035);
      colors[offset] = color.r;
      colors[offset + 1] = color.g;
      colors[offset + 2] = color.b;
    }

    const thoughtFlow = (time * 0.00004 + progress * 0.08) % 1;
    const pulseFlows = thoughtPulseOffsets.map((pulseOffset) => (thoughtFlow + pulseOffset) % 1);
    const locusActivations = geneLoci.map((locus) => {
      let activation = 0;
      for (const pulseFlow of pulseFlows) {
        const pulseV = THREE.MathUtils.lerp(-1, 1, pulseFlow);
        const distance = (pulseV - locus.center) / Math.max(0.035, locus.span * 0.72);
        activation = Math.max(activation, Math.exp(-distance * distance * 1.8));
      }
      return activation;
    });
    const decisionBeat = Math.max(...locusActivations);

    mappedSamples.forEach((sample, index) => {
      const sourceOffset = sample.sourceIndex * 3;
      const targetOffset = index * 3;
      mappedPositions[targetOffset] = positions[sourceOffset];
      mappedPositions[targetOffset + 1] = positions[sourceOffset + 1];
      mappedPositions[targetOffset + 2] = positions[sourceOffset + 2];
      mappedNormals[targetOffset] = surfaceNormals[sourceOffset];
      mappedNormals[targetOffset + 1] = surfaceNormals[sourceOffset + 1];
      mappedNormals[targetOffset + 2] = surfaceNormals[sourceOffset + 2];
      mappedBaseColor
        .copy(sample.tone ? mappedColor : locusColor)
        .lerp(mappedPulseColor, locusActivations[sample.locusIndex] * 0.96);
      mappedColors[targetOffset] = mappedBaseColor.r;
      mappedColors[targetOffset + 1] = mappedBaseColor.g;
      mappedColors[targetOffset + 2] = mappedBaseColor.b;
    });

    for (let index = 0; index < thoughtCount; index += 1) {
      const sample = thoughtSamples[index];
      const sourceOffset = sample.sourceIndex * 3;
      const offset = index * 3;
      thoughtPositions[offset] = positions[sourceOffset];
      thoughtPositions[offset + 1] = positions[sourceOffset + 1];
      thoughtPositions[offset + 2] = positions[sourceOffset + 2];

      let active = 0;
      let head = 0;
      for (const pulseFlow of pulseFlows) {
        const trail = (pulseFlow - sample.t + 1) % 1;
        const tailUnit = trail < 0.155 ? 1 - trail / 0.155 : 0;
        const pulseTail = tailUnit * tailUnit * (3 - 2 * tailUnit);
        active = Math.max(active, pulseTail);
        const headUnit = trail < 0.044 ? 1 - trail / 0.044 : 0;
        head = Math.max(head, headUnit * headUnit * (3 - 2 * headUnit));
      }
      thoughtColor.copy(thoughtRestColor).lerp(memoryColor, active);
      thoughtColor.lerp(mappedColor, head * 0.9);
      thoughtColors[offset] = thoughtColor.r;
      thoughtColors[offset + 1] = thoughtColor.g;
      thoughtColors[offset + 2] = thoughtColor.b;
    }
    pulseFlows.forEach((pulseFlow, pulseIndex) => {
      const offset = pulseIndex * 3;
      sampleThoughtPulse(pulseFlow, thoughtHeadPosition, offset);
    });
    const breath = Math.sin(time * 0.0022) * 0.5 + 0.5;
    thoughtTrace.material.opacity = 0.86 + breath * 0.08;
    thoughtHead.material.size = thoughtHeadSize * (1 + breath * 0.08 + decisionBeat * 0.28);
    thoughtHalo.material.size = thoughtHaloSize * (1 + breath * 0.12 + decisionBeat * 0.42);
    thoughtHalo.material.opacity = 0.1 + breath * 0.04 + decisionBeat * 0.13;

    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    geometry.attributes.aSurfaceNormal.needsUpdate = true;
    mappedGeometry.attributes.position.needsUpdate = true;
    mappedGeometry.attributes.color.needsUpdate = true;
    mappedGeometry.attributes.aSurfaceNormal.needsUpdate = true;
    thoughtGeometry.attributes.position.needsUpdate = true;
    thoughtGeometry.attributes.color.needsUpdate = true;
    thoughtHeadGeometry.attributes.position.needsUpdate = true;
  }

  function updateLayout() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    compact = width < 720;
    baseScale = compact ? 0.97 : 1.12;
    baseX = (rtl ? -1 : 1) * (compact ? 1.2 : 2.35);
    baseY = -0.4;
    baseZ = 1.54;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarsePointer ? 1.2 : 1.65));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.fov = compact ? 42 : 36;
    camera.updateProjectionMatrix();
    codeSignals.resize();

    if (ctaRenderer && ctaCanvas && ctaCamera) {
      const ctaRect = ctaCanvas.getBoundingClientRect();
      const ctaWidth = Math.max(1, Math.round(ctaRect.width));
      const ctaHeight = Math.max(1, Math.round(ctaRect.height));
      ctaCompact = ctaWidth < 720;
      ctaRenderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarsePointer ? 1.15 : 1.55));
      ctaRenderer.setSize(ctaWidth, ctaHeight, false);
      ctaCamera.aspect = ctaWidth / ctaHeight;
      ctaCamera.fov = ctaCompact ? 43 : 35;
      ctaCamera.updateProjectionMatrix();
    }
  }

  function readScroll() {
    const rect = hero.getBoundingClientRect();
    const travel = Math.max(1, hero.offsetHeight - innerHeight);
    scrollTarget = clamp((hero.offsetTop - rect.top) / travel);
    schedule();
  }

  function readPointer(event) {
    const nextX = (event.clientX / innerWidth - 0.5) * 2;
    const nextY = (event.clientY / innerHeight - 0.5) * -2;
    if (!coarsePointer && !reduceMotion) {
      const velocity = Math.hypot(nextX - pointerTarget.x, nextY - pointerTarget.y);
      scatterImpulse = Math.min(1, scatterImpulse + velocity * 4.8);
    }
    pointerTarget.set(nextX, nextY);
    schedule();
  }

  function settlePointer() {
    scatterImpulse = 0;
    scatterPointer.set(2, 2);
  }

  function render(time = 0) {
    scrollProgress += (scrollTarget - scrollProgress) * (reduceMotion ? 1 : 0.1);
    pointer.lerp(pointerTarget, reduceMotion ? 1 : 0.035);
    scatterPointer.lerp(pointerTarget, reduceMotion ? 1 : 0.24);
    scatterEnergy += (scatterImpulse - scatterEnergy) * 0.18;
    scatterImpulse *= 0.9;
    scatterUniforms.pointer.value.copy(scatterPointer);
    scatterUniforms.amount.value = coarsePointer || reduceMotion ? 0 : scatterEnergy * 0.034;
    scatterUniforms.time.value = time;
    const quietTime = reduceMotion ? 2200 : time;
    updateSculpture(quietTime, scrollProgress);

    const journey = range(0, 0.88, scrollProgress);
    const direction = rtl ? -1 : 1;

    points.material.opacity = 0.96;
    softLayer.material.opacity = 0.055;
    mappedLoci.material.opacity = 0.88;
    sculpture.scale.setScalar(baseScale * (1 + journey * (compact ? 0.025 : 0.055)));
    sculpture.position.x = baseX
      + direction * journey * (compact ? 0.12 : 0.25)
      + pointer.x * (compact ? 0.045 : 0.12);
    sculpture.position.y = baseY
      + journey * (compact ? 0.35 : 0.7)
      + pointer.y * 0.06;
    sculpture.position.z = baseZ + journey * (compact ? 0.08 : 0.22);
    sculpture.rotation.x = 0.08 + journey * 0.055;
    sculpture.rotation.y = pointer.x * 0.02 + direction * (0.12 + journey * 0.08);
    sculpture.rotation.z = direction * (-0.28 + journey * 0.16);
    surroundings.update(quietTime);
    surroundings.group.position.set(direction * (compact ? 1.0 : 1.8) + pointer.x * 0.06,
      journey * 0.25, -0.4);
    surroundings.group.rotation.y = pointer.x * 0.065;
    surroundings.group.rotation.x = -pointer.y * 0.04;

    if (ctaSculpture && ctaCamera) {
      const ctaBreath = Math.sin(quietTime * 0.00022) * 0.035;
      ctaSculpture.scale.setScalar((ctaCompact ? 0.82 : 0.96) + ctaBreath);
      ctaSculpture.position.set(
        direction * (ctaCompact ? 1.42 : 3.2) + pointer.x * (ctaCompact ? 0.025 : 0.08),
        (ctaCompact ? -0.34 : -0.42) + pointer.y * 0.035,
        1.22,
      );
      ctaSculpture.rotation.set(
        0.13,
        direction * 0.12 + pointer.x * 0.014,
        direction * (ctaCompact ? -0.15 : -0.1),
      );
      ctaSurroundings.position.set(direction * (ctaCompact ? 1.3 : 2.8), 0, -1.2);
      ctaSurroundings.scale.setScalar(0.8);
      ctaCamera.position.x += (pointer.x * 0.08 - ctaCamera.position.x) * 0.025;
      ctaCamera.position.y += (pointer.y * 0.05 - ctaCamera.position.y) * 0.025;
      ctaCamera.position.z += (11.4 - ctaCamera.position.z) * 0.04;
      ctaCamera.lookAt(0, 0, 0);
    }

    camera.position.x += (pointer.x * 0.17 - camera.position.x) * 0.035;
    camera.position.y += (pointer.y * 0.1 - camera.position.y) * 0.035;
    camera.position.z += (THREE.MathUtils.lerp(11.15, 10.9, journey) - camera.position.z) * 0.04;
    camera.lookAt(0, 0, 0);

    hero.style.setProperty("--dna-progress", scrollProgress.toFixed(3));
    canvas.dataset.dnaProgress = scrollProgress.toFixed(3);
    canvas.dataset.dnaScatter = scatterUniforms.amount.value.toFixed(4);
    if (heroVisible || reduceMotion) {
      renderer.render(scene, camera);
      codeSignals.draw(quietTime);
    }
    if (ctaRenderer && ctaScene && ctaCamera && (ctaVisible || reduceMotion)) {
      ctaCanvas.dataset.dnaProgress = scrollProgress.toFixed(3);
      ctaRenderer.render(ctaScene, ctaCamera);
    }
  }

  function frame(time) {
    frameHandle = 0;
    if (!active || document.hidden) return;
    render(time);
    schedule();
  }

  function schedule() {
    if (!reduceMotion && !frameHandle && active && !document.hidden) {
      frameHandle = requestAnimationFrame(frame);
    }
  }

  const resizeObserver = new ResizeObserver(() => {
    updateLayout();
    readScroll();
    if (reduceMotion) render(2200);
  });
  resizeObserver.observe(canvas);
  if (ctaCanvas) resizeObserver.observe(ctaCanvas);
  addEventListener("scroll", readScroll, { passive: true });
  addEventListener("pointermove", readPointer, { passive: true });
  addEventListener("pointerleave", settlePointer, { passive: true });
  document.addEventListener("visibilitychange", schedule);

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === hero) heroVisible = entry.isIntersecting;
        if (entry.target === ctaSection) ctaVisible = entry.isIntersecting;
      }
      active = heroVisible || ctaVisible;
      schedule();
    }, { rootMargin: "15% 0px" });
    observer.observe(hero);
    if (ctaRenderer && ctaSection) observer.observe(ctaSection);
  }

  addEventListener("pagehide", () => {
    cancelAnimationFrame(frameHandle);
    resizeObserver.disconnect();
    renderer.dispose();
    if (ctaRenderer) ctaRenderer.dispose();
    basePairs.particles.geometry.dispose();
    basePairs.particles.material.dispose();
    surroundings.dispose();
    codeSignals.dispose();
  }, { once: true });

  updateLayout();
  readScroll();
  render(2200);
  schedule();
}
