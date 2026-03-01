import * as THREE from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }      from 'three/addons/postprocessing/OutputPass.js';

export function createScene(canvas) {
  // ── Renderer ───────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.6;   // brighter overall
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  // ── Scene ──────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080810);
  scene.fog = new THREE.FogExp2(0x080810, 0.10);

  // ── Camera ─────────────────────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, 0.9, 2.8);
  camera.lookAt(0, 0.7, 0);

  // ── Base fill — prevents shadow areas from going pitch-black ──────────────
  // HemisphereLight gives a sky colour from above and a ground colour below.
  const hemi = new THREE.HemisphereLight(
    0x334466,   // sky: cool blue-grey
    0x1a1a2e,   // ground: deep navy
    3.0,
  );
  scene.add(hemi);

  // ── Focal spotlights ───────────────────────────────────────────────────────
  // With decay = 2 (physically correct), effective brightness at distance d is
  // intensity / d².  Key light is ~5 units away → needs intensity ≥ 5² × 4 ≈ 100
  // to read as clearly lit through ACESFilmic tone mapping.

  const MID  = new THREE.Vector3(0, 0.8, 0);  // avatar torso
  const HEAD = new THREE.Vector3(0, 1.3, 0);  // avatar head/shoulder area

  function spot({ color, intensity, pos, target = MID, angle, penumbra = 0.4, dist = 14, shadow = false }) {
    const l = new THREE.SpotLight(color, intensity, dist, angle, penumbra, 2);
    l.position.set(...pos);
    l.target.position.copy(target);
    if (shadow) {
      l.castShadow = true;
      l.shadow.mapSize.set(1024, 1024);
      l.shadow.camera.near = 0.5;
      l.shadow.camera.far  = dist;
      l.shadow.bias = -0.001;
    }
    scene.add(l);
    scene.add(l.target);
    return l;
  }

  // 1. KEY — warm ivory, upper-front. Main light, casts shadows.
  spot({
    color: 0xfff5dd, intensity: 120,
    pos: [1.0, 5.0, 2.5], target: HEAD,
    angle: Math.PI / 8,   // ~22° narrow beam
    penumbra: 0.3,
    shadow: true,
  });

  // 2. RIM — electric blue, upper-back-left. Edge glow on silhouette.
  spot({
    color: 0x4488ff, intensity: 90,
    pos: [-2.5, 4.5, -2.2], target: HEAD,
    angle: Math.PI / 7,
    penumbra: 0.45,
  });

  // 3. SIDE — warm amber-orange, right mid-height. Colour accent fill.
  spot({
    color: 0xff7722, intensity: 70,
    pos: [3.8, 2.5, 1.0],
    angle: Math.PI / 6,
    penumbra: 0.5,
    dist: 10,
  });

  // 4. FLOOR / DRAMA — violet-magenta, low front-left. Upward sweep + floor pool.
  spot({
    color: 0xcc33ff, intensity: 60,
    pos: [-1.5, 0.1, 2.0], target: MID,
    angle: Math.PI / 5,
    penumbra: 0.6,
    dist: 8,
  });

  // 5. BACK TEAL — directly behind at mid height. Separates avatar from bg.
  spot({
    color: 0x00ccaa, intensity: 55,
    pos: [0, 3.0, -3.2], target: HEAD,
    angle: Math.PI / 6,
    penumbra: 0.5,
  });

  // ── Ground plane — y = 0, matches FLOOR_Y in ragdoll.js ───────────────────
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.MeshStandardMaterial({ color: 0x0c0c18, roughness: 0.65, metalness: 0.35 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y  = 0;
  floor.receiveShadow = true;
  scene.add(floor);

  // ── Post-processing ────────────────────────────────────────────────────────
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.6,    // strength
    0.65,   // radius
    0.55,   // threshold — lower so colour spots bloom clearly
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  // ── Resize handler ─────────────────────────────────────────────────────────
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloomPass.setSize(w, h);
  });

  return { renderer, scene, camera, composer };
}
