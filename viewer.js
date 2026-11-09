// Walkable viewer. three r169, WebGL2, everything vendored.
// Rendering recipe (baked Cycles diffuse, per-zone box-projected probes, half-res planar floor, glass, capsule walking,
// door octrees, Khronos PBR Neutral) comes from viewer/spike.html; numbers and reasons: docs/analysis/tech_spike.md.
// URL options: model=models/lite  q=tinggi|sedang|rendah  planar=0|1  scale=0.5..1  w= h= (fixed size)  test=1
//              spawn=<name>  specocc=0  lmfmt=exr|rgb9e5  glare=0|1
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Octree } from 'three/addons/math/Octree.js';
import { Capsule } from 'three/addons/math/Capsule.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const $ = (s) => document.querySelector(s);
const Q = new URLSearchParams(location.search);
const opt = {
  model: Q.get('model') || '',
  test: Q.get('test') === '1',
  w: parseInt(Q.get('w') || '0'), h: parseInt(Q.get('h') || '0'),
  lmfmt: Q.get('lmfmt') || '',
  specocc: Q.get('specocc') !== '0',
  spawn: Q.get('spawn') || '',
};
const TOUCH = Q.get('touch') === '1' || (Q.get('touch') !== '0' && matchMedia('(pointer: coarse)').matches);

// Phones drop requests, and a lost texture would otherwise stay blank until the page is reloaded.
async function retry(job, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    try { return await job(); } catch (error) {
      if (attempt === tries) throw error;
      await new Promise((done) => setTimeout(done, 500 * 2 ** attempt));
    }
  }
}
const plainFetch = window.fetch.bind(window);
window.fetch = (input, options) => retry(async () => {
  const response = await plainFetch(input instanceof Request ? input.clone() : input, options);
  if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
  // small files are read whole here, so a connection cut halfway through is retried too
  if (!response.ok || !/\.(ktx2|exr)(\?|$)/.test(input.url || input)) return response;
  return new Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: response.headers });
});

// ---------------------------------------------------------------- settings
const PRESETS = { tinggi: { scale: 1, planar: true }, sedang: { scale: 0.85, planar: true }, rendah: { scale: 0.7, planar: false } };
const S = { preset: 'tinggi', scale: 1, planar: true, glare: true, sens: 1, eye: 1.6, fov: 62, fps: false };
if (TOUCH) Object.assign(S, { preset: 'rendah', scale: 1, planar: false, glare: false });
if (!opt.test) try { Object.assign(S, JSON.parse(localStorage.getItem('demo_viewer') || '{}')); } catch { /* private mode */ }
if (Q.get('q') && PRESETS[Q.get('q')]) Object.assign(S, { preset: Q.get('q') }, PRESETS[Q.get('q')]);
if (Q.has('planar')) S.planar = Q.get('planar') !== '0';
if (Q.has('scale')) S.scale = parseFloat(Q.get('scale'));
if (Q.has('glare')) S.glare = Q.get('glare') !== '0';
const saveSettings = () => { if (!opt.test) try { localStorage.setItem('demo_viewer', JSON.stringify(S)); } catch { /* ignore */ } };

const ZONE_NAMES = { pel: 'R.Pelayanan', dok: 'R.Dokter', lobby: 'Lobby', porch: 'Teras & tangga', ext: 'Luar gedung' };
const DOOR_NAMES = { pel_s: 'Pintu R.Pelayanan', dok: 'Pintu R.Dokter', main: 'Pintu Utama', wc: 'Pintu Toilet' };
const CAM_NAMES = {
  CAM_p1_hero: 'Tampak depan', CAM_p3_aerial: 'Denah atas (potongan)', CAM_p4_entrance: 'Tangga masuk',
  CAM_p4_lobby: 'Lobby & resepsionis', CAM_p5_pelayanan: 'R.Pelayanan', CAM_p5_dokter_a: 'R.Dokter (a)',
  CAM_p5_dokter_b: 'R.Dokter (b)', CAM_p6_pelayanan: 'R.Pelayanan',
};
// Fallback spawn points, Blender plan coordinates (x, y, floor z, yaw: 0 = looking north/+Y, 90 = west), from spec.py.
const SPAWNS_demo = [
  { name: 'Jalan depan', b: [17.0, -3.06, -2.13], yaw: 90 },
  { name: 'Pintu masuk', b: [9.0, -3.06, 0], yaw: 90 },
  { name: 'Lobby/Resepsionis', b: [4.6, -4.6, 0], yaw: 8 },
  { name: 'R.Pelayanan', b: [1.75, 1.3, 0], yaw: -20 },
  { name: 'R.Dokter', b: [4.2, 1.2, 0], yaw: -100 },
];
// Exterior glass, as the Cycles materials in build/demo.blend have it (the GLB carries no glass values): tint per face, and an IOR
// well above 1.5, which is how the model gets its mirror-coated curtain wall. Not spec.MAT: its 'transmission' is not what renders.
const GLASS_SPEC = { M_GLASS_DRUM: { tint: [0.509, 0.691, 0.814], ior: 3.0 }, M_GLASS_DRUM_GF: { tint: [0.54, 0.59, 0.61], ior: 1.7 },
  M_GLASS_WING: { tint: [0.335, 0.519, 0.722], ior: 3.6 }, M_GLASS_TOWER: { tint: [0.698, 0.712, 0.684], ior: 2.1 }, M_GLASS_BAY: { tint: [0.591, 0.686, 0.757], ior: 2.6 } };
const f0Of = (ior) => ((ior - 1) / (ior + 1)) ** 2;
// Hidden in the viewer, Blender boxes: exterior.py's joint strips of pier W run on through the lobby, where that pier has no faces.
const CUT_BOXES = { M_ALU_LIGHT: [-2.05, -1.4, -13.62, -6.6, -0.7, 7.46] };
// Lightmap repair: the tower's one-sided floor at Z 7.45 sits just under the lobby ceiling, so the bake left these ceiling texels at 0.
// value = the texels next to the patch, read with __spike.pick(). Box in Blender coordinates.
const LM_PATCH = { M_PAINT_CEIL: { zone: 'lobby', box: [-4.5, -1.57, -13.7, -11.95, 7.4, 7.6], e: [0.301, 0.284, 0.32] } };
// Palm fronds that go through the lobby's SW wall into the hall, dropped at load (Blender box).
const TRI_CUT = { M_SITE_LEAF: [-5.95, -1.55, -13.62, -6.0, 0.05, 7.46] };
// The stair and the canopy run far east of the porch box, and box projection is meaningless for a point outside its box.
const PROBE_BOX_FIX = { porch: [7.73, 20.0, -9.3, 2.7, -2.2, 3.37] };
// Viewer corrections to the manifest's spawns: 'Pintu masuk' means the top of the stairs, outside the door (manifest: inside at X 6).
const SPAWN_FIX = { 'Pintu masuk': { b: [9.25, -3.06, 0], yaw: 90 } };
// Openings between zones, Blender boxes [x0, x1, y0, y1, z0, z1]. A portal with a door counts as open only while the door
// is open, but it is never closed for sight: the S door has glazed slots and a transom. box null = the whole indoor zone.
const PORTALS_demo = [
  { a: 'pel', b: 'dok', box: [3.45, 7.62, -0.05, 2.70, 0, 2.9], kind: 'wide' },                 // glass partition
  { a: 'pel', b: 'lobby', box: [0.95, 2.55, -0.26, 0.03, 0, 2.66], kind: 'slots', door: 'pel_s' },    // S double door, slots + transom
  { a: 'lobby', b: 'porch', box: [7.5, 7.95, -5.95, -0.40, -0.1, 3.45], kind: 'wide' },        // Pintu Utama + east glazing
  { a: 'lobby', b: 'ext', box: [-1.65, 8.75, -13.9, -6.6, -0.1, 7.6], kind: 'wide' },            // drum glazing
  { a: 'porch', b: 'ext', box: null, kind: 'wide', open: true },   // open air, and stairs and canopy reach well past the porch box
];

// ---------------------------------------------------------------- renderer
const canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
renderer.toneMapping = THREE.NeutralToneMapping;   // Blender's Khronos PBR Neutral view
renderer.toneMappingExposure = 1;
renderer.info.autoReset = false;
// The RX 550 is fill-bound, so opaque draws go front to back (three's default sorts by material first).
renderer.setOpaqueSort((a, b) => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder || a.z - b.z || a.id - b.id);
const gl = renderer.getContext();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(S.fov, 16 / 9, 0.08, 160);
camera.rotation.order = 'YXZ';
const viewW = () => opt.w || innerWidth, viewH = () => opt.h || innerHeight;

// ---------------------------------------------------------------- shader patches (spike.html, tech_spike 5.3 and 5.4)
const CHUNK_MAPS = /* glsl */`
#if defined( RE_IndirectDiffuse )
  #ifdef USE_LIGHTMAP
    vec3 lightMapIrradiance = texture2D( lightMap, vLightMapUv ).rgb;
    #ifdef USE_LM2
      lightMapIrradiance = mix( lightMapIrradiance, texture2D( uLightMap2, vLightMapUv ).rgb, uDoorT );
    #endif
    #ifdef USE_LMFIX
      if ( all( greaterThan( vWPos, uFixMin ) ) && all( lessThan( vWPos, uFixMax ) ) ) lightMapIrradiance = uFixE;
    #endif
    lightMapIrradiance *= lightMapIntensity;
    iblIrradiance += lightMapIrradiance;
  #elif defined( USE_ENVMAP ) && defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )
    iblIrradiance += getIBLIrradiance( geometryNormal );
  #endif
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  vec3 envRad = getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
  #if defined( USE_LIGHTMAP ) && defined( SPEC_OCC )
    float probeE = max( luminance( getIBLIrradiance( geometryNormal ) ), 1e-3 );
    envRad *= smoothstep( 0.0, 0.7, luminance( lightMapIrradiance ) / probeE );
  #endif
  #ifdef USE_PLANAR
    vec4 pc = uPlanarMat * vec4( vWPos, 1.0 );
    vec3 nW = inverseTransformDirection( geometryNormal, viewMatrix );
    vec2 puv = pc.xy / pc.w + nW.xz * uPlanarDistort;
    vec4 pr = textureLod( uPlanar, puv, 0.5 + 9.0 * material.roughness );
    envRad = pr.rgb + envRad * ( 1.0 - pr.a );
  #endif
  radiance += envRad;
#endif
`;
const CHUNK_ENV = /* glsl */`
#ifdef USE_ENVMAP
  vec3 boxProject( vec3 dirW ) {
    vec3 t1 = ( uBoxMax - vWPos ) / dirW;
    vec3 t2 = ( uBoxMin - vWPos ) / dirW;
    vec3 tm = max( t1, t2 );
    float t = min( min( tm.x, tm.y ), tm.z );
    return normalize( vWPos + dirW * t - uProbePos );
  }
  vec3 getIBLIrradiance( const in vec3 normal ) {
    vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
    vec4 envMapColor = textureCubeUV( envMap, envMapRotation * worldNormal, 1.0 );
    return PI * envMapColor.rgb * envMapIntensity;
  }
  vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
    vec3 reflectVec = reflect( - viewDir, normal );
    reflectVec = normalize( mix( reflectVec, normal, roughness * roughness ) );
    reflectVec = boxProject( inverseTransformDirection( reflectVec, viewMatrix ) );
    return textureCubeUV( envMap, envMapRotation * reflectVec, roughness ).rgb * envMapIntensity;
  }
#endif
`;
const emptyTex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
emptyTex.needsUpdate = true;
const planarU = { uPlanar: { value: emptyTex }, uPlanarMat: { value: new THREE.Matrix4() }, uPlanarDistort: { value: 0.035 } };

function patch(mat, zone, { planar = false, glass = false, lm2 = null, glassT = 0.92, glassF0 = 0.04, cut = null, fix = null } = {}) {
  mat.defines = mat.defines || {};
  if (opt.specocc) mat.defines.SPEC_OCC = '';
  if (planar) mat.defines.USE_PLANAR = '';
  if (glass) mat.defines.GLASS = '';
  if (lm2) mat.defines.USE_LM2 = '';
  if (cut) mat.defines.USE_CUT = '';
  if (fix) mat.defines.USE_LMFIX = '';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uBoxMin = { value: zone.boxMin };
    sh.uniforms.uBoxMax = { value: zone.boxMax };
    sh.uniforms.uProbePos = { value: zone.pos };
    Object.assign(sh.uniforms, planarU);
    if (lm2) { sh.uniforms.uLightMap2 = { value: lm2.tex }; sh.uniforms.uDoorT = lm2.t; }
    if (cut) { sh.uniforms.uCutMin = { value: cut[0] }; sh.uniforms.uCutMax = { value: cut[1] }; }
    if (fix) { sh.uniforms.uFixMin = { value: fix.min }; sh.uniforms.uFixMax = { value: fix.max }; sh.uniforms.uFixE = { value: fix.e }; }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = worldPosition.xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; uniform vec3 uBoxMin; uniform vec3 uBoxMax; uniform vec3 uProbePos;
        #ifdef USE_PLANAR
          uniform sampler2D uPlanar; uniform mat4 uPlanarMat; uniform float uPlanarDistort;
        #endif
        #ifdef USE_LM2
          uniform sampler2D uLightMap2; uniform float uDoorT;
        #endif
        #ifdef USE_CUT
          uniform vec3 uCutMin; uniform vec3 uCutMax;
        #endif
        #ifdef USE_LMFIX
          uniform vec3 uFixMin; uniform vec3 uFixMax; uniform vec3 uFixE;
        #endif`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        #ifdef USE_CUT
          if ( all( greaterThan( vWPos, uCutMin ) ) && all( lessThan( vWPos, uCutMax ) ) ) discard;
        #endif`)
      .replace('#include <envmap_physical_pars_fragment>', CHUNK_ENV)
      .replace('#include <lights_fragment_maps>', CHUNK_MAPS);
    if (glass) {
      // thin glass, same model as the Cycles material: reflects F, transmits (1 - F) * tint^2 (luminance 0.92)
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.specularColor = vec3( ${glassF0.toFixed(4)} );`).replace('#include <opaque_fragment>', `
        float glassF = F_Schlick( vec3( ${glassF0.toFixed(4)} ), 1.0, saturate( dot( normal, normalize( vViewPosition ) ) ) ).r;
        diffuseColor.a = 1.0 - ( 1.0 - glassF ) * ${glassT.toFixed(3)};
        #include <opaque_fragment>`);
    }
  };
  mat.customProgramCacheKey = () => `demo${+opt.specocc}${+planar}${+glass}${+!!lm2}${+!!cut}${+!!fix}${glassT}${glassF0}`;
  return mat;
}

