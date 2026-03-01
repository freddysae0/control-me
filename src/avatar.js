import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class Avatar {
  constructor() {
    this._root     = null;
    this._hipsBone = null;
  }

  async load(scene, url = '/avatar.glb') {
    const loader = new GLTFLoader();
    const gltf   = await loader.loadAsync(url);
    this._root   = gltf.scene;

    // Normalise to ~1.6 m tall, feet near y = 0
    const box    = new THREE.Box3().setFromObject(this._root);
    const height = box.max.y - box.min.y;
    this._root.scale.setScalar(1.6 / height);
    box.setFromObject(this._root);
    this._root.position.y = -box.min.y; // feet at y = 0, matching the ground plane

    scene.add(this._root);
    this._findHipsBone();

    console.log('[Avatar] Loaded.');
    return this;
  }

  get rootObject() { return this._root; }
  get hipsBone()   { return this._hipsBone; }

  _findHipsBone() {
    // Common Mixamo / BIP / generic hips names
    this._root.traverse((node) => {
      if (!node.isBone || this._hipsBone) return;
      const n = node.name.toLowerCase();
      if (
        node.name === 'Hips' || node.name === 'mixamorig:Hips' ||
        node.name === 'Bip001' || n === 'hips' || n === 'pelvis'
      ) {
        this._hipsBone = node;
        console.log('[Avatar] Hips bone:', node.name);
      }
    });

    // Fallback: any bone whose parent is not a bone (= skeleton root)
    if (!this._hipsBone) {
      this._root.traverse((node) => {
        if (!node.isBone || this._hipsBone) return;
        if (!node.parent?.isBone) {
          this._hipsBone = node;
          console.log('[Avatar] Hips bone (fallback):', node.name);
        }
      });
    }

    if (!this._hipsBone) console.warn('[Avatar] No hips/root bone found — ragdoll disabled.');
  }
}
