// The Night Gallery — a WebXR room for Morning Masterpieces.
//
// Platform contract (July 2026 research, see repo docs / project memory):
// - immersive-vr only (visionOS Safari has no immersive-ar); local-floor.
// - Input via transient-pointer (gaze+pinch): session-level select events,
//   NEVER hand-tracking (avoids the double permission prompt).
// - No supersampling on Vision Pro: sharpness = MSAA + mips + anisotropy.
// - No postprocessing, no realtime shadows; volumetrics are shader fakes.
// - Docent audio: WebAudio decoded buffers -> PositionalAudio (HRTF).
// - Time-driven effects run off the XR animation loop, never bare rAF.
// - Every painting hangs at TRUE physical size (dimensions.json, cm).

import * as THREE from './three.module.js';

const CM = 0.01;
const ACCENT = 0xc8a96e;
const state = {
  hangs: [], focus: -1, docent: { index: -1, audio: null },
  raycaster: new THREE.Raycaster(), tp: null,
};

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = Number(new URLSearchParams(location.search).get('boost') ?? 1);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.getElementById('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020202);
scene.fog = new THREE.FogExp2(0x020202, 0.05);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.05, 80);
camera.position.set(0, 1.6, 0.01);
const listener = new THREE.AudioListener();
camera.add(listener);

const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

scene.add(new THREE.HemisphereLight(0x28231b, 0x080706, 0.5));

// Floor: near-black stone. Reflections are painted (see hang()), so the
// floor itself stays opaque and cheap.
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(11, 72).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x0a0908, roughness: 0.5, metalness: 0.2 })
);
scene.add(floor);

// ---------- small shared resources ----------
const maxAniso = renderer.capabilities.getMaxAnisotropy();

function gradientTex(stops, w = 1, h = 256) { // vertical gradient
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, h);
  for (const [t, col] of stops) grad.addColorStop(t, col);
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
const reflFade = gradientTex([[0, 'rgba(255,255,255,0.55)'], [0.55, 'rgba(255,255,255,0.12)'], [1, 'rgba(255,255,255,0)']]);

function fit(g, text, max) {
  while (g.measureText(text).width > max && text.length > 4) text = text.slice(0, -2).trimEnd() + '…';
  return text;
}
function makeCaptionTexture(item) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#15120e'; g.fillRect(0, 0, 1024, 256);
  g.strokeStyle = '#2e2a24'; g.lineWidth = 3; g.strokeRect(2, 2, 1020, 252);
  g.fillStyle = '#e6e2d6'; g.font = 'italic 58px Georgia, serif';
  g.fillText(fit(g, item.title, 940), 42, 108);
  g.fillStyle = '#9e9a90'; g.font = '40px Georgia, serif';
  g.fillText(fit(g, `${item.artist}  ·  ${item.year}`, 940), 42, 186);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}

// luminance -> Sobel normal map: brushwork relief under the raking spot.
function makeNormalMap(img) {
  const S = 512;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, S, S);
  const src = g.getImageData(0, 0, S, S).data;
  const lum = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) {
    lum[i] = (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255;
  }
  const out = g.createImageData(S, S);
  const at = (x, y) => lum[Math.min(S - 1, Math.max(0, y)) * S + Math.min(S - 1, Math.max(0, x))];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2.0;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 2.0;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      out.data[i] = (-dx * inv * 0.5 + 0.5) * 255;
      out.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      out.data[i + 2] = inv * 255;
      out.data[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  return t;
}

function mergeBoxes(boxes) {
  const geos = boxes.map(([w, h, d, x, y, z]) =>
    new THREE.BoxGeometry(w, h, d).translate(x, y, z));
  let total = geos.reduce((n, g2) => n + g2.attributes.position.count, 0);
  const pos = new Float32Array(total * 3), norm = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  const idx = [];
  let vo = 0;
  for (const g2 of geos) {
    pos.set(g2.attributes.position.array, vo * 3);
    norm.set(g2.attributes.normal.array, vo * 3);
    uv.set(g2.attributes.uv.array, vo * 2);
    const ia = g2.index.array;
    for (let i = 0; i < ia.length; i++) idx.push(ia[i] + vo);
    vo += g2.attributes.position.count;
  }
  const g3 = new THREE.BufferGeometry();
  g3.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g3.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  g3.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g3.setIndex(idx);
  return g3;
}

const texLoader = new THREE.TextureLoader();
function loadTex(url) {
  return new Promise((res, rej) => texLoader.load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    res(t);
  }, undefined, rej));
}