// ---------------------------------------------------------------- loading with real progress
const progress = { items: new Map(), stage: '' };
function setProgress(key, loaded, total) {
  const it = progress.items.get(key) || { loaded: 0, total: 0 };
  it.loaded = loaded; if (total) it.total = total;
  progress.items.set(key, it);
  drawProgress();
}
function drawProgress(extra = 0) {
  let l = 0, t = 0;
  for (const it of progress.items.values()) { l += it.loaded; t += Math.max(it.total, it.loaded); }
  const f = t ? 0.85 * l / t : 0;
  progress.frac = Math.max(progress.frac || 0, Math.min(1, f + extra));
  $('#bar i').style.width = (progress.frac * 100).toFixed(1) + '%';
  $('#loadtxt').textContent = `${progress.stage} ${(l / 1048576).toFixed(0)} / ${(t / 1048576).toFixed(0)} MB`;
  logProgress(l, t);
}
const progressLog = [];
function logProgress(l, t) {
  const last = progressLog.at(-1);
  if (!last || progress.frac - last.frac >= 0.04 || progress.stage !== last.stage)
    progressLog.push({ ms: Math.round(performance.now()), frac: +progress.frac.toFixed(3), stage: progress.stage, mb: l === undefined ? null : [Math.round(l / 1048576), Math.round(t / 1048576)] });
}
function stage(txt, frac) {
  progress.stage = txt;
  if (frac !== undefined) progress.frac = Math.max(progress.frac || 0, frac);
  $('#bar i').style.width = ((progress.frac || 0) * 100).toFixed(1) + '%';
  $('#loadtxt').textContent = txt;
  logProgress();
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

const fetchBuf = (url, key, guess) => retry(async () => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const total = +r.headers.get('Content-Length') || progress.items.get(key)?.total || guess || 0;
  setProgress(key, 0, total);
  const reader = r.body.getReader();
  const parts = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); n += value.length;
    setProgress(key, n, total);
  }
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}, 3);

// .rgb9e5: 'LM95', width, height, levels (uint32), then every mip as packed GL_RGB9_E5, rows bottom-first
async function loadRGB9E5(url, key) {
  const buf = await fetchBuf(url, key, 22.4e6);
  const h = new Uint32Array(buf, 0, 4);
  if (h[0] !== 0x3539344c) throw new Error(url + ': not an LM95 file');
  let w = h[1], ht = h[2], off = 16;
  const mips = [];
  for (let i = 0; i < h[3]; i++) {
    mips.push({ data: new Uint32Array(buf, off, w * ht), width: w, height: ht });
    off += w * ht * 4;
    w = Math.max(1, w >> 1); ht = Math.max(1, ht >> 1);
  }
  const t = new THREE.DataTexture(mips[0].data, h[1], h[2], THREE.RGBFormat, THREE.UnsignedInt5999Type);
  t.mipmaps = mips;
  t.generateMipmaps = false;
  return t;
}
function loadEXR(url, key) {
  const l = new EXRLoader().setDataType(THREE.HalfFloatType);
  return new Promise((res, rej) => l.load(url, res, (e) => setProgress(key, e.loaded, e.total), rej));
}
function prepLightmap(tex) {
  tex.channel = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = !tex.mipmaps || tex.mipmaps.length === 0;
  tex.anisotropy = 4;
  tex.repeat.set(1, -1);      // glTF stores v as 1 - v, the lightmap rows are bottom-first
  tex.offset.set(0, 1);
  tex.needsUpdate = true;
  return tex;
}
const lmFile = (f) => opt.lmfmt ? f.replace(/\.(exr|rgb9e5)$/, '.' + opt.lmfmt) : f;
const loadLightmap = (url, key) => (url.endsWith('.rgb9e5') ? loadRGB9E5(url, key) : loadEXR(url, key)).then(prepLightmap);

function normManifest(m, base) {
  const name = base.replace(/\/$/, '').split('/').pop();
  const glbs = m.glb ? [].concat(m.glb) : m.glbs ? m.glbs.map((g) => g.file || g) : [name + '.glb'];
  let collider = m.collider || m.colliders || name + '_collider.glb';
  if (typeof collider === 'object') collider = collider.file || collider.static;
  return { raw: m, glbs, collider, atlases: m.atlases || [], probes: m.probes || [], doors: m.doors || [],
    cameras: m.cameras || [], spawns: m.spawns || [], lamps: m.lamps || null, dev: !!m.dev, sky: m.sky ? m.sky.file : null,
    sizes: new Map((m.files || []).map((f) => [f.path, f.bytes])) };
}

async function findModel() {
  for (const m of [opt.model, 'models/lite'].filter(Boolean)) {
    try { const r = await fetch(m + '/manifest.json', { cache: 'no-store' }); if (r.ok) return [m, await r.json()]; } catch { /* next */ }
  }
  throw new Error('Tidak ada model: models/lite/manifest.json belum ada.');
}

// ---------------------------------------------------------------- materials
const inheritKeys = ['zone', 'bake_group', 'lm', 'planar', 'glass', 'emissive', 'dynamic', 'plant', 'probe', 'ceiling', 'oneway'];
function props(o) {
  const out = {};
  for (let p = o; p; p = p.parent) for (const k of inheritKeys) if (p.userData && k in p.userData && !(k in out)) out[k] = p.userData[k];
  return out;
}
// 257k small triangles of leaves cost half the frame with the full PBR shader, and the plants have no lightmap anyway. Their
// own light model is one texture fetch: sky and ground ambient by normal plus the sun, in Cycles units (lighting.py), through-leaf 0.3.
const PLANT_U = { uAmbUp: { value: new THREE.Color(0.46, 0.52, 0.60).multiplyScalar(0.45) }, uAmbDn: { value: new THREE.Color(0.32, 0.30, 0.27).multiplyScalar(0.45) },
  uSunC: { value: new THREE.Color(1.36, 1.37, 1.25).multiplyScalar(0.27) }, uSunD: { value: new THREE.Vector3(0.453, 0.866, 0.211).normalize() } };
