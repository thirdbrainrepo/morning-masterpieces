// The Night Gallery — a WebXR room for Morning Masterpieces.
//
// Design (per the July 2026 platform research, see repo docs):
// - immersive-vr only (visionOS Safari has no immersive-ar); local-floor.
// - Input via transient-pointer (gaze+pinch): session-level select events,
//   NEVER hand-tracking (avoids the double permission prompt).
// - No supersampling exists on Vision Pro (framebufferScaleFactor ignored):
//   sharpness = MSAA + mipmaps + 16x anisotropy on artwork textures.
// - No postprocessing, no realtime shadows, fake volumetric cones + motes.
// - Docent audio: WebAudio decoded buffers -> PositionalAudio (HRTF); the
//   media-element path pauses on XR session entry (visionOS bug).
// - Every painting hangs at TRUE physical size (dimensions.json, cm).

import * as THREE from './three.module.js';

const CM = 0.01;
const WALL = 0x1a1713, ACCENT = 0xc8a96e, INKDIM = 0xa49c8c;
const state = {
  works: [], hangs: [], focus: -1, docent: { index: -1, audio: null },
  raycaster: new THREE.Raycaster(), tp: null, entered: false,
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
scene.background = new THREE.Color(0x030303);
scene.fog = new THREE.FogExp2(0x030303, 0.055);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.05, 60);
camera.position.set(0, 1.6, 0.01);
const listener = new THREE.AudioListener();
camera.add(listener);
scene.add(camera);

// rig for teleportation (moving the world origin under the user)
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

scene.add(new THREE.HemisphereLight(0x2a251d, 0x0a0908, 0.55));

// floor: a dark pool of stone, glossy enough to carry light memories
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(10, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x0c0b09, roughness: 0.4, metalness: 0.25 })
);
scene.add(floor);

// ---------- helpers ----------
function makeCaptionTexture(item) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#171410'; g.fillRect(0, 0, 1024, 256);
  g.strokeStyle = '#2e2a24'; g.lineWidth = 3; g.strokeRect(2, 2, 1020, 252);
  g.fillStyle = '#e6e2d6'; g.font = 'italic 58px Georgia, serif';
  g.fillText(fit(g, item.title, 940), 42, 108);
  g.fillStyle = '#9e9a90'; g.font = '40px Georgia, serif';
  g.fillText(fit(g, `${item.artist}  ·  ${item.year}`, 940), 42, 186);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
function fit(g, text, max) {
  while (g.measureText(text).width > max && text.length > 4) text = text.slice(0, -2).trimEnd() + '…';
  return text;
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

function mergeBoxes(boxes) { // [[w,h,d,x,y,z], ...] -> one BufferGeometry
  const geos = boxes.map(([w, h, d, x, y, z]) =>
    new THREE.BoxGeometry(w, h, d).translate(x, y, z));
  const merged = geos[0].clone();
  // manual merge: concatenate attributes via BufferGeometryUtils-free path
  let total = geos.reduce((n, g2) => n + g2.attributes.position.count, 0);
  const pos = new Float32Array(total * 3), norm = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  const idx = [];
  let vo = 0, off = 0;
  for (const g2 of geos) {
    pos.set(g2.attributes.position.array, vo * 3);
    norm.set(g2.attributes.normal.array, vo * 3);
    uv.set(g2.attributes.uv.array, vo * 2);
    const ia = g2.index.array;
    for (let i = 0; i < ia.length; i++) idx.push(ia[i] + vo);
    vo += g2.attributes.position.count; off++;
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
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    res(t);
  }, undefined, rej));
}

// ---------- hang one work ----------
const frameMat = new THREE.MeshStandardMaterial({ color: 0x241c12, roughness: 0.55, metalness: 0.1 });
const panelMat = new THREE.MeshStandardMaterial({ color: WALL, roughness: 0.92 });
const coneMat = new THREE.MeshBasicMaterial({
  color: 0xffdfae, transparent: true, opacity: 0.045,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});