// ---------- soft volumetric beam ----------
// A cone whose light exists only in shader: bright core, fresnel-soft rim,
// fade at apex and base, and a per-beam dissolve as the viewer approaches
// its painting (the fix for beams slicing across a close-up view).
const BEAM_VERT = /* glsl */`
  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  varying float vAxial; // 0 at apex, 1 at base
  uniform float uHeight;
  void main() {
    vAxial = (uHeight * 0.5 - position.y) / uHeight;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const BEAM_FRAG = /* glsl */`
  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  varying float vAxial;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uDissolve; // 1 = full beam, 0 = gone
  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float facing = abs(dot(viewDir, normalize(vNormalW)));
    float rim = pow(facing, 2.2);            // soft silhouette edges
    float head = smoothstep(0.0, 0.18, vAxial);
    float tail = 1.0 - smoothstep(0.55, 1.0, vAxial);
    float a = uOpacity * rim * head * tail * uDissolve;
    gl_FragColor = vec4(uColor, a);
  }
`;
function makeBeamMaterial(height) {
  return new THREE.ShaderMaterial({
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(0xffdfae) },
      uOpacity: { value: 0.16 },
      uDissolve: { value: 1 },
      uHeight: { value: height },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

// ---------- hang one work ----------
const frameMat = new THREE.MeshStandardMaterial({ color: 0x241c12, roughness: 0.55, metalness: 0.1 });
const panelMat = new THREE.MeshStandardMaterial({ color: 0x110f0b, roughness: 1.0 });
const hairMat = new THREE.LineBasicMaterial({ color: 0x5c5548, transparent: true, opacity: 0.55 });

async function hang(item, angleDeg, radius, dims) {
  const [wcm, hcm] = dims[item.slug] ?? [100, 80];
  const w = Math.max(wcm * CM, 0.22), h = Math.max(hcm * CM, 0.22);
  const group = new THREE.Group();
  const a = THREE.MathUtils.degToRad(angleDeg);
  group.position.set(Math.sin(a) * radius, 0, -Math.cos(a) * radius);
  group.lookAt(0, 0, 0);

  const cy = 1.5;
  const panelW = Math.max(w + 1.3, 2.1), panelH = 3.4;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(panelW, panelH), panelMat);
  panel.position.set(0, panelH / 2, -0.06);
  group.add(panel);

  const fw = 0.045, fd = 0.05;
  const frame = new THREE.Mesh(mergeBoxes([
    [w + fw * 2, fw, fd, 0, h / 2 + fw / 2, 0],
    [w + fw * 2, fw, fd, 0, -h / 2 - fw / 2, 0],
    [fw, h, fd, -w / 2 - fw / 2, 0, 0],
    [fw, h, fd, w / 2 + fw / 2, 0, 0],
  ]), frameMat);
  frame.position.set(0, cy, -0.02);
  group.add(frame);

  // Color fidelity is sacred: the canvas renders its texture EXACTLY —
  // no scene lights, no tone mapping (ShaderMaterial bypasses it), only a
  // mean-neutral ±7% brushwork micro-shade from the luminance normal map.
  // The spotlight pools on frame and panel; the art shows its own truth.
  const display = await loadTex(`../${item.image}`);
  const canvasMat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: display },
      uRelief: { value: display.image ? makeNormalMap(display.image) : null },
      uReliefAmt: { value: display.image ? 1.0 : 0.0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap, uRelief;
      uniform float uReliefAmt;
      varying vec2 vUv;
      void main() {
        vec3 col = texture2D(uMap, vUv).rgb;
        vec3 n = texture2D(uRelief, vUv).xyz * 2.0 - 1.0;
        // fixed raking light from the fixture (up and slightly forward)
        float shade = 0.965 + 0.07 * (dot(normalize(n), normalize(vec3(0.0, 0.62, 0.78))) - 0.5) * uReliefAmt;
        gl_FragColor = vec4(col * shade, 1.0);
      }
    `,
  });
  const painting = new THREE.Mesh(new THREE.PlaneGeometry(w, h), canvasMat);
  painting.position.set(0, cy, 0);
  painting.userData = { kind: 'painting', item, index: state.hangs.length };
  group.add(painting);

  // hairline glow around the canvas — the app's aesthetic, made physical
  const hairGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-w / 2, -h / 2, 0), new THREE.Vector3(w / 2, -h / 2, 0),
    new THREE.Vector3(w / 2, h / 2, 0), new THREE.Vector3(-w / 2, h / 2, 0),
    new THREE.Vector3(-w / 2, -h / 2, 0),
  ]);
  const hair = new THREE.Line(hairGeo, hairMat);
  hair.position.set(0, cy, 0.004);
  group.add(hair);

  // painted floor reflection (his reference image's glow, at quad cost):
  // the artwork mirrored onto the stone, fading with distance from the wall
  const reflMap = display.clone();
  reflMap.repeat.y = -1;
  reflMap.offset.y = 1;
  reflMap.needsUpdate = true;
  const reflLen = Math.min(h * 1.15, 1.9);
  const refl = new THREE.Mesh(
    new THREE.PlaneGeometry(w, reflLen).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: reflMap, alphaMap: reflFade, transparent: true,
      opacity: 0.28, depthWrite: false, color: 0x8a8a86,
    })
  );
  refl.position.set(0, 0.003, reflLen / 2 + 0.03);
  group.add(refl);

  const cap = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.155),
    new THREE.MeshBasicMaterial({ map: makeCaptionTexture(item), transparent: true, opacity: 0.92 })
  );
  cap.position.set(Math.max(w / 2 - 0.31, 0), cy - h / 2 - 0.22, 0.001);
  group.add(cap);

  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.042, 20, 14),
    new THREE.MeshStandardMaterial({ color: ACCENT, emissive: ACCENT, emissiveIntensity: 0.7, roughness: 0.4 })
  );
  orb.position.set(-Math.max(w / 2 - 0.02, 0.33) - 0.12, cy - h / 2 - 0.22, 0.02);
  group.add(orb);
  // generous invisible pinch target — a 4cm orb at 2m is sub-gaze-precision
  const orbHit = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  orbHit.position.copy(orb.position);
  orbHit.userData = { kind: 'orb', item, index: state.hangs.length };
  group.add(orbHit);

  // the 30-degree museum spot, tight to the canvas
  const spot = new THREE.SpotLight(0xffe0b8, 26, 8, Math.atan2(Math.max(w, h) * 0.60, 2.6), 0.65, 1.6);
  const sy = cy + h / 2 + 1.5 * Math.cos(THREE.MathUtils.degToRad(30));
  const sz = 1.5 * Math.sin(THREE.MathUtils.degToRad(30));
  spot.position.set(0, sy, sz);
  spot.target = painting;
  group.add(spot);

  // soft beam: apex at the fixture, wide enough to clear the canvas
  // CORNERS, and ending well SHORT of the canvas plane — the beam is
  // fixture glow only; it must never overlay the art (washes the image).
  const fixture = new THREE.Vector3(0, sy, sz);
  const target = new THREE.Vector3(0, cy, 0);
  const beamDir = target.clone().sub(fixture);
  const fullDist = beamDir.length();
  const beamLen = Math.max(0.6, fullDist - 0.5);
  const beamR = Math.hypot(w, h) * 0.62 * (beamLen / fullDist);
  const beamMat = makeBeamMaterial(beamLen);
  const beam = new THREE.Mesh(new THREE.ConeGeometry(beamR, beamLen, 28, 1, true), beamMat);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), beamDir.clone().normalize().negate());
  beam.position.copy(fixture).addScaledVector(beamDir.normalize(), beamLen / 2);
  group.add(beam);

  const stand = Math.max(1.45, Math.max(w, h) * 1.15);
  const pad = new THREE.Mesh(
    new THREE.RingGeometry(0.16, 0.2, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.14 })
  );
  pad.position.set(0, 0.005, stand);
  pad.userData = { kind: 'pad', index: state.hangs.length };
  group.add(pad);

  scene.add(group);
  group.updateWorldMatrix(true, true);
  state.hangs.push({
    group, painting, orb, orbHit, pad, spot, beamMat, item, stand,
    baseIntensity: 26, hot: 0,
    worldPos: new THREE.Vector3().setFromMatrixPosition(painting.matrixWorld),
  });
}