function plantMaterial(src) {
  const m = new THREE.MeshBasicMaterial({ map: src.map, color: src.color, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, PLANT_U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vNW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNW = normalize( mat3( modelMatrix ) * normal );');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        varying vec3 vNW; uniform vec3 uAmbUp; uniform vec3 uAmbDn; uniform vec3 uSunC; uniform vec3 uSunD;`)
      .replace('#include <opaque_fragment>', `
        vec3 nW = normalize( vNW ) * ( gl_FrontFacing ? 1.0 : -1.0 );
        float ndl = dot( nW, uSunD );
        outgoingLight = diffuseColor.rgb * ( mix( uAmbDn, uAmbUp, nW.y * 0.5 + 0.5 ) + uSunC * ( max( ndl, 0.0 ) + 0.3 * max( -ndl, 0.0 ) ) );
        #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'demoPlant';
  return m;
}
const matCache = new Map();
function makeMaterial(src, ud, zone, atlases, { planar, door }) {
  const key = [src.uuid, ud.zone, ud.probe, ud.bake_group, ud.lm, planar, ud.glass, ud.emissive, ud.oneway, door ? door.id : ''].join('|');
  if (matCache.has(key)) return matCache.get(key);
  let m;
  if (ud.plant && !atlases[ud.bake_group]) m = plantMaterial(src);
  else if (ud.emissive) {
    m = new THREE.MeshBasicMaterial({ color: src.emissive.clone().multiplyScalar(src.emissiveIntensity || 1),
      map: src.emissiveMap || null, side: src.side });
    if (m.color.getHex() === 0 && src.color) m.color.copy(src.color);
  } else if (ud.glass) {
    m = new THREE.MeshStandardMaterial({ color: 0, roughness: 0.03, metalness: 0, envMap: zone.env, transparent: true,
      depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation });
    m.name = src.name;
    // tinted glass: the transmission goes to its own multiply pass, this pass adds the reflection. Adding to display values overshoots
    // about 2x at these reflectances, so it screens: a + b (1 - a) stays close to the true encode(r + d) without a linear HDR pass.
    if (GLASS_SPEC[src.name]) m.blendDst = THREE.OneMinusSrcColorFactor;
    const gs = GLASS_SPEC[src.name];
    patch(m, zone, { glass: true, glassT: gs ? 1 : 0.92, glassF0: gs ? f0Of(gs.ior) : 0.04 });
  } else {
    m = src.clone();
    // walls are one-sided, inward facing. Thin things seen from both sides keep the glTF flag unless marked oneway.
    const thin = !ud.oneway && (src.alphaTest > 0 || src.transparent || ud.plant || door);
    m.side = thin ? src.side : THREE.FrontSide;
    m.forceSinglePass = true;       // otherwise three draws transparent double-sided meshes twice
    m.envMap = zone.env;
    m.envMapIntensity = 1;
    const atlas = ud.lm === 'none' ? null : atlases[ud.bake_group];
    let lm2 = null;
    if (atlas) {
      m.lightMap = atlas.tex;
      m.lightMapIntensity = Math.PI;   // Cycles stored E/pi, three divides by pi once more
      if (atlas.open && door) lm2 = { tex: atlas.open, t: door.uT };
    }
    for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap]) if (t) t.anisotropy = 8;
    let cut = null;
    if (ud.zone === 'ext' && CUT_BOXES[src.name]) { const [a, b] = b2t(CUT_BOXES[src.name]); cut = [a, b]; }
    let fix = null;
    const lp = LM_PATCH[src.name];
    if (lp && lp.zone === ud.zone) { const [a, b] = b2t(lp.box); fix = { min: a, max: b, e: new THREE.Vector3(...lp.e) }; }
    patch(m, zone, { planar, lm2, cut, fix });
  }
  matCache.set(key, m);
  return m;
}

// ---------------------------------------------------------------- world state
const W = {
  man: null, base: '', zones: {}, probes: {}, zoneList: [], meshes: [], planarMeshes: [], doors: [], doorsById: {}, doorMeshes: [],
  octree: null, occluder: null, lamps: [], bbox: new THREE.Box3(), portals: [], spawns: [], ready: false,
};

function triCount(g) { return (g.index ? g.index.count : g.attributes.position.count) / 3; }

// Big merged meshes span a whole zone, so frustum culling cannot drop them. Split them with a k-d tree over the triangle
// centres into cells that share the vertex buffers (no extra VRAM, one index buffer each), so culling works per cell.
function dropTriangles(mesh, b) {
  const g = mesh.geometry, p = g.attributes.position, ix = g.index;
  if (!ix) return 0;
  mesh.updateMatrixWorld();
  const [lo, hi] = b2t(b), box = new THREE.Box3(lo, hi), v = new THREE.Vector3();
  const keep = [];
  for (let t = 0; t < ix.count; t += 3) {
    let inside = false;
    for (let j = 0; j < 3 && !inside; j++) inside = box.containsPoint(v.fromBufferAttribute(p, ix.getX(t + j)).applyMatrix4(mesh.matrixWorld));
    if (!inside) keep.push(ix.getX(t), ix.getX(t + 1), ix.getX(t + 2));
  }
  const n = ix.count / 3 - keep.length / 3;
  if (n) g.setIndex(keep);
  return n;
}
function splitMesh(mesh, maxTris = 30000, maxDepth = 4) {
  const g = mesh.geometry, pos = g.attributes.position;
  const idx = g.index ? g.index.array : null;
  const nT = triCount(g);
  if (nT <= maxTris || g.groups.length > 1) return [mesh];
  mesh.updateMatrixWorld();
  const cx = new Float32Array(nT), cz = new Float32Array(nT);
  const v = new THREE.Vector3();
  const vi = (k) => (idx ? idx[k] : k);
  for (let t = 0; t < nT; t++) {
    v.set(0, 0, 0);
    for (let j = 0; j < 3; j++) { const i = vi(3 * t + j); v.x += pos.getX(i); v.y += pos.getY(i); v.z += pos.getZ(i); }
    v.multiplyScalar(1 / 3).applyMatrix4(mesh.matrixWorld);
    cx[t] = v.x; cz[t] = v.z;
  }
  const cells = [];
  const rec = (ids, depth) => {
    if (ids.length <= maxTris || depth >= maxDepth) { cells.push(ids); return; }
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const t of ids) { x0 = Math.min(x0, cx[t]); x1 = Math.max(x1, cx[t]); z0 = Math.min(z0, cz[t]); z1 = Math.max(z1, cz[t]); }
    const c = x1 - x0 > z1 - z0 ? cx : cz;
    const sorted = Array.from(ids).sort((p, q) => c[p] - c[q]);
    const h = sorted.length >> 1;
    rec(sorted.slice(0, h), depth + 1); rec(sorted.slice(h), depth + 1);
  };
  rec(Array.from({ length: nT }, (_, i) => i), 0);
  const out = [];
  const parent = mesh.parent;
  for (const ids of cells) {
    const L = new (pos.count > 65535 ? Uint32Array : Uint16Array)(ids.length * 3);
    const bb = new THREE.Box3();
    ids.forEach((t, k) => {
      for (let j = 0; j < 3; j++) { const i = vi(3 * t + j); L[3 * k + j] = i; bb.expandByPoint(v.fromBufferAttribute(pos, i)); }
    });
    const ng = new THREE.BufferGeometry();
    for (const k in g.attributes) ng.setAttribute(k, g.attributes[k]);
    ng.setIndex(new THREE.BufferAttribute(L, 1));
    ng.boundingBox = bb;
    ng.boundingSphere = bb.getBoundingSphere(new THREE.Sphere());
    const nm = new THREE.Mesh(ng, mesh.material);
    nm.name = mesh.name + '_c' + out.length;
    nm.position.copy(mesh.position); nm.quaternion.copy(mesh.quaternion); nm.scale.copy(mesh.scale);
    nm.userData = { ...mesh.userData, rv: { ...mesh.userData.rv } };
    nm.renderOrder = mesh.renderOrder;
    parent.add(nm);
    out.push(nm);
  }
  parent.remove(mesh);
  return out;
}

// ---------------------------------------------------------------- load
async function load() {
  stage('Membaca daftar file…', 0.01);
  const [base, raw] = await findModel();
  const man = normManifest(raw, base);
  W.man = man; W.base = base;
  const url = (f) => base + '/' + f;

  // textures come through the GLB, so they are counted as they finish transcoding, weighted with the role total of the manifest
  const texBytes = man.raw.budgets?.bytes_by_role?.texture || 0;
  const ktx2 = new KTX2Loader().setTranscoderPath('vendor/addons/libs/basis/').detectSupport(renderer);
  const ktxLoad = ktx2.load.bind(ktx2);
  let texAll = 0, texDone = 0;
  ktx2.load = (u, ok, pr, er) => {
    texAll++;
    return ktxLoad(u, (t) => { texDone++; setProgress('tex', texBytes * texDone / texAll, texBytes); ok(t); }, pr, er);
  };
  const draco = new DRACOLoader().setDecoderPath('vendor/addons/libs/draco/gltf/');
  const gltfLoader = new GLTFLoader().setKTX2Loader(ktx2).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  const loadGLB = (f, key) => retry(() => new Promise((res, rej) => gltfLoader.load(url(f), res, (e) => setProgress(key, e.loaded, e.total), rej)), 3);

  stage('Mengunduh model, peta cahaya dan probe…');
  const size = (f, guess) => man.sizes.get(f) || guess;
  for (const f of man.glbs) setProgress('glb:' + f, 0, size(f, 60e6));
  for (const a of man.atlases) setProgress('lm:' + a.group, 0, size(lmFile(a.file), 22.4e6));
  for (const p of man.probes) if (p.file) setProgress('pr:' + (p.name || p.zone), 0, size(p.file, 3e6));
  for (const a of man.atlases) if (a.open_file) setProgress('lm2:' + a.group, 0, size(lmFile(a.open_file), 22.4e6));
  if (texBytes) setProgress('tex', 0, texBytes);
  const t0 = performance.now();
  const [gltfs, colG, atlasL, probeL, skyTex] = await Promise.all([
    Promise.all(man.glbs.map((f) => loadGLB(f, 'glb:' + f))),
    loadGLB(man.collider, 'col'),
    Promise.all(man.atlases.map((a) => Promise.all([
      loadLightmap(url(lmFile(a.file)), 'lm:' + a.group),
      a.open_file ? loadLightmap(url(lmFile(a.open_file)), 'lm2:' + a.group) : null]))),
    Promise.all(man.probes.map((p) => (p.file ? loadEXR(url(p.file), 'pr:' + (p.name || p.zone)) : null))),
    man.sky ? loadEXR(url(man.sky), 'sky') : null,
  ]);
  W.loadMs = { download: Math.round(performance.now() - t0) };

  stage('Menyiapkan probe pantulan…', 0.86); await nextFrame();
  const pmrem = new THREE.PMREMGenerator(renderer);
  let roomEnv = null;
  const getRoomEnv = () => roomEnv || (roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture);
  man.probes.forEach((p, i) => {
    const a = p.boxA ? new THREE.Vector3(...p.boxA) : new THREE.Vector3(-1e3, -1e3, -1e3);
    const b = p.boxB ? new THREE.Vector3(...p.boxB) : new THREE.Vector3(1e3, 1e3, 1e3);
    let env;
    if (probeL[i]) { probeL[i].mapping = THREE.EquirectangularReflectionMapping; env = pmrem.fromEquirectangular(probeL[i]).texture; probeL[i].dispose(); }
    else env = getRoomEnv();
    const pr = { name: p.name || p.zone, env, pos: new THREE.Vector3(...p.pos), boxMin: a.clone().min(b), boxMax: a.clone().max(b) };
    W.probes[pr.name] = pr;
    const z = W.zones[p.zone];     // a zone may hold two probes (lobby, lobby_up): its box is the union
    if (z) { z.boxMin.min(pr.boxMin); z.boxMax.max(pr.boxMax); }
    else W.zones[p.zone] = { name: p.zone, pos: pr.pos, boxMin: pr.boxMin.clone(), boxMax: pr.boxMax.clone() };
  });
  if (!Object.keys(W.probes).length) {
    const big = { name: '', env: getRoomEnv(), pos: new THREE.Vector3(0, 1.4, 0),
      boxMin: new THREE.Vector3(-1e3, -1e3, -1e3), boxMax: new THREE.Vector3(1e3, 1e3, 1e3) };
    W.probes[''] = big; W.zones[''] = big;
  }
  for (const n in PROBE_BOX_FIX) if (W.probes[n]) {
    const [a, b] = b2t(PROBE_BOX_FIX[n]);
    W.probes[n].boxMin.copy(a); W.probes[n].boxMax.copy(b);
  }
  // Outdoors the reflection is the sky at infinity. The ext probe cannot give it: it was captured under the entrance canopy, so
  // its upper half is soffit. fromScene gives the same PMREM size as the 1024 probes, so envMap can be swapped without a recompile.
  if (skyTex) {
    skyTex.mapping = THREE.EquirectangularReflectionMapping;
    const sc = new THREE.Scene(); sc.background = skyTex;
    const far = 1e6, near = new THREE.Vector3(-far, -far, -far), big = new THREE.Vector3(far, far, far);
    const env = pmrem.fromScene(sc, 0, 0.1, 100).texture;
    W.probes.sky = { name: 'sky', env, pos: new THREE.Vector3(), boxMin: near, boxMax: big };
    // ext glass is seen from both sides: it shows the sky from outside and the lobby from inside. Shared uniforms, changed in setExtGlass().
    W.probes.extGlass = { name: 'extGlass', env, pos: new THREE.Vector3(), boxMin: near.clone(), boxMax: big.clone() };
  }
  pmrem.dispose();
  // smallest box first, so R.Dokter wins over R.Pelayanan and the porch over the lobby
  W.zoneList = Object.values(W.zones).sort((p, q) => vol(p) - vol(q));
  const atlases = {};
  man.atlases.forEach((a, i) => { atlases[a.group] = { tex: atlasL[i][0], open: atlasL[i][1] }; });
  // a door's open pose can also come as its own atlas <group>_open with the same UV_LM
  for (const g in atlases) if (g.endsWith('_open') && atlases[g.slice(0, -5)]) atlases[g.slice(0, -5)].open = atlases[g].tex;

  stage('Menyusun bangunan…', 0.88); await nextFrame();
  const root = new THREE.Group();
  root.name = 'world';
  for (const g of gltfs) root.add(g.scene);
  scene.add(root);
  root.updateMatrixWorld(true);
  setupDoors(root, man);
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const o of meshes) {
    const ud = props(o);
    const door = doorOf(o);
    // a material with transmission would make three render every opaque object a second time, so it must become our thin glass
    if (!ud.glass && (o.material.transmission > 0 || (door && /GLASS_CLEAR/i.test(o.material.name || '')))) ud.glass = 1;
    let zone = W.probes[ud.probe] || W.probes[ud.zone] || Object.values(W.probes).at(-1);
    if (W.probes.sky && (ud.probe || ud.zone) === 'ext') zone = ud.glass ? W.probes.extGlass : W.probes.sky;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    // one mirror plane per frame at y = 0 (tech_spike 5.4): floors at other heights use the probe only
    const planar = !!ud.planar && Math.abs(bb.max.y) < 0.03 && Math.abs(bb.min.y) < 0.03;
    o.userData.srcMat = o.material.name;
    o.material = makeMaterial(o.material, ud, zone, atlases, { planar, door });
    if (ud.glass) o.renderOrder = 10;
    o.matrixAutoUpdate = !!door;
    o.userData.rv = { zone: ud.zone || '', planar, glass: !!ud.glass, emissive: !!ud.emissive, door, plant: !!ud.plant,
      ceiling: !!ud.ceiling, ext: ud.zone === 'ext', extGlass: zone === W.probes.extGlass, tris: triCount(o.geometry) };
    if (door) door.meshes.push(o);
  }
  const all = [];
  const tints = {};
  W.droppedTris = 0;
  for (const o of meshes) {
    const rv = o.userData.rv;
    const srcName = o.userData.srcMat;
    if (TRI_CUT[srcName]) { W.droppedTris += dropTriangles(o, TRI_CUT[srcName]); rv.tris = triCount(o.geometry); }
    if (!rv.door && !rv.glass) all.push(...splitMesh(o));
    else all.push(o);
    if (rv.glass && GLASS_SPEC[o.material.name]) {     // multiply pass first (renderOrder 9), reflection after it (10)
      const nm = o.material.name;
      const t = new THREE.Mesh(o.geometry, tints[nm] || (tints[nm] = tintMaterial(nm)));
      t.name = o.name + '_tint';
      t.position.copy(o.position); t.quaternion.copy(o.quaternion); t.scale.copy(o.scale);
      t.renderOrder = 9;
      t.userData = { rv: { ...rv, extGlass: false } };
      t.matrixAutoUpdate = false; t.updateMatrix();
      o.parent.add(t);
      all.push(t);
    }
  }
  root.updateMatrixWorld(true);
  for (const o of all) {
    o.updateMatrixWorld(true);
    const rv = o.userData.rv;
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    rv.sphere = o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld);
    rv.tris = triCount(o.geometry);
    if (!rv.glass && o.geometry.boundingSphere.radius > 3.5) o.renderOrder = 1;   // shells last: furniture in front fills early-z
    W.bbox.union(new THREE.Box3().setFromObject(o));
    if (rv.planar) W.planarMeshes.push(o);
  }
  W.meshes = all;
  W.doorMeshes = W.doors.flatMap((d) => d.meshes);

  stage('Membangun tabrakan…', 0.9); await nextFrame();
  setupColliders(colG.scene);
  setupPortals();
  setupSpawns(man);
  setupLamps(man, all);
  initPlanar();
  buildSky(skyTex);
  stage('Menyusun shader…', 0.92); await nextFrame();
  const tc = performance.now();
  await precompile();
  W.loadMs.compile = Math.round(performance.now() - tc);
  stage('Mengunggah tekstur ke GPU…', 0.95); await nextFrame();
  const tu = performance.now();
  uploadTextures(atlases);
  warmAll();
  W.loadMs.upload = Math.round(performance.now() - tu);
  stage('Menggambar peta…', 0.98); await nextFrame();
  buildMinimap();
  W.loadMs.total = Math.round(performance.now() - t0);
  W.stats = { meshes: all.length, tris: all.reduce((s, o) => s + o.userData.rv.tris, 0), atlases: man.atlases.length,
    probes: man.probes.filter((p) => p.file).length, doors: W.doors.length, lamps: W.lamps.length, model: base, dev: man.dev, flippedColliders: W.flipped, droppedTris: W.droppedTris, quality: man.raw.quality };
}
const vol = (z) => (z.boxMax.x - z.boxMin.x) * (z.boxMax.y - z.boxMin.y) * (z.boxMax.z - z.boxMin.z);

// ---------------------------------------------------------------- doors
function setupDoors(root, man) {
  const nodes = [];
  root.traverse((o) => { if (!o.isMesh && /^DOOR_/.test(o.name) && o.userData.door_id !== undefined) nodes.push(o); });
  for (const d of man.doors) {
    const n = root.getObjectByName(d.node || d.hinge);
    if (n && !nodes.includes(n)) { if (n.userData.door_id === undefined) n.userData.door_id = d.id; nodes.push(n); }
  }
  for (const n of nodes) {
    const u = n.userData;
    const md = man.doors.find((d) => (d.node || d.hinge) === n.name) || {};
    let slide = null;
    if (md.slide) slide = new THREE.Vector3(...md.slide);                         // manifest: three coordinates
    else if (u.door_slide) slide = new THREE.Vector3(u.door_slide[0], u.door_slide[2] || 0, -u.door_slide[1]);   // Blender extras
    const type = md.type || u.door_type || (slide ? 'slide' : 'hinge');
    const d = { id: String(u.door_id ?? md.id), node: n, type, slide,
      openDeg: md.openDeg ?? md.open_deg ?? u.door_open_deg ?? 90, speed: md.speed ?? u.door_speed ?? 1.6,
      locked: !!(md.locked ?? u.door_locked), t: 0, target: 0, uT: { value: 0 }, meshes: [], cols: [],
      pos0: n.position.clone(), quat0: n.quaternion.clone(), pivot: new THREE.Vector3().setFromMatrixPosition(n.matrixWorld),
      closed: null, open: null, rattle: 0 };
    if (md.initial === 'open' || md.open === true) d.t = d.target = 1;
    W.doors.push(d);
    (W.doorsById[d.id] = W.doorsById[d.id] || []).push(d);
  }
}
function doorOf(o) {
  for (let p = o; p; p = p.parent) { const d = W.doors.find((x) => x.node === p); if (d) return d; }
  return null;
}
const _q = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0);
function poseDoor(d) {
  const e = d.t * d.t * (3 - 2 * d.t);
  if (d.type === 'slide') d.node.position.copy(d.pos0).addScaledVector(d.slide, e);
  else {
    const r = THREE.MathUtils.degToRad(d.openDeg) * e + (d.rattle ? Math.sin(d.rattle * 40) * 0.012 * d.rattle : 0);
    d.node.quaternion.copy(_q.setFromAxisAngle(_Y, r)).multiply(d.quat0);
  }
  d.uT.value = e;
  d.node.updateMatrixWorld(true);
}
function updateDoors(dt) {
  for (const d of W.doors) {
    if (d.rattle > 0) { d.rattle = Math.max(0, d.rattle - dt * 2.2); poseDoor(d); }
    if (d.t === d.target) continue;
    const s = dt * d.speed;
    d.t = d.target > d.t ? Math.min(d.target, d.t + s) : Math.max(d.target, d.t - s);
    poseDoor(d);
  }
}
const doorTree = (d) => (d.t < 0.5 ? d.closed : d.open);

// ---------------------------------------------------------------- colliders
// Octree pushes along the triangle normal, so an inside-out collider lets the player through its top face and
// stops them on the inside of its bottom face. Closed colliders are turned the right way out here.
function fixWinding(o) {
  const g = o.geometry, p = g.attributes.position, ix = g.index;
  if (!ix) return 0;
  const P = [];
  const cen = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { P.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld)); cen.add(P[i]); }
  cen.multiplyScalar(1 / p.count);
  const n = new THREE.Vector3(), e = new THREE.Vector3(), flips = [];
  let convex = true, top = -1e9, topDown = false;
  for (let t = 0; t < ix.count; t += 3) {
    const a = P[ix.getX(t)], b = P[ix.getX(t + 1)], c = P[ix.getX(t + 2)];
    n.subVectors(b, a).cross(e.subVectors(c, a));
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    const cy = (a.y + b.y + c.y) / 3;
    if (Math.abs(n.y) > 0.5 && cy > top) { top = cy; topDown = n.y < 0; }
    let d = n.dot(a);
    if (n.dot(cen) > d) { flips.push(t); n.negate(); d = -d; }
    if (convex) for (const v of P) if (n.dot(v) - d > 0.002) { convex = false; break; }
  }
  // convex (box, wedge): every face outwards. Otherwise only turn the whole mesh if its top face looks down.
  const list = convex ? flips : (topDown ? Array.from({ length: ix.count / 3 }, (_, i) => 3 * i) : []);
  for (const t of list) { const k = ix.getX(t + 1); ix.setX(t + 1, ix.getX(t + 2)); ix.setX(t + 2, k); }
  return list.length;
}
function setupColliders(col) {
  col.updateMatrixWorld(true);
  const doorCols = [], glassCols = [];
  W.flipped = [];
  col.traverse((o) => {
    if (!o.isMesh) return;
    const nf = fixWinding(o); if (nf) W.flipped.push(`${o.name}:${nf}`);
    if (o.userData.door_id !== undefined) doorCols.push(o);
    else if (/glass/i.test(o.name)) glassCols.push(o);
  });
  const toWorld = (o) => new THREE.Mesh(o.geometry.clone().applyMatrix4(o.matrixWorld));
  W.colSlice = [];
  col.traverse((o) => { if (o.isMesh) W.colSlice.push(toWorld(o)); });
  for (const o of doorCols) o.removeFromParent();
  W.octree = new Octree().fromGraphNode(col);
  // glare occluder: the same walls without glass, so lamps stay visible through the partition and the drum
  for (const o of glassCols) o.removeFromParent();
  W.occluder = new Octree().fromGraphNode(col);
  for (const c of doorCols) {
    const cand = W.doorsById[String(c.userData.door_id)] || [];
    const wm = toWorld(c);
    wm.geometry.computeBoundingBox();
    const cc = wm.geometry.boundingBox.getCenter(new THREE.Vector3());
    let best = null, bd = 1e9;
    for (const d of cand) { const dd = Math.hypot(d.pivot.x - cc.x, d.pivot.z - cc.z); if (dd < bd) { bd = dd; best = d; } }
    if (best) best.cols.push(wm);
  }
  for (const d of W.doors) {
    if (!d.cols.length) continue;
    const g = new THREE.Group();
    for (const m of d.cols) g.add(m.clone());
    d.closed = new Octree().fromGraphNode(g);
    const og = new THREE.Group(), inner = new THREE.Group();
    if (d.type === 'slide') og.position.copy(d.slide);
    else {
      og.position.copy(d.pivot);
      og.quaternion.setFromAxisAngle(_Y, THREE.MathUtils.degToRad(d.openDeg));
      inner.position.copy(d.pivot).negate();
    }
    for (const m of d.cols) inner.add(m.clone());
    og.add(inner);
    d.open = new Octree().fromGraphNode(og);
    d.glass = d.meshes.some((m) => m.userData.rv.glass);
  }
  for (const d of W.doors) if (d.t) poseDoor(d);
}

// ---------------------------------------------------------------- zones and portals
const b2t = (b) => [new THREE.Vector3(b[0], b[4], -b[3]), new THREE.Vector3(b[1], b[5], -b[2])];   // Blender box -> three min/max
function setupPortals() {
  const z = W.zones;
  W.portalsOn = ['pel', 'dok', 'lobby', 'porch', 'ext'].every((k) => z[k]);
  if (!W.portalsOn) return;
  for (const p of PORTALS_demo) {
    let box;
    if (p.box) { const [a, b] = b2t(p.box); box = new THREE.Box3(a, b); }
    else { const inner = p.a === 'ext' ? z[p.b] : z[p.a]; box = new THREE.Box3(inner.boxMin.clone(), inner.boxMax.clone()); }
    W.portals.push({ ...p, box3: box });
  }
}
function zoneAt(p) {
  for (const z of W.zoneList) {
    if (p.x >= z.boxMin.x - 0.02 && p.x <= z.boxMax.x + 0.02 && p.z >= z.boxMin.z - 0.02 && p.z <= z.boxMax.z + 0.02 &&
        p.y >= z.boxMin.y - 0.8 && p.y <= z.boxMax.y + 0.3) return z.name;
  }
  return W.zoneList.length ? W.zoneList[W.zoneList.length - 1].name : '';
}

// Which zones can be seen, and through which part of the screen. Each portal in view narrows the frustum to its
// screen rectangle; meshes of the next zone must touch one of those frustums.
const VIS = { cam: '', zones: new Map(), planarZones: new Set() };
const _pv = new THREE.Matrix4(), _S = new THREE.Matrix4(), _M = new THREE.Matrix4(), _v4 = new THREE.Vector4();
const frPool = []; let frUsed = 0;
const _cn = Array.from({ length: 8 }, () => new THREE.Vector4());
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
// Screen rectangle of a box, clipped at the camera plane. null when the whole box is behind the camera.
function rectOf(box) {
  const W0 = 0.02;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, any = false;
  const add = (x, y, w) => { x /= w; y /= w; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); any = true; };
  for (let i = 0; i < 8; i++) {
    const c = _cn[i].set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z, 1).applyMatrix4(_pv);
    if (c.w > W0) add(c.x, c.y, c.w);
  }
  for (const [i, j] of EDGES) {
    const a = _cn[i], b = _cn[j];
    if ((a.w > W0) !== (b.w > W0)) { const t = (W0 - a.w) / (b.w - a.w); add(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, W0); }
  }
  return any ? [x0, y0, x1, y1] : null;
}
function frustumOf(r) {
  const f = frPool[frUsed] || (frPool[frUsed] = new THREE.Frustum());
  frUsed++;
  const sx = 2 / (r[2] - r[0]), sy = 2 / (r[3] - r[1]);
  _S.set(sx, 0, 0, -(r[2] + r[0]) / (r[2] - r[0]), 0, sy, 0, -(r[3] + r[1]) / (r[3] - r[1]), 0, 0, 1, 0, 0, 0, 0, 1);
  return f.setFromProjectionMatrix(_M.multiplyMatrices(_S, _pv));
}
function computeVisibility(cam) {
  cam.updateMatrixWorld();
  _pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  VIS.cam = zoneAt(cam.position);
  VIS.zones.clear(); VIS.planarZones.clear(); frUsed = 0;
  if (!W.portalsOn || clipActive) { VIS.all = true; return; }
  VIS.all = false;
  const FULL = { rect: [-1, -1, 1, 1], fr: null };
  VIS.zones.set(VIS.cam, [FULL]);
  if (VIS.cam !== 'ext') VIS.planarZones.add(VIS.cam);
  const queue = [{ z: VIS.cam, e: FULL, depth: 0 }];
  while (queue.length) {
    const { z, e, depth } = queue.shift();
    for (const p of W.portals) {
      if (p.a !== z && p.b !== z) continue;
      const other = p.a === z ? p.b : p.a;
      const list = VIS.zones.get(other);
      if (list && list.some((x) => !x.fr)) continue;
      let kind = p.kind;
      if (p.door && (W.doorsById[p.door] || []).some((d) => d.t > 0.02)) kind = 'wide';
      const r = p.open ? e.rect : rectOf(p.box3);
      if (!r) continue;
      const rr = [Math.max(r[0], e.rect[0]), Math.max(r[1], e.rect[1]), Math.min(r[2], e.rect[2]), Math.min(r[3], e.rect[3])];
      if (rr[0] >= rr[2] || rr[1] >= rr[3]) continue;
      const ent = { rect: rr, fr: (rr[0] <= -1 && rr[1] <= -1 && rr[2] >= 1 && rr[3] >= 1) ? null : frustumOf(rr) };
      if (list) list.push(ent); else VIS.zones.set(other, [ent]);
      if (depth === 0 && kind === 'wide' && other !== 'ext') VIS.planarZones.add(other);
      if (depth < 3) queue.push({ z: other, e: ent, depth: depth + 1 });
    }
  }
}
const slotsOnly = () => W.portalsOn && (VIS.cam === 'pel' || VIS.cam === 'dok') && !(W.doorsById.pel_s || []).some((d) => d.t > 0.02);
function meshVisible(rv) {
  if (VIS.all || !rv.zone || rv.door) return true;
  const list = VIS.zones.get(rv.zone);
  if (!list) return false;
  for (const e of list) if (!e.fr || e.fr.intersectsSphere(rv.sphere)) return true;
  return false;
}
function applyVisibility(pass) {
  for (const o of W.meshes) {
    const rv = o.userData.rv;
    if (pass === 'main') o.visible = meshVisible(rv) && !(clipActive && rv.ceiling) && !(rv.plant && slotsOnly()) && !(W.hideTest && W.hideTest(rv, o));
    else if (rv.planar || rv.plant) o.visible = false;
    else if (VIS.all) o.visible = !rv.ext;
    else if (rv.door || rv.zone === VIS.cam) o.visible = !rv.ext;
    else o.visible = VIS.planarZones.has(rv.zone) && rv.sphere.radius > 1.5 && meshVisible(rv);     // a neighbouring room is small in the floor
  }
}

let extGlassIn = null;
function setExtGlass() {
  const g = W.probes.extGlass;
  if (!g || !W.zones.lobby) return;
  const inside = VIS.cam === 'lobby';
  if (inside === extGlassIn) return;
  extGlassIn = inside;
  const src = inside ? W.probes.lobby : W.probes.sky;
  g.pos.copy(src.pos); g.boxMin.copy(src.boxMin); g.boxMax.copy(src.boxMax);
  for (const o of W.meshes) if (o.userData.rv.extGlass) o.material.envMap = src.env;
}

// ---------------------------------------------------------------- planar reflection (Reflector maths, half res)
const planar = { rt: null, cam: new THREE.PerspectiveCamera(), on: false };
function initPlanar() {
  if (!W.planarMeshes.length) return;
  const s = renderer.getDrawingBufferSize(new THREE.Vector2());
  planar.rt = new THREE.WebGLRenderTarget(Math.max(2, Math.round(s.x * 0.5)), Math.max(2, Math.round(s.y * 0.5)), {
    type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter, samples: 0, depthBuffer: true, stencilBuffer: false });
}
function resizePlanar() {
  if (!planar.rt) return;
  const s = renderer.getDrawingBufferSize(new THREE.Vector2());
  planar.rt.setSize(Math.max(2, Math.round(s.x * 0.5)), Math.max(2, Math.round(s.y * 0.5)));
}
const _n = new THREE.Vector3(0, 1, 0), _p0 = new THREE.Vector3(), _cw = new THREE.Vector3(), _rot = new THREE.Matrix4();
const _look = new THREE.Vector3(), _view = new THREE.Vector3(), _tgt = new THREE.Vector3();
const _plane = new THREE.Plane(), _clip = new THREE.Vector4(), _qv = new THREE.Vector4();
function renderPlanar(cam) {
  planarU.uPlanar.value = emptyTex;
  planar.on = false;
  if (!planar.rt || !S.planar || mode === 'fly') return;
  _cw.setFromMatrixPosition(cam.matrixWorld);
  if (_cw.y <= 0.05) return;
  if (!W.planarMeshes.some((m) => meshVisible(m.userData.rv))) return;
  const vc = planar.cam;
  _view.subVectors(_p0, _cw).reflect(_n).negate().add(_p0);
  _rot.extractRotation(cam.matrixWorld);
  _look.set(0, 0, -1).applyMatrix4(_rot).add(_cw);
  _tgt.subVectors(_p0, _look).reflect(_n).negate().add(_p0);
  vc.position.copy(_view);
  vc.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_n);
  vc.lookAt(_tgt);
  vc.near = cam.near; vc.far = cam.far;
  vc.updateMatrixWorld();
  vc.projectionMatrix.copy(cam.projectionMatrix);
  planarU.uPlanarMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
    .multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
  _plane.setFromNormalAndCoplanarPoint(_n, _p0).applyMatrix4(vc.matrixWorldInverse);
  _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
  const pm = vc.projectionMatrix.elements;
  _qv.x = (Math.sign(_clip.x) + pm[8]) / pm[0];
  _qv.y = (Math.sign(_clip.y) + pm[9]) / pm[5];
  _qv.z = -1;
  _qv.w = (1 + pm[10]) / pm[14];
  _clip.multiplyScalar(2 / _clip.dot(_qv));
  pm[2] = _clip.x; pm[6] = _clip.y; pm[10] = _clip.z + 1; pm[14] = _clip.w;
  applyVisibility('planar');
  sky.visible = false; glare.mesh.visible = false;
  renderer.setRenderTarget(planar.rt);
  renderer.setClearColor(0, 0);
  renderer.clear();
  renderer.render(scene, vc);
  renderer.setRenderTarget(null);
  planarU.uPlanar.value = planar.rt.texture;
  planar.on = true;
}

// ---------------------------------------------------------------- sky (drawn after the opaques, only where nothing is)
let sky;
function buildSky(tex) {
  if (tex) { tex.wrapS = THREE.RepeatWrapping; tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true; }
  // the exported Cycles sky when there is one (linear HDR, so tone mapped like the scene), else a plain gradient
  const common = { side: THREE.BackSide, depthWrite: false,
    vertexShader: `varying vec3 vD; void main() { vD = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }` };
  const mat = tex ? new THREE.ShaderMaterial({ ...common, uniforms: { uSky: { value: tex } },
    fragmentShader: `#include <common>
      varying vec3 vD; uniform sampler2D uSky;
      void main() {
        gl_FragColor = vec4(texture2D(uSky, equirectUv(normalize(vD))).rgb, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` }) : new THREE.ShaderMaterial({ ...common, uniforms: {
      uTop: { value: new THREE.Color(0.27, 0.47, 0.76) }, uHor: { value: new THREE.Color(0.80, 0.87, 0.93) },
      uGnd: { value: new THREE.Color(0.36, 0.37, 0.36) } },
    fragmentShader: `varying vec3 vD; uniform vec3 uTop, uHor, uGnd;
      void main() { float h = normalize(vD).y;
        vec3 c = h > 0.0 ? mix(uHor, uTop, pow(h, 0.6)) : mix(uHor, uGnd, pow(-h, 0.35));
        gl_FragColor = vec4(c, 1.0); }` });
  sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  sky.renderOrder = 999; sky.frustumCulled = false; sky.name = 'sky';
  scene.add(sky);
}

// ---------------------------------------------------------------- downlight glare (star sprites like the AFTER renders)
const normCol = (c) => c.multiplyScalar(1 / Math.max(c.r, c.g, c.b, 1e-3));
const glare = { mesh: null, vis: null, tgt: null, n: 0, idx: 0 };
function setupLamps(man, meshes) {
  const lamps = [];
  if (man.lamps) for (const l of man.lamps) lamps.push({ pos: new THREE.Vector3(...l.pos), zone: l.zone || '',
    col: normCol(new THREE.Color(...(l.color || [1, 0.85, 0.7]))), r: l.r || 0.05 });
  else {
    // lens centres from the merged EM_ meshes: small flat clusters facing down
    const v = new THREE.Vector3();
    for (const o of meshes) {
      const rv = o.userData.rv;
      if (!rv.emissive || rv.door) continue;
      const g = o.geometry, pos = g.attributes.position, n = pos.count;
      const par = new Int32Array(n).map((_, i) => i);
      const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
      const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
      const seen = new Map();
      for (let i = 0; i < n; i++) {
        const k = `${Math.round(pos.getX(i) * 500)},${Math.round(pos.getY(i) * 500)},${Math.round(pos.getZ(i) * 500)}`;
        if (seen.has(k)) uni(i, seen.get(k)); else seen.set(k, i);
      }
      const idx = g.index ? g.index.array : null;
      const nT = triCount(g);
      for (let t = 0; t < nT; t++) { const a = idx ? idx[3 * t] : 3 * t; uni(a, idx ? idx[3 * t + 1] : 3 * t + 1); uni(a, idx ? idx[3 * t + 2] : 3 * t + 2); }
      const boxes = new Map();
      for (let i = 0; i < n; i++) {
        const r = find(i);
        if (!boxes.has(r)) boxes.set(r, new THREE.Box3());
        boxes.get(r).expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld));
      }
      const c = o.material.color ? o.material.color.clone() : new THREE.Color(1, 1, 1);
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      if (lum < 2) continue;                       // dim emitters (signage, displays) get no glare
      for (const b of boxes.values()) {
        const s = b.getSize(v);
        if (Math.max(s.x, s.z) > 0.32 || s.y > 0.06 || Math.max(s.x, s.z) < 0.02) continue;
        lamps.push({ pos: b.getCenter(new THREE.Vector3()), zone: rv.zone, col: c.clone().multiplyScalar(1 / Math.max(c.r, c.g, c.b)),
          r: Math.max(s.x, s.z) / 2, lum });
      }
    }
  }
  for (const l of lamps) l.pos.y -= l.r;      // the lens is recessed: the glare belongs at the mouth of the fitting
  W.lamps = lamps;
  const n = lamps.length;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const ip = new Float32Array(n * 3), ic = new Float32Array(n * 3);
  lamps.forEach((l, i) => { l.pos.toArray(ip, 3 * i); l.col.toArray(ic, 3 * i); });
  geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(ip, 3));
  geo.setAttribute('iCol', new THREE.InstancedBufferAttribute(ic, 3));
  glare.vis = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  glare.vis.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iVis', glare.vis);
  geo.instanceCount = n;
  glare.tgt = new Float32Array(n);
  glare.n = n;
  glare.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms: { uRes: { value: new THREE.Vector2(1920, 1080) }, uScale: { value: 470 }, uGain: { value: 1 } },
    vertexShader: `attribute vec3 iPos; attribute vec3 iCol; attribute float iVis; uniform vec2 uRes; uniform float uScale;
      varying vec2 vUv; varying vec3 vCol; varying float vVis;
      void main() {
        vec4 c = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
        float px = clamp(uScale / max(c.w, 0.3), 54.0, 330.0) * uRes.y / 1080.0;
        gl_Position = iVis < 0.004 ? vec4(2.0, 2.0, 2.0, 1.0) : c + vec4(position.xy * vec2(px, px * 0.55) / uRes * 2.0 * c.w, 0.0, 0.0);
        vUv = position.xy; vCol = iCol; vVis = c.w > 0.0 ? iVis : 0.0;
      }`,
    fragmentShader: `varying vec2 vUv; varying vec3 vCol; varying float vVis; uniform float uGain;
      void main() {
        if (vVis < 0.004) discard;
        vec2 q = vec2(vUv.x, vUv.y * 0.55);
        float r2 = dot(q, q);
        float core = exp(-r2 * 1500.0) * 2.6 + exp(-r2 * 240.0) * 0.75 + exp(-r2 * 34.0) * 0.14;
        float sh = exp(-abs(q.y) * 120.0) * pow(1.0 - abs(q.x), 3.0) * 0.55;
        float sv = exp(-abs(q.x) * 150.0) * pow(max(1.0 - abs(vUv.y), 0.0), 2.5) * 0.4;
        float dg = exp(-abs(q.x - q.y) * 300.0) + exp(-abs(q.x + q.y) * 300.0);
        dg *= pow(max(1.0 - length(q) * 2.6, 0.0), 3.0) * 0.12;
        vec3 tint = mix(vCol, vec3(0.70, 1.0, 0.88), 0.5);
        vec3 col = vCol * core + tint * (sh + sv + dg);
        gl_FragColor = vec4(col * vVis * uGain, 1.0);
      }`,
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }));
  glare.mesh.frustumCulled = false;
  glare.mesh.renderOrder = 1000;
  glare.mesh.name = 'glare';
  if (n) scene.add(glare.mesh);
}
const _ray = new THREE.Ray(), _d = new THREE.Vector3(), _fwd = new THREE.Vector3();
function updateGlare(dt) {
  if (!glare.n) return;
  glare.mesh.visible = S.glare && !clipActive;
  if (!glare.mesh.visible) return;
  const cp = camera.position;
  camera.getWorldDirection(_fwd);
  const k = 1 - Math.exp(-14 * dt);
  // occlusion rays: all lamps every frame (about 40), against walls without glass plus the doors as they stand now
  for (let i = 0; i < glare.n; i++) {
    const l = W.lamps[i];
    let t = 0;
    _d.subVectors(l.pos, cp);
    const dist = _d.length();
    if (dist < 40 && _d.dot(_fwd) > 0 && (VIS.all || VIS.zones.has(l.zone))) {
      const facing = THREE.MathUtils.smoothstep(_d.y / dist, 0.05, 0.4);   // a downlight is seen from below
      if (facing > 0) {
        _ray.origin.copy(cp); _ray.direction.copy(_d).multiplyScalar(1 / dist);
        let blocked = false;
        const h = W.occluder.rayIntersect(_ray);
        if (h && h.distance < dist - 0.08) blocked = true;
        if (!blocked) for (const d of W.doors) {
          const tr = doorTree(d);
          if (!tr || d.glass) continue;
          const hh = tr.rayIntersect(_ray);
          if (hh && hh.distance < dist - 0.08) { blocked = true; break; }
        }
        if (!blocked) t = facing * (1 - THREE.MathUtils.smoothstep(dist, 18, 40));
      }
    }
    glare.tgt[i] = t;
    glare.vis.array[i] += (t - glare.vis.array[i]) * k;
  }
  glare.vis.needsUpdate = true;
  const s = renderer.getDrawingBufferSize(_v2);
  glare.mesh.material.uniforms.uRes.value.copy(s);
}
const _v2 = new THREE.Vector2();

// ---------------------------------------------------------------- player
const G = 9.8, R = 0.3;
let WALK = 1.9, RUN = 4.0;
const player = { capsule: new Capsule(new THREE.Vector3(0, R, 0), new THREE.Vector3(0, S.eye, 0), R),
  vel: new THREE.Vector3(), onFloor: false, yaw: 0, pitch: 0, camDy: 0, last: null };
let mode = 'walk';        // walk | fly | view
const fly = { pos: new THREE.Vector3(), vel: new THREE.Vector3() };
let viewCam = null, clipActive = false;

const _tmp = new THREE.Vector3(), _wish = new THREE.Vector3(), _fw = new THREE.Vector3(), _rt = new THREE.Vector3();
function resolve() {
  let best = null;
  const trees = [W.octree];
  for (const d of W.doors) { const t = doorTree(d); if (t) trees.push(t); }
  for (const tree of trees) {
    const r = tree.capsuleIntersect(player.capsule);
    if (!r) continue;
    if (r.normal.y > 0.4) player.capsule.translate(_tmp.set(0, r.depth / r.normal.y, 0));
    else player.capsule.translate(_tmp.copy(r.normal).multiplyScalar(r.depth));
    if (!best || r.normal.y > best.normal.y) best = r;
  }
  return best;
}
const FOLLOW = Math.tan(THREE.MathUtils.degToRad(40));
function step(dt, input) {
  _fw.set(Math.sin(player.yaw), 0, Math.cos(player.yaw)).negate();
  _rt.set(-_fw.z, 0, _fw.x);
  _wish.set(0, 0, 0).addScaledVector(_fw, input.f).addScaledVector(_rt, input.r);
  if (_wish.lengthSq() > 1) _wish.normalize();
  const sp = input.run ? RUN : WALK;
  const k = 1 - Math.exp(-10 * dt);
  player.vel.x += (_wish.x * sp - player.vel.x) * k;
  player.vel.z += (_wish.z * sp - player.vel.z) * k;
  player.capsule.translate(_tmp.set(player.vel.x * dt, 0, player.vel.z * dt));
  const side = resolve();
  if (side && side.normal.y < 0.4) {
    const n = _tmp.copy(side.normal).setY(0).normalize();
    const v = player.vel.x * n.x + player.vel.z * n.z;
    if (v < 0) { player.vel.x -= n.x * v; player.vel.z -= n.z * v; }
  }
  if (input.jump && player.onFloor) { player.vel.y = 3.3; player.onFloor = false; }
  const speed = Math.hypot(player.vel.x, player.vel.z);
  const dy = player.onFloor ? -(speed * FOLLOW * dt + 0.001) : (player.vel.y -= G * dt) * dt;
  player.capsule.translate(_tmp.set(0, dy, 0));
  const hit = resolve();
  const was = player.onFloor;
  player.onFloor = !!hit && hit.normal.y > 0.4 && player.vel.y <= 0.01;
  if (player.onFloor) { player.vel.y = 0; player.last = player.capsule.start.clone(); }
  else if (was && !player.onFloor && player.vel.y === 0) player.vel.y = 0;
  if (player.capsule.end.y < W.bbox.min.y - 10) { toast('Terjatuh: kembali ke titik terakhir'); placePlayer(player.last || spawnPos(W.spawns[0])); }
}
// put the feet on the floor under a point (Blender-free three coordinates)
function floorAt(x, z, yTop, drop = 8) {
  _ray.origin.set(x, yTop, z); _ray.direction.set(0, -1, 0);
  const h = W.octree.rayIntersect(_ray);
  return h && h.distance < drop ? yTop - h.distance : null;
}
function placePlayer(feet, yaw) {
  player.capsule.start.set(feet.x, feet.y + R, feet.z);
  player.capsule.end.set(feet.x, feet.y + S.eye, feet.z);
  player.vel.set(0, 0, 0);
  player.onFloor = false;
  if (yaw !== undefined) { player.yaw = yaw; player.pitch = 0; }
  for (let i = 0; i < 60; i++) step(1 / 240, { f: 0, r: 0 });
}

// ---------------------------------------------------------------- spawns, bookmarks, drone
function setupSpawns(man) {
  const list = [];
  if (man.spawns.length) for (const s of man.spawns) {
    const f = W.portalsOn && SPAWN_FIX[s.name];
    list.push({ name: s.name, pos: f ? new THREE.Vector3(f.b[0], f.b[2], -f.b[1]) : new THREE.Vector3(...s.pos),
      yaw: THREE.MathUtils.degToRad(f ? f.yaw : (s.yaw_deg ?? s.yaw ?? 0)) });
  }
  else if (W.portalsOn) for (const s of SPAWNS_demo) list.push({ name: s.name, pos: new THREE.Vector3(s.b[0], s.b[2], -s.b[1]), yaw: THREE.MathUtils.degToRad(s.yaw) });
  else {   // spike or unknown model: one spawn per probe
    for (const z of Object.values(W.zones)) list.push({ name: ZONE_NAMES[z.name] || z.name || 'Mulai', pos: new THREE.Vector3(z.pos.x, z.boxMin.y, z.pos.z), yaw: 0 });
  }
  W.spawns = list;
}
function spawnPos(s) {
  const y = floorAt(s.pos.x, s.pos.z, s.pos.y + 1.2, 4);
  return new THREE.Vector3(s.pos.x, y ?? s.pos.y, s.pos.z);
}
function gotoSpawn(s) {
  setMode('walk');
  placePlayer(spawnPos(s), s.yaw);
  showChip(s.name);
}
function camPose(c) {
  const pos = new THREE.Vector3(...c.pos), fwd = new THREE.Vector3(...c.fwd).normalize();
  const up = new THREE.Vector3(...(c.up || [0, 1, 0]));
  return { pos, fwd, up, fovY: c.fovY || 50, shift: c.shift || null, res: c.res || null, name: c.name };
}
function applyCamPose(cam, c, aspect) {
  cam.position.copy(c.pos);
  cam.up.copy(c.up);
  cam.lookAt(_tmp.copy(c.pos).add(c.fwd));
  cam.up.set(0, 1, 0);
  // show the whole preset frame: fit it inside the window, whatever the window's shape. fovY belongs to the camera's own frame.
  const ac = c.res ? c.res[0] / c.res[1] : 16 / 9;
  const tV = Math.tan(THREE.MathUtils.degToRad(c.fovY) / 2);
  let fitX = 1, fitY = 1;
  if (aspect >= ac) { cam.fov = c.fovY; fitX = ac / aspect; }
  else { cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tV * ac / aspect)); fitY = aspect / ac; }
  cam.aspect = aspect;
  cam.updateProjectionMatrix();
  if (c.shift) {      // Blender lens shift, in units of the frame width
    cam.projectionMatrix.elements[8] += 2 * c.shift[0] * fitX;
    cam.projectionMatrix.elements[9] += 2 * c.shift[1] * ac * fitY;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }
}
async function gotoCam(name) {
  const c = W.man.cameras.find((x) => x.name === name);
  if (!c) return false;
  viewCam = camPose(c);
  setMode('view');
  const wantClip = /aerial/i.test(name);
  if (wantClip !== clipActive) await setClip(wantClip);
  showChip(`Sudut pilihan: ${CAM_NAMES[name] || name}`, 'gerakkan mouse atau tombol untuk lanjut');
  return true;
}
// Page 3 is a cutaway: everything above Z 2.8 hidden. A global clip plane recompiles every program once, so it is
// prepared in the background before it is switched on.
const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 2.8);
async function setClip(on) {
  if (W.meshes.some((o) => o.userData.rv.ceiling)) { clipActive = on; return; }    // the export tags what the cutaway hides
  if (on) {
    toast('Menyiapkan tampilan potongan…', 4000);
    renderer.clippingPlanes = [clipPlane];
    for (const o of W.meshes) o.visible = true;
    try { await renderer.compileAsync(scene, camera); } catch { /* compiled on first draw instead */ }
  } else renderer.clippingPlanes = [];
  clipActive = on;
}
function droneViews() {
  const c = W.bbox.getCenter(new THREE.Vector3()), s = W.bbox.getSize(new THREE.Vector3());
  const tgt = W.zones.lobby ? new THREE.Vector3(4, 4, 2) : c.clone();
  const r = W.portalsOn ? 1 : Math.max(s.x, s.z) / 40;
  return [
    { name: 'Drone: depan gedung', pos: tgt.clone().add(new THREE.Vector3(32 * r, 12 * r, 18 * r)), look: tgt },
    { name: 'Drone: atap', pos: tgt.clone().add(new THREE.Vector3(10 * r, 34 * r, 26 * r)), look: tgt.clone().add(new THREE.Vector3(0, 6 * r, 0)) },
    { name: 'Drone: samping jalan', pos: tgt.clone().add(new THREE.Vector3(26 * r, 3 * r, -24 * r)), look: tgt },
  ];
}
function gotoDrone(v) {
  setMode('fly');
  fly.pos.copy(v.pos);
  _tmp.subVectors(v.look, v.pos).normalize();
  player.yaw = Math.atan2(-_tmp.x, -_tmp.z);
  player.pitch = Math.asin(THREE.MathUtils.clamp(_tmp.y, -1, 1));
  showChip(v.name);
}

function setMode(m) {
  if (m === mode) return;
  if (mode === 'view' && clipActive && m !== 'view') setClip(false);
  if (m === 'fly') {
    fly.pos.copy(mode === 'view' && viewCam ? viewCam.pos : camera.position);
    fly.vel.set(0, 0, 0);
    camera.near = 0.2; camera.far = 700;
  } else { camera.near = 0.08; camera.far = 160; }
  if (m !== 'view') { camera.fov = S.fov; camera.aspect = viewW() / viewH(); camera.updateProjectionMatrix(); }
  if (m === 'walk' && mode === 'fly') {
    // land: floor under the drone, or back to the last place walked
    const y = floorAt(fly.pos.x, fly.pos.z, fly.pos.y, 60);
    if (y !== null && W.zoneList.length) placePlayer(new THREE.Vector3(fly.pos.x, y, fly.pos.z));
    else placePlayer(player.last ? player.last.clone().setY(player.last.y - R) : spawnPos(W.spawns[0]));
  }
  mode = m;
  $('#b-fly').classList.toggle('on', m === 'fly');
}
// leaving a preset view: walk from there when it is indoors and near a floor, else fly from there
function leaveView() {
  if (mode !== 'view' || !viewCam) return;
  const p = viewCam.pos;
  player.yaw = Math.atan2(-viewCam.fwd.x, -viewCam.fwd.z);
  player.pitch = Math.asin(THREE.MathUtils.clamp(viewCam.fwd.y, -1, 1));
  const z = zoneAt(p);
  const y = floorAt(p.x, p.z, p.y, 3);
  if (z !== 'ext' && y !== null && p.y - y < 2.4) {
    const yaw = player.yaw, pitch = player.pitch;
    setMode('walk');
    placePlayer(new THREE.Vector3(p.x, y, p.z));
    player.yaw = yaw; player.pitch = pitch;
    player.camDy = p.y - player.capsule.end.y;          // ease from the preset camera height to eye height
  } else { const yaw = player.yaw, pitch = player.pitch; setMode('fly'); fly.pos.copy(p); player.yaw = yaw; player.pitch = pitch; }
  viewCam = null;
}

// ---------------------------------------------------------------- door interaction
const raycaster = new THREE.Raycaster();
function doorTarget() {
  if (mode !== 'walk' || !W.doorMeshes.length) return null;
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  raycaster.far = 2.7;
  const hits = raycaster.intersectObjects(W.doorMeshes, false);
  if (hits.length) return hits[0].object.userData.rv.door;
  // nothing under the cross: the nearest door within 1.7 m in front
  let best = null, bd = 1.7;
  camera.getWorldDirection(_fwd);
  for (const d of W.doors) {
    const c = new THREE.Box3().setFromObject(d.node).getCenter(_tmp);
    const dist = Math.hypot(c.x - camera.position.x, c.z - camera.position.z);
    const dot = ((c.x - camera.position.x) * _fwd.x + (c.z - camera.position.z) * _fwd.z) / Math.max(dist, 1e-3);
    if (dist < bd && dot > 0.35) { bd = dist; best = d; }
  }
  return best;
}
function toggleDoor(id, open) {
  const list = W.doorsById[id];
  if (!list) return { ok: false, why: 'no door' };
  if (list[0].locked) {
    for (const d of list) d.rattle = 1;
    toast(`${DOOR_NAMES[id] || 'Pintu'} terkunci.`);
    return { ok: false, why: 'locked' };
  }
  const want = open === undefined ? (list[0].target ? 0 : 1) : (open ? 1 : 0);
  if (!want && mode === 'walk') for (const d of list) if (d.closed && d.closed.capsuleIntersect(player.capsule)) {
    toast('Minggir sedikit dulu, pintunya terhalang.'); return { ok: false, why: 'blocked' };
  }
  for (const d of list) d.target = want;
  return { ok: true, open: !!want };
}
function interact() {
  const d = doorTarget();
  if (d) toggleDoor(d.id);
  return d ? d.id : null;
}

// ---------------------------------------------------------------- UI helpers
let toastT = 0;
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.style.opacity = 1;
  clearTimeout(toastT); toastT = setTimeout(() => { t.style.opacity = 0; }, ms);
}
let chipMsg = null, chipT = 0;
function showChip(msg, sub = '') { chipMsg = { msg, sub }; chipT = performance.now() + 5000; }
const locked = () => document.pointerLockElement === canvas;
const menus = ['#teleport', '#settings', '#help'];
function openMenu(id) {
  for (const m of menus) $(m).classList.toggle('hidden', m !== id || !$(m).classList.contains('hidden'));
  if (locked()) document.exitPointerLock();
  syncUI();
}
function closeMenus() { for (const m of menus) $(m).classList.add('hidden'); syncUI(); }
const anyMenu = () => menus.some((m) => !$(m).classList.contains('hidden'));
function syncUI() {
  const L = locked();
  $('#pause').classList.toggle('hidden', L || anyMenu() || !W.ready || opt.test);
  $('#cross').classList.toggle('hidden', !W.ready || mode === 'view');
  $('#b-tele').classList.toggle('on', !$('#teleport').classList.contains('hidden'));
  $('#b-set').classList.toggle('on', !$('#settings').classList.contains('hidden'));
  $('#b-help').classList.toggle('on', !$('#help').classList.contains('hidden'));
}

function buildMenus() {
  const mk = (parent, label, sub, fn) => {
    const b = document.createElement('button');
    b.className = 'item';
    b.innerHTML = label + (sub ? `<small>${sub}</small>` : '');
    b.onclick = () => { closeMenus(); fn(); };
    $(parent).appendChild(b);
  };
  for (const s of W.spawns) mk('#t-spawns', s.name, '', () => gotoSpawn(s));
  const cams = [...W.man.cameras].sort((a, b) => (CAM_NAMES[a.name] || a.name).localeCompare(CAM_NAMES[b.name] || b.name));
  for (const c of cams) mk('#t-cams', CAM_NAMES[c.name] || c.name, '', () => gotoCam(c.name));
  if (!cams.length) $('#t-cams').textContent = 'Belum ada kamera di manifest.';
  for (const v of droneViews()) mk('#t-drone', v.name, '', () => gotoDrone(v));
  $('#b-tele').onclick = () => openMenu('#teleport');
  $('#b-set').onclick = () => openMenu('#settings');
  $('#b-help').onclick = () => openMenu('#help');
  $('#b-fly').onclick = () => { setMode(mode === 'fly' ? 'walk' : 'fly'); closeMenus(); };
  $('#b-shot').onclick = () => screenshot();
  // settings
  const seg = $('#s-preset');
  const syncSettings = () => {
    for (const b of seg.children) b.classList.toggle('on', b.dataset.p === S.preset);
    $('#s-scale').value = Math.round(S.scale * 100); $('#o-scale').textContent = Math.round(S.scale * 100) + '%';
    $('#s-planar').checked = S.planar; $('#s-glare').checked = S.glare; $('#s-fps').checked = S.fps;
    $('#s-sens').value = S.sens; $('#o-sens').textContent = S.sens.toFixed(1) + '×';
    $('#s-eye').value = S.eye; $('#o-eye').textContent = S.eye.toFixed(2) + ' m';
    $('#s-fov').value = S.fov; $('#o-fov').textContent = S.fov + '°';
    $('#fps').classList.toggle('hidden', !S.fps);
    const s = renderer.getDrawingBufferSize(_v2);
    $('#s-note').textContent = `Resolusi gambar ${s.x} × ${s.y}. ${W.man.dev ? 'Model pengembangan (belum di-bake).' : ''}`;
  };
  W.syncSettings = syncSettings;
  for (const b of seg.children) b.onclick = () => { Object.assign(S, { preset: b.dataset.p }, PRESETS[b.dataset.p]); applySettings(); };
  $('#s-scale').oninput = (e) => { S.scale = e.target.value / 100; S.preset = 'kustom'; applySettings(); };
  $('#s-planar').onchange = (e) => { S.planar = e.target.checked; S.preset = 'kustom'; applySettings(); };
  $('#s-glare').onchange = (e) => { S.glare = e.target.checked; applySettings(); };
  $('#s-fps').onchange = (e) => { S.fps = e.target.checked; applySettings(); };
  $('#s-sens').oninput = (e) => { S.sens = +e.target.value; applySettings(); };
  $('#s-eye').oninput = (e) => { S.eye = +e.target.value; applySettings(); };
  $('#s-fov').oninput = (e) => { S.fov = +e.target.value; applySettings(); };
  syncSettings();
}
function applySettings() {
  resize();
  player.capsule.end.copy(player.capsule.start).setY(player.capsule.start.y + S.eye - R);
  if (mode !== 'view') { camera.fov = S.fov; camera.updateProjectionMatrix(); }
  saveSettings();
  W.syncSettings && W.syncSettings();
}
function resize() {
  renderer.setPixelRatio(S.scale);
  renderer.setSize(viewW(), viewH(), !opt.w);
  if (mode !== 'view') { camera.aspect = viewW() / viewH(); camera.updateProjectionMatrix(); }
  resizePlanar();
}

// ---------------------------------------------------------------- minimap: plan rendered once from above, cut at 2.35 m
const map = { base: null, N: 1024, x0: 0, z0: 0, span: 1, big: false, ctx: null };
function buildMinimap() {
  const el = $('#map canvas');
  el.width = el.height = map.N;
  map.ctx = el.getContext('2d');
  const b = new THREE.Box3();
  const indoor = Object.values(W.zones).filter((z) => z.name !== 'ext' && vol(z) < 1e6);
  for (const z of indoor) b.union(new THREE.Box3(z.boxMin, z.boxMax));
  for (const s of W.spawns) b.expandByPoint(s.pos);
  if (b.isEmpty()) b.copy(W.bbox);
  b.expandByScalar(1.5);
  const c = b.getCenter(new THREE.Vector3());
  map.span = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
  map.x0 = c.x - map.span / 2; map.z0 = c.z - map.span / 2;
  const cam = new THREE.OrthographicCamera(-map.span / 2, map.span / 2, map.span / 2, -map.span / 2, 0.01, 14);
  cam.position.set(c.x, 2.35, c.z); cam.up.set(0, 0, -1); cam.lookAt(c.x, -10, c.z);
  cam.updateMatrixWorld();
  const base = document.createElement('canvas');
  base.width = base.height = map.N;
  const bx = base.getContext('2d');
  bx.fillStyle = '#10141c'; bx.fillRect(0, 0, map.N, map.N);
  const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
  const res = Math.floor(Math.min(buf.x, buf.y, map.N));
  for (const o of W.meshes) o.visible = true;
  sky.visible = false; glare.mesh && (glare.mesh.visible = false);
  planarU.uPlanar.value = emptyTex;
  renderer.setScissorTest(true);
  renderer.setScissor(0, 0, res / S.scale, res / S.scale);
  renderer.setViewport(0, 0, res / S.scale, res / S.scale);
  renderer.setClearColor(0x10141c, 1);
  renderer.clear();
  renderer.render(scene, cam);
  bx.globalAlpha = 0.92;
  bx.drawImage(canvas, 0, canvas.height - res, res, res, 0, 0, map.N, map.N);
  bx.globalAlpha = 1;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, viewW(), viewH());
  sky.visible = true;
  // walls: slice of the colliders at 1.0 m, drawn as crisp lines over the render
  const toPx = (x, z) => [(x - map.x0) / map.span * map.N, (z - map.z0) / map.span * map.N];
  bx.strokeStyle = 'rgba(235,240,255,0.9)'; bx.lineWidth = 3; bx.lineCap = 'round';
  bx.beginPath();
  const a = new THREE.Vector3(), bb = new THREE.Vector3(), cc = new THREE.Vector3(), Y = 1.0;
  for (const m of W.colSlice) {
    const p = m.geometry.attributes.position, ix = m.geometry.index;
    const nT = triCount(m.geometry);
    for (let t = 0; t < nT; t++) {
      a.fromBufferAttribute(p, ix ? ix.getX(3 * t) : 3 * t); bb.fromBufferAttribute(p, ix ? ix.getX(3 * t + 1) : 3 * t + 1);
      cc.fromBufferAttribute(p, ix ? ix.getX(3 * t + 2) : 3 * t + 2);
      const pts = [];
      for (const [u, w] of [[a, bb], [bb, cc], [cc, a]]) {
        if ((u.y - Y) * (w.y - Y) < 0) { const f = (Y - u.y) / (w.y - u.y); pts.push([u.x + (w.x - u.x) * f, u.z + (w.z - u.z) * f]); }
      }
      if (pts.length === 2) { bx.moveTo(...toPx(...pts[0])); bx.lineTo(...toPx(...pts[1])); }
    }
  }
  bx.stroke();
  bx.font = '600 40px Poppins, Segoe UI, sans-serif'; bx.textAlign = 'center';
  for (const z of indoor) {
    const [px, py] = toPx((z.boxMin.x + z.boxMax.x) / 2, (z.boxMin.z + z.boxMax.z) / 2);
    const label = ZONE_NAMES[z.name] || z.name;
    bx.fillStyle = 'rgba(0,0,0,0.55)'; bx.fillText(label, px + 1.5, py + 1.5);
    bx.fillStyle = 'rgba(255,255,255,0.95)'; bx.fillText(label, px, py);
  }
  map.base = base;
  drawMap();
}
function drawMap() {
  if (!map.base) return;
  const key = `${map.big}|${camera.position.x.toFixed(2)}|${camera.position.z.toFixed(2)}|${player.yaw.toFixed(2)}|${mode}`;
  if (key === map.key) return;
  map.key = key;
  const el = map.ctx.canvas, N = map.big ? map.N : 480;
  if (el.width !== N) el.width = el.height = N;
  const x = map.ctx;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.drawImage(map.base, 0, 0, N, N);
  const p = mode === 'walk' ? player.capsule.end : camera.position;
  const px = (p.x - map.x0) / map.span * N, py = (p.z - map.z0) / map.span * N;
  const AR = map.big ? 1 : 0.9;
  const yaw = mode === 'view' && viewCam ? Math.atan2(-viewCam.fwd.x, -viewCam.fwd.z) : player.yaw;
  const dx = -Math.sin(yaw), dy = -Math.cos(yaw);
  const fov = THREE.MathUtils.degToRad(camera.fov) * camera.aspect / 2;
  x.save();
  x.translate(px, py); x.rotate(Math.atan2(dy, dx)); x.scale(AR * (map.big ? 1 : 0.55), AR * (map.big ? 1 : 0.55));
  const g = x.createRadialGradient(0, 0, 0, 0, 0, 150);
  g.addColorStop(0, 'rgba(110,140,255,0.45)'); g.addColorStop(1, 'rgba(110,140,255,0)');
  x.fillStyle = g;
  x.beginPath(); x.moveTo(0, 0); x.arc(0, 0, 150, -Math.min(fov, 1.2), Math.min(fov, 1.2)); x.closePath(); x.fill();
  x.fillStyle = '#ffffff'; x.strokeStyle = '#2b338f'; x.lineWidth = 4;
  x.beginPath(); x.moveTo(20, 0); x.lineTo(-11, 12); x.lineTo(-5, 0); x.lineTo(-11, -12); x.closePath(); x.stroke(); x.fill();
  x.restore();
}
function mapClick(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const x = map.x0 + (e.clientX - r.left) / r.width * map.span, z = map.z0 + (e.clientY - r.top) / r.height * map.span;
  for (const yTop of [2.6, 1.0, -1.0]) {
    const y = floorAt(x, z, yTop, 4);
    if (y !== null) { setMode('walk'); placePlayer(new THREE.Vector3(x, y, z)); showChip(ZONE_NAMES[zoneAt(player.capsule.end)] || 'Pindah'); return; }
  }
  toast('Tidak ada lantai di titik itu.');
}

// ---------------------------------------------------------------- screenshot
const captureBlob = () => new Promise((res) => { drawFrame(0); canvas.toBlob(res, 'image/png'); });
function screenshot() {
  const z = ZONE_NAMES[VIS.cam] || VIS.cam || 'view';
  captureBlob().then((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `demo_${z.replace(/[^A-Za-z0-9]+/g, '_')}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  const f = $('#flash'); f.style.transition = 'none'; f.style.opacity = 0.5;
  requestAnimationFrame(() => { f.style.transition = 'opacity 0.35s'; f.style.opacity = 0; });
  toast('Tangkapan layar disimpan ke folder unduhan.', 1600);
}

// ---------------------------------------------------------------- input
const keys = {};
let drag = null;
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && !/^Key/.test(e.code)) return;
  keys[e.code] = true;
  if (!W.ready || e.repeat) return;
  if (e.code === 'KeyE') interact();
  else if (e.code === 'KeyF') setMode(mode === 'fly' ? 'walk' : 'fly');
  else if (e.code === 'KeyT') openMenu('#teleport');
  else if (e.code === 'KeyH' || e.code === 'Slash') openMenu('#help');
  else if (e.code === 'KeyM') { map.big = !map.big; $('#map').classList.toggle('big', map.big); }
  else if (e.code === 'KeyP') screenshot();
  else if (e.code === 'Escape') { closeMenus(); if (map.big) { map.big = false; $('#map').classList.remove('big'); } }
  if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code) && e.target === document.body || e.target === canvas) e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
function look(dx, dy) {
  if (mode === 'view') leaveView();
  const k = 0.0022 * S.sens;
  player.yaw -= dx * k;
  player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch - dy * k));
}
canvas.addEventListener('mousedown', (e) => { if (!TOUCH && !locked() && e.button === 0) drag = { x: e.clientX, y: e.clientY, moved: 0 }; });
addEventListener('mouseup', () => {
  if (drag && drag.moved < 5 && W.ready) { closeMenus(); canvas.requestPointerLock(); }
  drag = null;
});
addEventListener('mousemove', (e) => {
  if (locked()) look(e.movementX, e.movementY);
  else if (drag) { drag.moved += Math.abs(e.movementX) + Math.abs(e.movementY); if (drag.moved > 4) look(e.movementX, e.movementY); }
});
canvas.addEventListener('click', () => { if (locked() && W.ready) interact(); });
document.addEventListener('pointerlockchange', () => { if (locked()) closeMenus(); syncUI(); });
addEventListener('resize', () => { if (!opt.w) resize(); });