async function hang(item, angleDeg, radius, dims) {
  const [wcm, hcm] = dims[item.slug] ?? [100, 80];
  const w = Math.max(wcm * CM, 0.22), h = Math.max(hcm * CM, 0.22);
  const group = new THREE.Group();
  const a = THREE.MathUtils.degToRad(angleDeg);
  group.position.set(Math.sin(a) * radius, 0, -Math.cos(a) * radius);
  group.lookAt(0, 0, 0);

  const cy = 1.5; // museum center height
  const panelW = Math.max(w + 1.1, 1.9), panelH = Math.max(h + 1.2, 2.6);
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(panelW, panelH), panelMat);
  panel.position.set(0, Math.max(panelH / 2, 1.55), -0.06);
  group.add(panel);

  const fw = 0.045, fd = 0.05; // frame bar width/depth
  const frame = new THREE.Mesh(mergeBoxes([
    [w + fw * 2, fw, fd, 0, h / 2 + fw / 2, 0],
    [w + fw * 2, fw, fd, 0, -h / 2 - fw / 2, 0],
    [fw, h, fd, -w / 2 - fw / 2, 0, 0],
    [fw, h, fd, w / 2 + fw / 2, 0, 0],
  ]), frameMat);
  frame.position.set(0, cy, -0.02);
  group.add(frame);

  const display = await loadTex(`../${item.image}`);
  const canvasMat = new THREE.MeshStandardMaterial({
    map: display, roughness: 0.62, metalness: 0,
    normalScale: new THREE.Vector2(0.55, 0.55),
  });
  if (display.image) canvasMat.normalMap = makeNormalMap(display.image);
  const painting = new THREE.Mesh(new THREE.PlaneGeometry(w, h), canvasMat);
  painting.position.set(0, cy, 0);
  painting.userData = { kind: 'painting', item, index: state.hangs.length };
  group.add(painting);

  // caption plate + docent orb
  const cap = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.155),
    new THREE.MeshBasicMaterial({ map: makeCaptionTexture(item) })
  );
  cap.position.set(Math.max(w / 2 - 0.31, 0), cy - h / 2 - 0.22, 0.001);
  group.add(cap);

  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 20, 14),
    new THREE.MeshStandardMaterial({ color: ACCENT, emissive: ACCENT, emissiveIntensity: 0.7, roughness: 0.4 })
  );
  orb.position.set(-Math.max(w / 2 - 0.02, 0.33) - 0.12, cy - h / 2 - 0.22, 0.02);
  orb.userData = { kind: 'orb', item, index: state.hangs.length };
  group.add(orb);

  // the 30-degree museum spot + its fake volume
  const spot = new THREE.SpotLight(0xffe0b8, 26, 7, Math.atan2(Math.max(w, h) * 0.72, 2.6), 0.5, 1.6);
  const sy = cy + h / 2 + 1.5 * Math.cos(THREE.MathUtils.degToRad(30));
  const sz = 1.5 * Math.sin(THREE.MathUtils.degToRad(30));
  spot.position.set(0, sy, sz);
  spot.target = painting;
  group.add(spot);

  // Beam: apex at the fixture, widening down toward the canvas.
  const fixture = new THREE.Vector3(0, sy, sz);
  const target = new THREE.Vector3(0, cy, 0);
  const beamDir = target.clone().sub(fixture);
  const coneLen = beamDir.length() + 0.15;
  const coneR = Math.max(w, h) * 0.52;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(coneR, coneLen, 24, 1, true), coneMat);
  // ConeGeometry's apex points +Y; flip so apex leads along the beam.
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), beamDir.clone().normalize().negate());
  cone.position.copy(fixture).addScaledVector(beamDir.normalize(), coneLen / 2);
  group.add(cone);

  // teleport pad
  const stand = Math.max(1.45, Math.max(w, h) * 1.15);
  const pad = new THREE.Mesh(
    new THREE.RingGeometry(0.16, 0.2, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.16 })
  );
  pad.position.set(0, 0.005, stand);
  pad.userData = { kind: 'pad', index: state.hangs.length };
  group.add(pad);

  scene.add(group);
  state.hangs.push({ group, painting, orb, pad, spot, item, stand, baseIntensity: 26, hot: 0 });
}

// ---------- dust motes, one Points cloud across all cones ----------
function addMotes() {
  const N = 900, pos = new Float32Array(N * 3), seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const hgroup = state.hangs[i % state.hangs.length].group;
    const local = new THREE.Vector3((Math.random() - 0.5) * 1.4, 1.0 + Math.random() * 1.8, 0.2 + Math.random() * 0.7);
    const world = local.applyMatrix4(hgroup.matrixWorld);
    pos.set([world.x, world.y, world.z], i * 3);
    seed[i] = Math.random() * 100;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const m = new THREE.PointsMaterial({
    color: 0xffe9c8, size: 0.006, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const points = new THREE.Points(g, m);
  scene.add(points);
  state.motes = points;
}

// ---------- teleport ----------
const fade = new THREE.Mesh(
  new THREE.SphereGeometry(0.4, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false })
);
fade.renderOrder = 999;
camera.add(fade);

/* Teleport is driven from the render loop, not requestAnimationFrame —
   rAF throttles in hidden tabs and misbehaves around visionOS session
   transitions; the XR animation loop is the one reliable clock. */
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
    h.group.updateWorldMatrix(true, true); // never trust a possibly-stale frame
    const target = new THREE.Vector3(0, 0, h.stand).applyMatrix4(h.group.matrixWorld);
    rig.position.set(target.x, 0, target.z);
    const pw = new THREE.Vector3().setFromMatrixPosition(h.painting.matrixWorld);
    rig.rotation.y = Math.atan2(-(pw.x - target.x), -(pw.z - target.z));
    if (!renderer.xr.isPresenting) { // 2D: reset drag-look so the rig aims us
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
    h.painting.material.map = hi;
    h.painting.material.needsUpdate = true;
  } catch { /* keep display res */ }
}