// ---------- the Heart: the collection's words, orbiting ----------
// An homage to a self-portrait: a slow galaxy of serif letterforms sampled
// from the docent's own lessons, crowning the room. One InstancedMesh.
function buildHeart(lessonText) {
  const heart = new THREE.Group();
  heart.position.set(0, 3.6, 0);

  // glyph atlas: 8x8 cells of Georgia italic characters from the lessons
  const chars = (lessonText.replace(/[^a-zA-Z]/g, '') || 'MorningMasterpieces').split('');
  const A = 1024, GRID = 8, CELL = A / GRID;
  const atlas = document.createElement('canvas'); atlas.width = A; atlas.height = A;
  const g = atlas.getContext('2d');
  g.clearRect(0, 0, A, A);
  g.fillStyle = '#ffe6bd';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let i = 0; i < GRID * GRID; i++) {
    const ch = chars[Math.floor(Math.random() * chars.length)];
    g.font = `italic ${CELL * (0.55 + Math.random() * 0.3)}px Georgia, serif`;
    g.fillText(ch, (i % GRID) * CELL + CELL / 2, Math.floor(i / GRID) * CELL + CELL / 2);
  }
  const atlasTex = new THREE.CanvasTexture(atlas);
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.anisotropy = 8;

  const COUNT = 620;
  const geo = new THREE.PlaneGeometry(0.11, 0.11);
  const inst = new THREE.InstancedBufferGeometry();
  inst.index = geo.index;
  inst.attributes.position = geo.attributes.position;
  inst.attributes.uv = geo.attributes.uv;
  const centers = new Float32Array(COUNT * 3);
  const cell = new Float32Array(COUNT);
  const phase = new Float32Array(COUNT);
  const scale = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    // loose shell with a dense core, like the reference
    const r = 0.55 + Math.pow(Math.random(), 0.65) * 1.15;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    const squash = 0.72; // slightly galactic
    centers.set([
      r * Math.sin(ph) * Math.cos(th),
      r * Math.cos(ph) * squash,
      r * Math.sin(ph) * Math.sin(th),
    ], i * 3);
    cell[i] = Math.floor(Math.random() * GRID * GRID);
    phase[i] = Math.random() * Math.PI * 2;
    scale[i] = 0.5 + Math.random() * 0.9;
  }
  inst.setAttribute('aCenter', new THREE.InstancedBufferAttribute(centers, 3));
  inst.setAttribute('aCell', new THREE.InstancedBufferAttribute(cell, 1));
  inst.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
  inst.setAttribute('aScale', new THREE.InstancedBufferAttribute(scale, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlasTex },
      uTime: { value: 0 },
      uCamRight: { value: new THREE.Vector3(1, 0, 0) },
      uCamUp: { value: new THREE.Vector3(0, 1, 0) },
      uGrid: { value: GRID },
    },
    vertexShader: /* glsl */`
      attribute vec3 aCenter;
      attribute float aCell, aPhase, aScale;
      uniform float uTime, uGrid;
      uniform vec3 uCamRight, uCamUp;
      varying vec2 vUv;
      varying float vTw;
      void main() {
        vec2 cellUv = vec2(mod(aCell, uGrid), floor(aCell / uGrid)) / uGrid;
        vUv = cellUv + uv / uGrid;
        vTw = 0.55 + 0.45 * sin(uTime * (0.4 + fract(aPhase) * 0.7) + aPhase * 7.0);
        vec3 c = aCenter;
        c.y += sin(uTime * 0.15 + aPhase) * 0.025;
        vec3 world = c + (uCamRight * position.x + uCamUp * position.y) * aScale;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uAtlas;
      varying vec2 vUv;
      varying float vTw;
      void main() {
        vec4 t = texture2D(uAtlas, vUv);
        float a = t.a * vTw * 0.85;
        if (a < 0.01) discard;
        gl_FragColor = vec4(t.rgb, a);
      }
    `,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const letters = new THREE.Mesh(inst, mat);
  letters.frustumCulled = false;
  heart.add(letters);

  // faint orbital rings, tilted like the reference
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xc8a96e, transparent: true, opacity: 0.10,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  for (const [r, tx, tz] of [[1.05, 0.35, 0.1], [1.35, -0.2, 0.3], [1.6, 0.1, -0.45]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0035, 8, 128), ringMat);
    ring.rotation.set(Math.PI / 2 + tx, 0, tz);
    heart.add(ring);
  }

  // soft core
  const cc = document.createElement('canvas'); cc.width = cc.height = 256;
  const cg = cc.getContext('2d');
  const rad = cg.createRadialGradient(128, 128, 0, 128, 128, 128);
  rad.addColorStop(0, 'rgba(255,238,205,0.9)');
  rad.addColorStop(0.25, 'rgba(255,222,170,0.35)');
  rad.addColorStop(1, 'rgba(255,222,170,0)');
  cg.fillStyle = rad; cg.fillRect(0, 0, 256, 256);
  const coreTex = new THREE.CanvasTexture(cc);
  const core = new THREE.Sprite(new THREE.SpriteMaterial({
    map: coreTex, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  core.scale.setScalar(1.1);
  heart.add(core);

  // its reflection in the stone, faint
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(1.6, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: coreTex, transparent: true, opacity: 0.10,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  glow.position.set(0, 0.004, 0);
  scene.add(glow);

  scene.add(heart);
  state.heart = { group: heart, mat, letters };
}

// ---------- dust motes with twinkle ----------
function addMotes() {
  const N = 1100, pos = new Float32Array(N * 3), seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (i % 3 === 0) { // ambient field, whole room
      const r = 2 + Math.random() * 6.5, th = Math.random() * Math.PI * 2;
      pos.set([Math.cos(th) * r, 0.3 + Math.random() * 3.4, Math.sin(th) * r], i * 3);
    } else { // inside the beams
      const hgroup = state.hangs[i % state.hangs.length].group;
      const local = new THREE.Vector3((Math.random() - 0.5) * 1.1, 1.1 + Math.random() * 1.7, 0.1 + Math.random() * 0.6);
      const world = local.applyMatrix4(hgroup.matrixWorld);
      pos.set([world.x, world.y, world.z], i * 3);
    }
    seed[i] = Math.random() * 100;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute float aSeed;
      uniform float uTime;
      varying float vA;
      void main() {
        vec3 p = position;
        p.y += sin(uTime * 0.10 + aSeed) * 0.06;
        p.x += sin(uTime * 0.07 + aSeed * 1.7) * 0.04;
        vA = 0.25 + 0.75 * (0.5 + 0.5 * sin(uTime * (0.5 + fract(aSeed) * 0.9) + aSeed * 3.0));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (2.4 + fract(aSeed * 7.0) * 2.2) * (1.0 / max(0.7, -mv.z * 0.28));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      varying float vA;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float fall = smoothstep(0.5, 0.05, length(d));
        gl_FragColor = vec4(1.0, 0.92, 0.78, fall * vA * 0.5);
      }
    `,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  state.motes = new THREE.Points(g, m);
  scene.add(state.motes);
}

// ---------- room tone: a whisper-quiet synthesized drone (XR only) ----------
const drone = { nodes: null };
function startDrone() {
  if (drone.nodes) return;
  const ctx = listener.context;
  const master = ctx.createGain();
  master.gain.value = 0.0;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 260;
  lp.connect(master); master.connect(ctx.destination);
  const parts = [];
  for (const [freq, amp, lfoHz] of [[55, 0.5, 0.05], [82.4, 0.28, 0.083], [110.1, 0.2, 0.061]]) {
    const osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = freq;
    const gain = ctx.createGain(); gain.gain.value = amp;
    const lfo = ctx.createOscillator(); lfo.frequency.value = lfoHz;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = amp * 0.35;
    lfo.connect(lfoGain); lfoGain.connect(gain.gain);
    osc.connect(gain); gain.connect(lp);
    osc.start(); lfo.start();
    parts.push(osc, lfo);
  }
  master.gain.linearRampToValueAtTime(0.016, ctx.currentTime + 6); // whisper
  drone.nodes = { master, parts };
}
function stopDrone() {
  if (!drone.nodes) return;
  const ctx = listener.context;
  drone.nodes.master.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.2);
  const parts = drone.nodes.parts;
  setTimeout(() => parts.forEach((p) => { try { p.stop(); } catch {} }), 1500);
  drone.nodes = null;
}

// ---------- title plate ----------
let title = null;
function addTitle(dateline) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 380;
  const g = c.getContext('2d');
  g.fillStyle = '#6e675b';
  g.font = '600 34px -apple-system, system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText('M O R N I N G   M A S T E R P I E C E S', 512, 80);
  g.fillStyle = '#c8a96e'; g.font = 'italic 96px Georgia, serif';
  g.fillText('The Night Gallery', 512, 200);
  g.fillStyle = '#9e9a90'; g.font = '38px Georgia, serif';
  g.fillText(dateline, 512, 290);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  title = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 0.6),
    new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.95 })
  );
  title.position.set(0, 1.62, -2.2);
  scene.add(title);
}

// ---------- teleport (driven by the XR loop, never bare rAF) ----------
const fade = new THREE.Mesh(
  new THREE.SphereGeometry(0.4, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false })
);
fade.renderOrder = 999;
camera.add(fade);

function teleportTo(i) {
  if (state.tp) return;
  state.tp = { i, t0: clock.elapsedTime, done: false };
}
function tickTeleport() {
  const tp = state.tp;
  if (!tp) return;
  const k = Math.min(1, (clock.elapsedTime - tp.t0) / 0.34);
  fade.material.opacity = k < 0.5 ? k * 2 : (1 - k) * 2;
  if (k >= 0.5 && !tp.done) {
    tp.done = true;
    const h = state.hangs[tp.i];
    h.group.updateWorldMatrix(true, true);
    const target = new THREE.Vector3(0, 0, h.stand).applyMatrix4(h.group.matrixWorld);
    rig.position.set(target.x, 0, target.z);
    const pw = new THREE.Vector3().setFromMatrixPosition(h.painting.matrixWorld);
    rig.rotation.y = Math.atan2(-(pw.x - target.x), -(pw.z - target.z));
    if (!renderer.xr.isPresenting) {
      yaw = 0; pitch = 0;
      camera.rotation.set(0, 0, 0);
      camera.position.set(0, 1.6, 0.01);
    }
    state.focus = tp.i;
    upgradeFocusTexture(tp.i);
  }
  if (k >= 1) { state.tp = null; fade.material.opacity = 0; }
}

async function upgradeFocusTexture(i) {
  const h = state.hangs[i];
  if (h.upgraded) return;
  h.upgraded = true;
  try {
    const hi = await loadTex(`../${h.item.zoom}`);
    h.painting.material.uniforms.uMap.value = hi; // fidelity shader's map
  } catch { /* keep display res */ }
}

// ---------- docent ----------
async function toggleDocent(i) {
  const h = state.hangs[i];
  if (listener.context.state === 'suspended') await listener.context.resume().catch(() => {});
  if (state.docent.index === i && state.docent.audio?.isPlaying) {
    state.docent.audio.stop();
    state.docent = { index: -1, audio: null };
    return;
  }
  if (state.docent.audio?.isPlaying) state.docent.audio.stop();
  if (!h.buffer) {
    try {
      const res = await fetch(`../${h.item.audio}`);
      h.buffer = await listener.context.decodeAudioData(await res.arrayBuffer());
    } catch { return; }
  }
  if (!h.pa) {
    h.pa = new THREE.PositionalAudio(listener);
    h.pa.setRefDistance(1.3);
    h.pa.setRolloffFactor(1.4);
    h.pa.panner.panningModel = 'HRTF';
    h.painting.add(h.pa);
  }
  h.pa.setBuffer(h.buffer);
  h.pa.play();
  state.docent = { index: i, audio: h.pa };
}

// ---------- interaction ----------
function interactables() {
  const out = [];
  for (const h of state.hangs) out.push(h.painting, h.orbHit, h.pad);
  return out;
}
function activate(hit) {
  const u = hit.object.userData;
  if (u.kind === 'orb') toggleDocent(u.index);
  else if (u.kind === 'painting' || u.kind === 'pad') teleportTo(u.index);
}

/* Activation happens on selectstart, NOT select: the transient-pointer
   ray equals the user's gaze only on its first frame — after pinch-down
   it follows the HAND, so by 'select' (release) it has drifted and small
   targets like the docent orb miss. Pinch-down carries the true gaze. */
const tmpMat = new THREE.Matrix4();
function onSessionSelectStart(ev) {
  const src = ev.inputSource;
  if (src.targetRayMode !== 'transient-pointer' && src.targetRayMode !== 'tracked-pointer') return;
  const pose = ev.frame.getPose(src.targetRaySpace, renderer.xr.getReferenceSpace());
  if (!pose) return;
  tmpMat.fromArray(pose.transform.matrix);
  const origin = new THREE.Vector3().setFromMatrixPosition(tmpMat).applyMatrix4(rig.matrixWorld);
  const dir = new THREE.Vector3(0, 0, -1).transformDirection(tmpMat).transformDirection(rig.matrixWorld);
  state.raycaster.set(origin, dir);
  const hits = state.raycaster.intersectObjects(interactables(), false);
  if (hits.length) activate(hits[0]);
}

// 2D fallback: click + WASD + drag-look
let dragging = false, px = 0, py = 0, yaw = 0, pitch = 0;
const keys = {};
renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; px = e.clientX; py = e.clientY; });
addEventListener('pointerup', () => { dragging = false; });
addEventListener('pointermove', (e) => {
  if (!dragging || renderer.xr.isPresenting) return;
  yaw -= (e.clientX - px) * 0.0035; pitch -= (e.clientY - py) * 0.0035;
  pitch = Math.max(-1.2, Math.min(1.2, pitch));
  px = e.clientX; py = e.clientY;
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
});
function healProjection() {
  if (!Number.isFinite(camera.projectionMatrix.elements[0])) {
    const el = renderer.domElement;
    camera.aspect = (el.clientWidth || 16) / (el.clientHeight || 9);
    camera.updateProjectionMatrix();
  }
}
renderer.domElement.addEventListener('click', (e) => {
  if (renderer.xr.isPresenting || dragging === 'moved') return;
  healProjection();
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  state.raycaster.setFromCamera(ndc, camera);
  const hits = state.raycaster.intersectObjects(interactables(), false);
  if (hits.length) activate(hits[0]);
});
addEventListener('keydown', (e) => { keys[e.key.toLowerCase()] = true; });
addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

// head-ray soft hover + focus dimming + beam dissolve
const fwd = new THREE.Vector3();
const camWorld = new THREE.Vector3();
function hover(dt) {
  camera.getWorldDirection(fwd);
  camera.getWorldPosition(camWorld);
  state.raycaster.set(camWorld, fwd);
  const hits = state.raycaster.intersectObjects(state.hangs.map((h) => h.painting), false);
  const hotIndex = hits.length ? hits[0].object.userData.index : -1;
  for (const [i, h] of state.hangs.entries()) {
    const want = i === hotIndex ? 1 : 0;
    h.hot += (want - h.hot) * Math.min(1, dt * 4);
    // museums dim the room around the work you're with
    const focusDim = state.focus >= 0 && state.focus !== i ? 0.72 : 1;
    h.spot.intensity = h.baseIntensity * (1 + h.hot * 0.35) * focusDim;
    h.orb.material.emissiveIntensity = 0.7 + h.hot * 0.9 + (state.docent.index === i ? 0.8 : 0);
    // dissolve the beam as the viewer nears its painting — never let the
    // cone slice across a close-up view (gone by 1.8m, full past 3.2m)
    const d = camWorld.distanceTo(h.worldPos);
    const dissolve = THREE.MathUtils.clamp((d - 1.8) / 1.4, 0, 1);
    h.beamMat.uniforms.uDissolve.value = dissolve * focusDim;
  }
}

// ---------- boot ----------
async function boot() {
  const [artworks, dims] = await Promise.all([
    fetch('../artworks.json').then((r) => r.json()),
    fetch('./dimensions.json').then((r) => r.json()),
  ]);
  const exhibitions = await fetch('../exhibitions.json').then((r) => r.ok ? r.json() : { exhibitions: [] }).catch(() => ({ exhibitions: [] }));
  const today = await fetch('../today.json').then((r) => r.ok ? r.json() : null).catch(() => null);

  const ex = exhibitions.exhibitions[0];
  const roster = [];
  const todayItem = today?.item ?? artworks.items[0];
  roster.push(todayItem);
  if (ex) for (const it of ex.items) if (it.slug !== todayItem.slug) roster.push(it);
  while (roster.length < 7) {
    const it = artworks.items[(artworks.items.indexOf(todayItem) + roster.length * 7) % artworks.items.length];
    if (!roster.find((r) => r.slug === it.slug)) roster.push(it); else break;
  }

  const n = roster.length;
  const span = Math.min(300, n * 30);
  await hang(roster[0], 0, 4.2, dims);
  for (let i = 1; i < n; i++) {
    const side = i % 2 === 1 ? 1 : -1;
    const step = Math.ceil(i / 2);
    await hang(roster[i], side * step * (span / (n - 1 || 1)), 5.4, dims);
  }
  addMotes();
  buildHeart(roster.map((r) => r.lesson).join(''));
  addTitle(today ? new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : '');
  document.getElementById('loading').hidden = true;

  const supported = await navigator.xr?.isSessionSupported?.('immersive-vr').catch(() => false);
  const btn = document.getElementById('enter');
  if (supported) {
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      const ctx = THREE.AudioContext.getContext();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      try {
        const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
        session.addEventListener('selectstart', onSessionSelectStart);
        session.addEventListener('end', () => {
          document.getElementById('hud').classList.remove('insession');
          if (state.docent.audio?.isPlaying) state.docent.audio.stop();
          stopDrone();
        });
        await renderer.xr.setSession(session);
        document.getElementById('hud').classList.add('insession');
        setTimeout(() => {
          THREE.AudioContext.getContext().resume().catch(() => {});
          startDrone();
        }, 400);
      } catch (err) {
        document.getElementById('hint').textContent = 'Could not start the immersive session: ' + err.message;
      }
    });
  } else {
    document.getElementById('hint').textContent =
      'Open this page in Safari on Apple Vision Pro for the full room — or explore here: drag to look, W A S D to walk, click a painting to approach, click the amber orb to hear the docent.';
  }
}

// ---------- frame loop ----------
const clock = new THREE.Clock();
const camRight = new THREE.Vector3(), camUp = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  const t = clock.elapsedTime;
  healProjection(); // a camera born in a 0x0 viewport heals on first real frame
  if (!renderer.xr.isPresenting) {
    const speed = 2.1 * dt;
    const dir = new THREE.Vector3();
    if (keys['w'] || keys['arrowup']) dir.z -= 1;
    if (keys['s'] || keys['arrowdown']) dir.z += 1;
    if (keys['a'] || keys['arrowleft']) dir.x -= 1;
    if (keys['d'] || keys['arrowright']) dir.x += 1;
    if (dir.lengthSq()) {
      dir.normalize().applyQuaternion(camera.quaternion);
      dir.y = 0;
      camera.position.addScaledVector(dir, speed);
    }
  }
  tickTeleport();
  hover(dt);
  if (state.motes) state.motes.material.uniforms.uTime.value = t;
  if (state.heart) {
    state.heart.group.rotation.y = t * 0.03;
    state.heart.mat.uniforms.uTime.value = t;
    camera.matrixWorld.extractBasis(camRight, camUp, new THREE.Vector3());
    state.heart.mat.uniforms.uCamRight.value.copy(camRight);
    state.heart.mat.uniforms.uCamUp.value.copy(camUp);
  }
  if (title) {
    // the plate withdraws once you've begun to wander
    const want = state.focus === -1 ? 0.95 : 0;
    title.material.opacity += (want - title.material.opacity) * Math.min(1, dt * 2);
    title.visible = title.material.opacity > 0.02;
  }
  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  if (!innerWidth || !innerHeight) return; // zero-size events poison aspect
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

boot().catch((err) => {
  document.getElementById('hint').textContent = 'Could not load the gallery: ' + err.message;
  document.getElementById('loading').hidden = true;
});

// debug handle (harmless in production; used by the build's own tests)
window.NG = { state, teleportTo, toggleDocent, tickTeleport, hover, clock, camera, rig, scene, renderer, startDrone, stopDrone };