// ---------------------------------------------------------------- touch: the left stick walks, dragging the view looks, a tap works the door
const stick = { id: null, x: 0, y: 0 };
if (TOUCH) {
  document.body.classList.add('touch');
  const pad = $('#stick'), knob = pad.querySelector('i'), reach = 52;
  const aim = (e) => {
    const r = pad.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > reach) { dx *= reach / len; dy *= reach / len; }
    stick.x = dx / reach; stick.y = dy / reach;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const release = (e) => {
    if (e.pointerId !== stick.id) return;
    stick.id = null; stick.x = stick.y = 0; knob.style.transform = '';
  };
  pad.addEventListener('pointerdown', (e) => { e.preventDefault(); stick.id = e.pointerId; pad.setPointerCapture(e.pointerId); aim(e); });
  pad.addEventListener('pointermove', (e) => { if (e.pointerId === stick.id) aim(e); });
  pad.addEventListener('pointerup', release);
  pad.addEventListener('pointercancel', release);

  let view = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (view || e.pointerType === 'mouse') return;
    e.preventDefault();
    view = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!view || e.pointerId !== view.id) return;
    const dx = e.clientX - view.x, dy = e.clientY - view.y;
    view.x = e.clientX; view.y = e.clientY;
    view.moved += Math.abs(dx) + Math.abs(dy);
    if (view.moved > 6 && W.ready && !anyMenu()) look(dx * 2.2, dy * 2.2);
  });
  const endView = (e) => {
    if (!view || e.pointerId !== view.id) return;
    if (view.moved <= 6 && W.ready) { if (anyMenu()) closeMenus(); else interact(); }
    view = null;
  };
  canvas.addEventListener('pointerup', endView);
  canvas.addEventListener('pointercancel', endView);
  $('#prompt').addEventListener('click', () => interact());
  $('#help-close').addEventListener('click', () => closeMenus());
  $('#help table').innerHTML = `
    <tr><td>Lingkaran kiri</td><td>Geser untuk berjalan. Geser sampai tepi untuk berlari.</td></tr>
    <tr><td>Geser layar</td><td>Melihat sekeliling.</td></tr>
    <tr><td>Ketuk layar</td><td>Buka atau tutup pintu di depan Anda.</td></tr>
    <tr><td>Pindah ke…</td><td>Langsung ke ruangan lain.</td></tr>
    <tr><td>Peta</td><td>Ketuk untuk memperbesar, lalu ketuk titik tujuan.</td></tr>`;
}

