import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export function createScene(canvas) {
  // ── Renderer ──────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  // LinearSRGBColorSpace prevents bloom from washing out colors
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  // ── Scene ─────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0f);
  scene.fog = new THREE.FogExp2(0x0a0a0f, 0.18);

  // ── Camera ────────────────────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, 1.65, 2.2);
  camera.lookAt(0, 1.55, 0);

  // ── Lighting ──────────────────────────────────────────────────────────────

  // Warm key light — front-right
  const keyLight = new THREE.DirectionalLight(0xfff3e0, 2.5);
  keyLight.position.set(2.5, 3.5, 2);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 0.1;
  keyLight.shadow.camera.far = 20;
  keyLight.shadow.camera.left = -3;
  keyLight.shadow.camera.right = 3;
  keyLight.shadow.camera.top = 4;
  keyLight.shadow.camera.bottom = -1;
  keyLight.shadow.bias = -0.001;
  scene.add(keyLight);

  // Cool rim light — left-back (gives depth + edge glow)
  const rimLight = new THREE.DirectionalLight(0x6699ff, 1.8);
  rimLight.position.set(-3, 2.5, -2);
  scene.add(rimLight);

  // Soft fill — front-left
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
  fillLight.position.set(-1.5, 1.8, 2);
  scene.add(fillLight);

  // Ambient base
  const ambientLight = new THREE.AmbientLight(0x112233, 1.2);
  scene.add(ambientLight);

  // ── Post-processing ───────────────────────────────────────────────────────
  const composer = new EffectComposer(renderer);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.35,   // strength
    0.5,    // radius
    0.82,   // threshold
  );
  composer.addPass(bloomPass);

  // OutputPass converts linear→sRGB for display
  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  // ── Resize handler ────────────────────────────────────────────────────────
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