// ---------- docent ----------
async function toggleDocent(i) {
  const h = state.hangs[i];
  if (listener.context.state === 'suspended') await listener.context.resume().catch(() => {});
  if (state.docent.index === i && state.docent.audio?.isPlaying) {
    state.docent.audio.stop();
    state.docent.index = -1;
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
  for (const h of state.hangs) out.push(h.painting, h.orb, h.pad);
  return out;
}

function activate(hit) {
  const u = hit.object.userData;
  if (u.kind === 'orb') toggleDocent(u.index);
  else if (u.kind === 'painting' || u.kind === 'pad') teleportTo(u.index);
}

// XR: session-level select events on transient-pointer (index-shift-proof)
const tmpMat = new THREE.Matrix4();
function onSessionSelect(ev) {
  const src = ev.inputSource;
  if (src.targetRayMode !== 'transient-pointer' && src.targetRayMode !== 'tracked-pointer') return;
  const frame = ev.frame;
  const ref = renderer.xr.getReferenceSpace();
  const pose = frame.getPose(src.targetRaySpace, ref);
  if (!pose) return;
  tmpMat.fromArray(pose.transform.matrix);
  // transform ray into world (rig offset applies)
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

// head-ray soft hover: warm the painting you're facing
const fwd = new THREE.Vector3();
function hover(dt) {
  camera.getWorldDirection(fwd);
  state.raycaster.set(camera.getWorldPosition(new THREE.Vector3()), fwd);
  const hits = state.raycaster.intersectObjects(state.hangs.map((h) => h.painting), false);
  const hotIndex = hits.length ? hits[0].object.userData.index : -1;
  for (const [i, h] of state.hangs.entries()) {
    const want = i === hotIndex ? 1 : 0;
    h.hot += (want - h.hot) * Math.min(1, dt * 4);
    h.spot.intensity = h.baseIntensity * (1 + h.hot * 0.35);
    h.orb.material.emissiveIntensity = 0.7 + h.hot * 0.9 + (state.docent.index === i ? 0.8 : 0);
  }
}

// ---------- boot ----------
async function boot() {
  const [artworks, dims] = await Promise.all([
    fetch('../artworks.json').then((r) => r.json()),
    fetch('../vision/dimensions.json').then((r) => r.json()),
  ]);
  const exhibitions = await fetch('../exhibitions.json').then((r) => r.ok ? r.json() : { exhibitions: [] }).catch(() => ({ exhibitions: [] }));
  const today = await fetch('../today.json').then((r) => r.ok ? r.json() : null).catch(() => null);

  // roster: today's work front and center, active exhibition as the arc
  const ex = exhibitions.exhibitions[0];
  const roster = [];
  const todayItem = today?.item ?? artworks.items[0];
  roster.push(todayItem);
  if (ex) for (const it of ex.items) if (it.slug !== todayItem.slug) roster.push(it);
  while (roster.length < 7) { // pad from PC when no exhibition
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
        session.addEventListener('select', onSessionSelect);
        session.addEventListener('end', () => {
          document.getElementById('hud').classList.remove('insession');
          if (state.docent.audio?.isPlaying) state.docent.audio.stop();
        });
        await renderer.xr.setSession(session);
        document.getElementById('hud').classList.add('insession');
        // visionOS pauses media on entry; nudge the context back
        setTimeout(() => THREE.AudioContext.getContext().resume().catch(() => {}), 300);
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
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
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
  if (state.motes) {
    state.motes.rotation.y += dt * 0.004;
    state.motes.position.y = Math.sin(clock.elapsedTime * 0.12) * 0.03;
  }
  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  // Zero-size resize events occur during headless runs and (per platform
  // research) around visionOS session transitions — never let them poison
  // the projection matrix with NaN.
  if (!innerWidth || !innerHeight) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function healProjection() {
  if (!Number.isFinite(camera.projectionMatrix.elements[0])) {
    const el = renderer.domElement;
    camera.aspect = (el.clientWidth || 16) / (el.clientHeight || 9);
    camera.updateProjectionMatrix();
  }
}

boot().catch((err) => {
  document.getElementById('hint').textContent = 'Could not load the gallery: ' + err.message;
});

// debug handle (harmless in production; used by the build's own tests)
window.NG = { state, teleportTo, toggleDocent, tickTeleport, hover, clock, camera, rig, scene, renderer };