// ---------------------------------------------------------------- frame
const stats = { planar: { calls: 0, tris: 0 }, main: { calls: 0, tris: 0 }, glareMs: 0 };
function updateCamera(dt) {
  if (mode === 'view' && viewCam) { applyCamPose(camera, viewCam, viewW() / viewH()); return; }
  if (mode === 'walk') {
    player.camDy *= Math.exp(-5 * dt);
    camera.position.copy(player.capsule.end); camera.position.y += player.camDy;
  } else camera.position.copy(fly.pos);
  camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
  camera.updateMatrixWorld();
}
function drawFrame(dt = 1 / 60) {
  renderer.info.reset();
  camera.updateMatrixWorld();
  computeVisibility(camera);
  setExtGlass();
  renderPlanar(camera);
  stats.planar.calls = renderer.info.render.calls; stats.planar.tris = renderer.info.render.triangles;
  applyVisibility('main');
  sky.visible = true;
  sky.position.copy(camera.position); sky.scale.setScalar(camera.far * 0.9); sky.updateMatrixWorld();
  const tg = performance.now();
  updateGlare(dt);
  stats.glareMs = performance.now() - tg;
  renderer.render(scene, camera);
  stats.main.calls = renderer.info.render.calls - stats.planar.calls;
  stats.main.tris = renderer.info.render.triangles - stats.planar.tris;
}
// test: drive the normal loop along a route, as held keys would, and keep every rAF timestamp
let auto = null;
function autopilot(inp) {
  const e = player.capsule.end, p = auto.pts[auto.i];
  if (!p) { const a = auto; auto = null; a.done(); return; }
  const [x, z] = tB(p[0], p[1]), dx = x - e.x, dz = z - e.z;
  if (Math.hypot(dx, dz) < 0.3) { auto.i++; return; }
  let dy = Math.atan2(-dx, -dz) - player.yaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  player.yaw += dy * 0.12;
  inp.f = 1;
}
function liveRoute(pts) {
  return new Promise((res) => {
    const a = { pts, i: 0, ts: [] };
    a.done = () => {
      const d = a.ts.slice(1).map((v, i) => v - a.ts[i]);
      const T = a.ts.at(-1) - a.ts[0];
      res({ seconds: +(T / 1000).toFixed(1), frames: d.length, fps: +(1000 * d.length / T).toFixed(2), med_ms: +median(d).toFixed(2), p95_ms: +pct(d, 0.95).toFixed(2),
        p99_ms: +pct(d, 0.99).toFixed(2), max_ms: +Math.max(...d).toFixed(1), over20: d.filter((v) => v > 20).length, over33: d.filter((v) => v > 33.4).length,
        cpu_med_ms: +median(frameMs).toFixed(2), canvas: [canvas.clientWidth, canvas.clientHeight], buffer: renderer.getDrawingBufferSize(new THREE.Vector2()).toArray() });
    };
    setMode('walk');
    auto = a;
  });
}
let live = true, lastT = 0, fpsN = 0, fpsT = 0, uiT = 0, frameMs = [];
function loop(t) {
  if (!live) return;
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, Math.max(0, (t - lastT) / 1000)); lastT = t;
  if (auto) auto.ts.push(t);
  const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
  const inp = typing ? { f: 0, r: 0 } : { f: (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0),
    r: (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0),
    run: keys.ShiftLeft || keys.ShiftRight, jump: keys.Space, down: keys.KeyC || keys.ControlLeft };
  if (auto) autopilot(inp);
  const pushed = Math.hypot(stick.x, stick.y);
  if (!typing && pushed > 0.12) { inp.f -= stick.y; inp.r += stick.x; inp.run = pushed > 0.92; }
  if (mode === 'view' && (inp.f || inp.r || inp.jump)) leaveView();
  if (mode === 'walk') for (let i = 0; i < 4; i++) step(dt / 4, inp);
  else if (mode === 'fly') {
    camera.getWorldDirection(_fw);
    _rt.crossVectors(_fw, _Y).normalize();
    _wish.set(0, 0, 0).addScaledVector(_fw, inp.f).addScaledVector(_rt, inp.r);
    _wish.y += (inp.jump ? 1 : 0) - (inp.down ? 1 : 0);
    const sp = inp.run ? 16 : 6;
    fly.vel.lerp(_wish.multiplyScalar(sp), 1 - Math.exp(-6 * dt));
    fly.pos.addScaledVector(fly.vel, dt);
    fly.pos.y = Math.max(fly.pos.y, W.bbox.min.y + 0.5);
  }
  updateDoors(dt);
  updateCamera(dt);
  const t0 = performance.now();
  drawFrame(dt);
  frameMs.push(performance.now() - t0); if (frameMs.length > 120) frameMs.shift();
  fpsN++;
  if (t - uiT > 100) {
    uiT = t;
    drawMap();
    const d = mode === 'walk' && !anyMenu() ? doorTarget() : null;
    const pr = $('#prompt');
    if (d) {
      const nm = DOOR_NAMES[d.id] || 'Pintu';
      pr.innerHTML = d.locked ? `${nm} <span style="color:#ffb84d">terkunci</span>` : `<kbd>E</kbd>${d.target ? 'Tutup' : 'Buka'} ${nm}`;
    }
    pr.classList.toggle('hidden', !d);
    const zc = $('#zone');
    if (chipMsg && performance.now() < chipT) zc.innerHTML = chipMsg.msg + (chipMsg.sub ? `<small>${chipMsg.sub}</small>` : '');
    else zc.innerHTML = (ZONE_NAMES[VIS.cam] || VIS.cam || '') + (mode === 'fly' ? '<small>mode terbang</small>' : '');
    zc.classList.toggle('hidden', !zc.textContent);
  }
  if (t - fpsT > 500) {
    if (S.fps) {
      const ms = [...frameMs].sort((a, b) => a - b);
      $('#fps').textContent = `${(fpsN * 1000 / (t - fpsT)).toFixed(0)} fps  cpu ${ms[ms.length >> 1].toFixed(1)} ms\n` +
        `main ${stats.main.calls} calls ${(stats.main.tris / 1000).toFixed(0)}k  pantulan ${stats.planar.calls} calls ${(stats.planar.tris / 1000).toFixed(0)}k`;
    }
    fpsT = t; fpsN = 0;
  }
}

// Colour of a pane's transmission (Cycles: tint per face, two faces). The frame buffer holds display values, so the multiply
// happens there: three's output encoding of an unlit linear colour gives the right display-space factor, near enough.
function tintMaterial(name) {
  const g = GLASS_SPEC[name];
  const m = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, toneMapped: false, blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    uniforms: { uT: { value: new THREE.Vector3(...g.tint.map((t) => t * t)) }, uF0: { value: f0Of(g.ior) } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main() { vec4 p = modelViewMatrix * vec4(position, 1.0); vN = normalMatrix * normal; vV = -p.xyz; gl_Position = projectionMatrix * p; }`,
    fragmentShader: `varying vec3 vN; varying vec3 vV; uniform vec3 uT; uniform float uF0;
      void main() {
        float c = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        float F = uF0 + (1.0 - uF0) * pow(1.0 - c, 5.0);
        gl_FragColor = vec4(pow(uT * (1.0 - F), vec3(1.0 / 2.2)), 1.0);      // transmission (1 - F) * tint^2, as a display-space factor
      }` });
  m.name = 'tint_' + name;
  return m;
}
// three uploads a texture the first time it is drawn, which would stutter on entering each room. Everything goes up at load.
function uploadTextures(atlases) {
  const set = new Set();
  for (const o of W.meshes) for (const k in o.material) if (o.material[k] && o.material[k].isTexture) set.add(o.material[k]);
  for (const a of Object.values(atlases)) if (a.open) set.add(a.open);
  for (const t of set) renderer.initTexture(t);
  W.uploaded = set.size;
}

// One real draw of everything into both targets: vertex buffers also upload on first draw, and the driver finishes linking there.
function warmAll() {
  for (const o of W.meshes) { o.visible = true; o.frustumCulled = false; }
  if (glare.mesh) glare.mesh.visible = false;
  planarU.uPlanar.value = emptyTex;
  if (planar.rt) { renderer.setRenderTarget(planar.rt); renderer.render(scene, camera); renderer.setRenderTarget(null); }
  renderer.render(scene, camera);
  gl.finish();
  for (const o of W.meshes) o.frustumCulled = true;
}

// ---------------------------------------------------------------- precompile (both targets, so no hitch on first view)
async function precompile() {
  for (const o of W.meshes) o.visible = true;
  planarU.uPlanar.value = emptyTex;
  if (W.spawns[0]) { camera.position.copy(W.spawns[0].pos).setY(W.spawns[0].pos.y + 1.6); camera.updateMatrixWorld(); }
  if (planar.rt) {
    glare.mesh && (glare.mesh.visible = false); sky.visible = false;
    renderer.setRenderTarget(planar.rt);
    const p = renderer.compileAsync(scene, camera);
    renderer.setRenderTarget(null);
    await p;
    glare.mesh && (glare.mesh.visible = true); sky.visible = true;
  }
  await renderer.compileAsync(scene, camera);
}

// ---------------------------------------------------------------- test hooks for pipeline/tests/chrome_run.mjs
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
async function bench({ frames = 200, warm = 30 } = {}) {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const px = new Uint8Array(4), gpu = [], wall = [], cpu = [], pending = [];
  const pump = () => {
    while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = pending.shift();
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
  };
  for (let i = 0; i < frames + warm; i++) {
    let q = null;
    if (ext && i >= warm) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    const t0 = performance.now();
    drawFrame(1 / 60);
    const t1 = performance.now();
    if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(q); }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t2 = performance.now();
    if (i >= warm) { cpu.push(t1 - t0); wall.push(t2 - t0); }
    if (ext) pump();
    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  for (let i = 0; i < 50 && pending.length; i++) { await new Promise((r) => setTimeout(r, 10)); pump(); }
  const s = (a) => (a.length ? { med: +median(a).toFixed(2), p95: +pct(a, 0.95).toFixed(2), p99: +pct(a, 0.99).toFixed(2) } : null);
  return { gpu_ms: s(gpu), wall_ms: s(wall), cpu_ms: s(cpu), n_gpu: gpu.length, ...frameInfo() };
}
function frameInfo() {
  const b = renderer.getDrawingBufferSize(_v2);
  return { zone: VIS.cam, visZones: VIS.all ? 'all' : [...VIS.zones.keys()].join(','), planarZones: [...VIS.planarZones].join(','),
    planarOn: planar.on, main: { ...stats.main }, planar: { ...stats.planar }, calls: stats.main.calls + stats.planar.calls,
    tris: stats.main.tris + stats.planar.tris, glareVisible: glare.vis ? +glare.vis.array.reduce((s, v) => s + (v > 0.05), 0) : 0,
    glareMs: +stats.glareMs.toFixed(3), buffer: [b.x, b.y], mode };
}
const tB = (x, y) => [x, -y];      // Blender plan (x, y) -> three (x, z)
function walkTo(bx, by, maxT = 15, run = false) {
  const [x, z] = tB(bx, by);
  const dt = 1 / 240, log = { reached: false, t: 0, minEye: 1e9, maxEye: -1e9 };
  setMode('walk');
  for (let t = 0; t < maxT; t += dt) {
    const e = player.capsule.end;
    const dx = x - e.x, dz = z - e.z;
    if (Math.hypot(dx, dz) < 0.08) { log.reached = true; log.t = t; break; }
    player.yaw = Math.atan2(-dx, -dz);
    step(dt, { f: 1, r: 0, run });
    updateDoors(dt);
    log.minEye = Math.min(log.minEye, e.y); log.maxEye = Math.max(log.maxEye, e.y); log.t = t;
  }
  for (let i = 0; i < 120; i++) { step(dt, { f: 0, r: 0 }); updateDoors(dt); }
  const e = player.capsule.end;
  return { to: [bx, by], reached: log.reached, s: +log.t.toFixed(2), at: [+e.x.toFixed(2), +(-e.z).toFixed(2), +e.y.toFixed(3)],
    eye: [+log.minEye.toFixed(2), +log.maxEye.toFixed(2)], onFloor: player.onFloor, zone: zoneAt(e) };
}
function face(bx, by, pitchDeg = 0) {
  const [x, z] = tB(bx, by), e = player.capsule.end;
  player.yaw = Math.atan2(-(x - e.x), -(z - e.z)); player.pitch = THREE.MathUtils.degToRad(pitchDeg);
  updateCamera(0);
  return true;
}
// place the player on the floor at Blender (x, y), looking at Blender (fx, fy)
function tp(bx, by, fx, fy, pitchDeg = 0) {
  setMode('walk');
  const [x, z] = tB(bx, by);
  let y = null;
  for (const yTop of [2.6, 1.0, -1.0]) { y = floorAt(x, z, yTop, 4); if (y !== null) break; }
  placePlayer(new THREE.Vector3(x, y ?? 0, z));
  if (fx !== undefined) face(fx, fy, pitchDeg);
  else updateCamera(0);
  return { eye: +player.capsule.end.y.toFixed(3), zone: zoneAt(player.capsule.end), onFloor: player.onFloor };
}
function warm(n = 25) { updateCamera(0); for (let i = 0; i < n; i++) drawFrame(1 / 30); return frameInfo(); }
function settleDoors() { for (let i = 0; i < 240; i++) updateDoors(1 / 120); updateCamera(0); return W.doors.map((d) => `${d.node.name}:${d.t}`); }
function setCamera(name, w, h) {    // exact preset camera pose, for comparison with the Cycles sheets
  const c = W.man.cameras.find((x) => x.name === name);
  if (!c) return false;
  viewCam = camPose(c); mode = 'view';
  applyCamPose(camera, viewCam, (w || viewW()) / (h || viewH()));
  return true;
}
// What is under a pixel: mesh, world point in Blender coordinates, UV_LM and the lightmap value there
function pick(px, py) {
  const s = renderer.getDrawingBufferSize(_v2);
  raycaster.setFromCamera({ x: px / s.x * 2 - 1, y: 1 - py / s.y * 2 }, camera);
  raycaster.far = 500;
  const h = raycaster.intersectObjects(W.meshes.filter((o) => o.visible && !o.userData.rv.glass), false)[0];
  if (!h) return null;
  const o = h.object, lm = o.material.lightMap;
  const out = { name: o.name, mat: o.material.name, point: [+h.point.x.toFixed(3), +(-h.point.z).toFixed(3), +h.point.y.toFixed(3)], uv1: h.uv1 ? [+h.uv1.x.toFixed(5), +h.uv1.y.toFixed(5)] : null };
  if (lm && lm.mipmaps && h.uv1) {
    const { data, width: W0, height: H0 } = lm.mipmaps[0];
    const dec = (v) => { const e = 2 ** ((v >>> 27) - 24); return [(v & 511) * e, ((v >>> 9) & 511) * e, ((v >>> 18) & 511) * e].map((x) => +x.toFixed(3)); };
    const x = Math.floor(h.uv1.x * W0), y = Math.floor((1 - h.uv1.y) * H0);
    out.lm = dec(data[y * W0 + x]); out.size = W0;
  }
  return out;
}
// Exterior geometry inside the rooms (Blender boxes of clear interior space): samples each triangle along its longest edge
function intrusions() {
  const rooms = { pel: [0.05, 7.55, 0.05, 9.3, 0.1, 2.8], dok: [3.7, 7.55, 0.05, 2.5, 0.1, 2.8], hallW: [-5.95, -1.7, -13.6, 2.4, 0.1, 7.44], hallE: [-1.45, 7.55, -6.5, -0.8, 0.1, 7.44] };
  const out = {};
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), q = new THREE.Vector3(), seen = new Set();
  for (const o of W.meshes) {
    const rv = o.userData.rv;
    if (rv.zone !== 'ext' || seen.has(o.geometry.attributes.position)) continue;
    seen.add(o.geometry.attributes.position);
    const g = o.geometry, p = g.attributes.position, ix = g.index, n = (ix ? ix.count : p.count) / 3;
    o.updateMatrixWorld();
    for (let t = 0; t < n; t++) {
      a.fromBufferAttribute(p, ix ? ix.getX(3 * t) : 3 * t).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(p, ix ? ix.getX(3 * t + 1) : 3 * t + 1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(p, ix ? ix.getX(3 * t + 2) : 3 * t + 2).applyMatrix4(o.matrixWorld);
      for (let i = 0; i < 12; i++) {
        const u = i / 11, v = (i * 7 % 12) / 11 * (1 - u);
        q.set(a.x * (1 - u - v) + b.x * u + c.x * v, a.y * (1 - u - v) + b.y * u + c.y * v, a.z * (1 - u - v) + b.z * u + c.z * v);
        for (const r in rooms) {
          const B = rooms[r], x = q.x, y = -q.z, z = q.y;
          if (x > B[0] && x < B[1] && y > B[2] && y < B[3] && z > B[4] && z < B[5]) {
            const k = o.name.replace(/_c\d+$/, '') + ' in ' + r;
            const e = out[k] || (out[k] = { tris: new Set(), lo: [1e9, 1e9, 1e9], hi: [-1e9, -1e9, -1e9] });
            e.tris.add(t); [x, y, z].forEach((w, m) => { e.lo[m] = Math.min(e.lo[m], w); e.hi[m] = Math.max(e.hi[m], w); });
          }
        }
      }
    }
  }
  return Object.entries(out).map(([k, e]) => ({ k, tris: e.tris.size, lo: e.lo.map((v) => +v.toFixed(2)), hi: e.hi.map((v) => +v.toFixed(2)) }));
}
// Which meshes change a rectangle of the frame when hidden (x, y from the top left, in drawing-buffer pixels)
function blame(x, y, w, h, top = 6) {
  const H = renderer.getDrawingBufferSize(_v2).y;
  const read = () => { const b = new Uint8Array(w * h * 4); gl.readPixels(x, H - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
  W.hideTest = null; drawFrame(0); const base = read();
  const vis = W.meshes.filter((o) => o.visible);
  const out = [];
  for (const m of vis) {
    W.hideTest = (r, o) => o === m;
    drawFrame(0);
    const b = read(); let n = 0;
    for (let k = 0; k < b.length; k += 4) if (Math.abs(b[k] - base[k]) + Math.abs(b[k + 1] - base[k + 1]) + Math.abs(b[k + 2] - base[k + 2]) > 12) n++;
    if (n) out.push({ name: m.name, mat: m.material.name, zone: m.userData.rv.zone, px: n });
  }
  W.hideTest = null; drawFrame(0);
  out.sort((p, q) => q.px - p.px);
  return { visible: vis.length, hits: out.slice(0, top) };
}
// Largest frame anywhere: draws from many points and directions, both passes, and keeps the worst calls and triangles
function sweep(points, yaws = 8, pitches = [0.1, -0.35]) {
  let n = 0, over = 0, overT = 0, mc = null, mt = null;
  for (const [x, y] of points) {
    tp(x, y);
    for (let i = 0; i < yaws; i++) for (const pitch of pitches) {
      player.yaw = i * 2 * Math.PI / yaws; player.pitch = pitch; updateCamera(0);
      drawFrame(0);
      const c = stats.main.calls + stats.planar.calls, t = stats.main.tris + stats.planar.tris;
      const r = { at: [x, y], yaw: Math.round(i * 360 / yaws), pitch, zone: VIS.cam, vis: VIS.all ? 'all' : [...VIS.zones.keys()].join(','), calls: c, main: stats.main.calls, planar: stats.planar.calls, tris: t };
      n++; if (c > 400) over++; if (t > 1e6) overT++;
      if (!mc || c > mc.calls) mc = r;
      if (!mt || t > mt.tris) mt = r;
    }
  }
  return { frames: n, callsOver400: over, trisOver1M: overT, maxCalls: mc, maxTris: mt };
}
// Any pixel that differs with portal culling off means culling hid something visible, which is what pops while walking.
function cullAudit(points, yaws = 8) {
  const keep = [S.planar, S.glare];
  S.planar = false; S.glare = false;
  const s = renderer.getDrawingBufferSize(_v2);
  const read = () => { const b = new Uint8Array(s.x * s.y * 4); gl.readPixels(0, 0, s.x, s.y, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
  const res = [];
  for (const [x, y] of points) {
    tp(x, y);
    for (let i = 0; i < yaws; i++) {
      player.yaw = i * 2 * Math.PI / yaws; player.pitch = 0.12; updateCamera(0);
      drawFrame(0); const a = read();
      const vis = VIS.all ? 'all' : [...VIS.zones.keys()].join(',');
      W.portalsOn = false; drawFrame(0); const b = read(); W.portalsOn = true;
      let bad = 0;
      for (let k = 0; k < a.length; k += 4) if (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]) > 24) bad++;
      res.push({ at: [x, y], yawDeg: Math.round(i * 360 / yaws), bad, frac: +(bad / (s.x * s.y)).toFixed(5), vis });
    }
  }
  [S.planar, S.glare] = keep;
  res.sort((p, q) => q.bad - p.bad);
  return { views: res.length, clean: res.filter((r) => r.bad === 0).length, worst: res.slice(0, 6) };
}
// real input path: a key event on window, the running loop, and the position it produces
async function inputTest(code = 'KeyW', ms = 1000) {
  const p0 = camera.position.clone();
  dispatchEvent(new KeyboardEvent('keydown', { code }));
  await new Promise((r) => setTimeout(r, ms));
  dispatchEvent(new KeyboardEvent('keyup', { code }));
  return { moved: +p0.distanceTo(camera.position).toFixed(3), mode };
}
// cadence of the real loop (physics, UI, minimap, both passes), with W held so the player moves
function rafRate(ms = 4000, walk = false) {
  return new Promise((res) => {
    const ts = [];
    if (walk) keys.KeyW = true;
    const f = (t) => {
      ts.push(t);
      if (t - ts[0] < ms) { requestAnimationFrame(f); return; }
      keys.KeyW = false;
      const d = ts.slice(1).map((x, i) => x - ts[i]);
      res({ frames: d.length, fps: +(1000 * d.length / (ts.at(-1) - ts[0])).toFixed(1), med_ms: +median(d).toFixed(2), p99_ms: +pct(d, 0.99).toFixed(2), max_ms: +Math.max(...d).toFixed(1), ...frameInfo() });
    };
    requestAnimationFrame(f);
  });
}
// Walk a route in real time at a 60 Hz pace, finishing every frame on the GPU before the next starts, so each number is one
// frame's true length and a spike is a real hitch (no queueing as in an unpaced headless loop).
async function pacedWalk(points) {
  const px = new Uint8Array(4), ms = [], worst = [], gpu = [], pend = [];
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const pump = () => {
    while (pend.length && gl.getQueryParameter(pend[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = pend.shift();
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
  };
  setMode('walk');
  for (const [bx, by] of points) {
    const [x, z] = tB(bx, by);
    for (let k = 0; k < 2400; k++) {
      const e = player.capsule.end, dx = x - e.x, dz = z - e.z;
      if (Math.hypot(dx, dz) < 0.3) break;
      let dy = Math.atan2(-dx, -dz) - player.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      player.yaw += dy * 0.12;
      const t0 = performance.now();
      for (let i = 0; i < 4; i++) step(1 / 240, { f: 1, r: 0 });
      updateDoors(1 / 60); updateCamera(1 / 60);
      let q = null;
      if (ext) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
      drawFrame(1 / 60);
      if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pend.push(q); }
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const d = performance.now() - t0;
      if (ext) pump();
      ms.push(d);
      if (d > 25) worst.push({ ms: +d.toFixed(1), zone: VIS.cam, at: [+e.x.toFixed(1), +(-e.z).toFixed(1)], calls: stats.main.calls + stats.planar.calls });
      await new Promise((r) => setTimeout(r, Math.max(0, 16.7 - d)));
    }
  }
  for (let i = 0; i < 50 && pend.length; i++) { await new Promise((r) => setTimeout(r, 10)); pump(); }
  return { gpu: gpu.length ? { n: gpu.length, med: +median(gpu).toFixed(2), p95: +pct(gpu, 0.95).toFixed(2), p99: +pct(gpu, 0.99).toFixed(2), max: +Math.max(...gpu).toFixed(2),
    over16: gpu.filter((v) => v > 16.7).length } : null,
    frames: ms.length, med: +median(ms).toFixed(2), p95: +pct(ms, 0.95).toFixed(2), p99: +pct(ms, 0.99).toFixed(2), max: +Math.max(...ms).toFixed(1),
    over16: ms.filter((v) => v > 16.7).length, over33: ms.filter((v) => v > 33.3).length, worst: worst.slice(0, 8) };
}
function waitFrames(n = 3) { return new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }); }

// ---------------------------------------------------------------- start
resize();
try {
  await load();
} catch (e) {
  console.error(e);
  stage('Gagal memuat: ' + e.message);
  throw e;
}
buildMenus();
const startSpawn = W.spawns.find((s) => s.name === opt.spawn) || W.spawns[0];      // first in the list: Jalan depan
if (startSpawn) gotoSpawn(startSpawn);
chipMsg = null;
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
W.ready = true;
updateCamera(0);
drawFrame(1 / 60);
const info = { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?', timings: W.loadMs, stats: W.stats,
  programs: renderer.info.programs.length, textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries };
window.__spike = { THREE, renderer, scene, camera, W, S, VIS, player, info, opt, drawFrame, bench, frameInfo, walkTo, face,
  toggleDoor, settleDoors, setCamera, tp, warm, gotoCam, gotoSpawn: (n) => gotoSpawn(W.spawns.find((s) => s.name === n)), gotoDrone: (i) => gotoDrone(droneViews()[i]),
  setMode: (m) => setMode(m), interact, doorTarget: () => { const d = doorTarget(); return d && d.id; }, waitFrames, applySettings,
  stopLoop: () => { live = false; }, startLoop: () => { if (!live) { live = true; requestAnimationFrame(loop); } }, zoneAt, drawMap,
  mapImage: () => $('#map canvas').toDataURL('image/png'), screenshot, cullAudit, inputTest, rafRate, progressLog, pacedWalk, liveRoute, sweep, blame, pick, intrusions,
  blobSize: async () => (await captureBlob()).size, keys };
const L = $('#loading');
if (opt.test) { L.remove(); ['#bar-top', '#map', '#zone', '#stick'].forEach((s) => $(s).classList.remove('hidden')); }
else {
  stage(`Siap. ${W.stats.tris > 1e6 ? (W.stats.tris / 1e6).toFixed(2) + ' juta' : Math.round(W.stats.tris / 1000) + ' ribu'} segitiga, dimuat dalam ${(W.loadMs.total / 1000).toFixed(1)} detik.`, 1);
  $('#enter').classList.remove('hidden');
  $('#enter').onclick = () => {
    L.remove();
    ['#bar-top', '#map', '#zone', '#stick'].forEach((s) => $(s).classList.remove('hidden'));
    let seen = false; try { seen = !!localStorage.getItem('demo_help_seen'); localStorage.setItem('demo_help_seen', '1'); } catch { /* ignore */ }
    if (!seen) openMenu('#help'); else if (!TOUCH) canvas.requestPointerLock();
    syncUI();
  };
}
$('#map').addEventListener('click', (e) => {
  if (locked()) return;
  if (TOUCH && !map.big) { map.big = true; $('#map').classList.add('big'); return; }   // the small map is too small to aim at with a finger
  mapClick(e);
  if (TOUCH) { map.big = false; $('#map').classList.remove('big'); }
});
syncUI();
requestAnimationFrame(loop);
document.title = 'Demo walkthrough 3D interaktif';
