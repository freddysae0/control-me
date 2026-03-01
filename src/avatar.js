import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ── Facial expression config ──────────────────────────────────────────────────

const FAST_EXPRESSIONS = new Set([
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeWideLeft',  'eyeWideRight',
  'eyeSquintLeft','eyeSquintRight',
]);

const EXPRESSION_BOOST = {
  jawOpen:           1.35,
  mouthSmileLeft:    1.45,
  mouthSmileRight:   1.45,
  mouthFrownLeft:    1.35,
  mouthFrownRight:   1.35,
  mouthPucker:       1.35,
  mouthFunnel:       1.35,
  mouthShrugUpper:   1.3,
  mouthShrugLower:   1.3,
  mouthRollUpper:    1.3,
  mouthRollLower:    1.3,
  mouthDimpleLeft:   1.3,
  mouthDimpleRight:  1.3,
  cheekPuff:         1.45,
  cheekSquintLeft:   1.35,
  cheekSquintRight:  1.35,
  browDownLeft:      1.35,
  browDownRight:     1.35,
  browInnerUp:       1.35,
  browOuterUpLeft:   1.35,
  browOuterUpRight:  1.35,
  noseSneerLeft:     1.55,
  noseSneerRight:    1.55,
};

const JAW_BONE_NAMES = new Set([
  'Jaw', 'jaw', 'JAW', 'jaw_joint', 'Jaw_Joint', 'JawJoint', 'mixamorig:Jaw',
]);

// ── Pose / arm config ─────────────────────────────────────────────────────────

// MediaPipe PoseLandmarker world landmark indices
const P = {
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW:    13, R_ELBOW:    14,
  L_WRIST:    15, R_WRIST:    16,
};

// [avatarBoneName, childBoneName, fromLandmarkIdx, toLandmarkIdx]
// Direction vectors go FROM the parent joint TO the child joint,
// matching how each bone segment extends in the skeleton.
const ARM_SEGMENTS = [
  ['LeftArm',      'LeftForeArm', P.L_SHOULDER, P.L_ELBOW ],
  ['LeftForeArm',  'LeftHand',    P.L_ELBOW,    P.L_WRIST ],
  ['RightArm',     'RightForeArm',P.R_SHOULDER, P.R_ELBOW ],
  ['RightForeArm', 'RightHand',   P.R_ELBOW,    P.R_WRIST ],
];

export class Avatar {
  constructor() {
    this._morphMap = new Map();
    this._headBone = null;
    this._jawBone  = null;
    this._headRestQuat = new THREE.Quaternion();
    this._jawRestQuat  = new THREE.Quaternion();
    this._currentQuat  = new THREE.Quaternion();
    this._root = null;
    this._current = {};
    this._frameCount = 0;

    // Arm rig: boneName → { bone, restQuat, restParentLocalDir }
    this._armRig = {};

    // Scratch — avoid per-frame allocation ────────────────────────────────────
    this._mat4          = new THREE.Matrix4();
    this._pos           = new THREE.Vector3();
    this._scale         = new THREE.Vector3();
    this._rawQuat       = new THREE.Quaternion();
    this._targetQuat    = new THREE.Quaternion();
    this._jawQuat       = new THREE.Quaternion();
    this._jawEuler      = new THREE.Euler();
    // Arm driving
    this._armDir        = new THREE.Vector3();
    this._armQuat       = new THREE.Quaternion();
    this._armDeltaQuat  = new THREE.Quaternion();
    this._armParentQuat = new THREE.Quaternion();
  }

  // ── Load ─────────────────────────────────────────────────────────────────────

  async load(scene, url = '/avatar.glb') {
    const loader = new GLTFLoader();
    const gltf   = await loader.loadAsync(url);
    this._root   = gltf.scene;

    // Normalise to ~1.6 m and shift eye level to y ≈ 1.58
    const box    = new THREE.Box3().setFromObject(this._root);
    const height = box.max.y - box.min.y;
    this._root.scale.setScalar(1.6 / height);
    box.setFromObject(this._root);
    this._root.position.y = -box.min.y - 0.05;

    scene.add(this._root);

    this._buildMorphMap();
    this._findBones();

    console.log(`[Avatar] Loaded. Morph targets: ${this._morphMap.size}`);
    return this;
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _buildMorphMap() {
    this._morphMap.clear();
    this._root.traverse((node) => {
      if (!node.isMesh || !node.morphTargetDictionary) return;
      for (const [name, index] of Object.entries(node.morphTargetDictionary)) {
        if (!this._morphMap.has(name)) this._morphMap.set(name, []);
        this._morphMap.get(name).push({ mesh: node, index });
        if (this._current[name] === undefined) this._current[name] = 0;
      }
    });
    const names = [...this._morphMap.keys()].sort();
    console.log(`[Avatar] Morph targets (${names.length}):`, names.join(', '));
  }

  _findBones() {
    // Pass 1: collect all bones into a map
    const boneMap = {};
    this._root.traverse((node) => {
      if (!node.isBone) return;
      boneMap[node.name] = node;

      if (node.name === 'Head') {
        this._headBone = node;
        this._headRestQuat.copy(node.quaternion);
      }
      const nl = node.name.toLowerCase();
      if (!this._jawBone && (nl === 'jaw' || nl === 'jaw_joint' || nl === 'jawjoint')) {
        this._jawBone = node;
        this._jawRestQuat.copy(node.quaternion);
        console.log('[Avatar] Jaw bone:', node.name);
      }
    });

    if (!this._headBone) console.warn('[Avatar] No "Head" bone.');
    if (!this._jawBone)  console.warn('[Avatar] No jaw bone — jaw relies on morph targets only.');

    // Pass 2: build arm rig rest-pose data
    this._armRig = {};
    for (const [boneName, childName] of ARM_SEGMENTS) {
      const bone  = boneMap[boneName];
      const child = boneMap[childName];
      if (!bone || !child) {
        console.warn(`[Avatar] Arm pair missing: ${boneName} → ${childName}`);
        continue;
      }

      // World positions in the model's rest (T-pose)
      const bWorldPos = new THREE.Vector3();
      const cWorldPos = new THREE.Vector3();
      bone.getWorldPosition(bWorldPos);
      child.getWorldPosition(cWorldPos);

      // Rest direction in the parent bone's local space (stable through runtime transforms)
      const restWorldDir = cWorldPos.clone().sub(bWorldPos).normalize();
      const parentWorldQuat = new THREE.Quaternion();
      bone.parent.getWorldQuaternion(parentWorldQuat);
      const restParentLocalDir = restWorldDir.clone()
        .applyQuaternion(parentWorldQuat.clone().invert());

      this._armRig[boneName] = {
        bone,
        restQuat: bone.quaternion.clone(),
        restParentLocalDir,
      };
    }
    console.log('[Avatar] Arm rig bones ready:', Object.keys(this._armRig).join(', '));
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Drive facial morph targets from MediaPipe face blend shapes.
   */
  applyBlendShapes(blendshapes) {
    if (!blendshapes) return;

    const raw = {};
    for (const { categoryName, score } of blendshapes) raw[categoryName] = score;

    // Diagnostic every ~3 s
    this._frameCount++;
    if (this._frameCount % 180 === 1) {
      console.log(
        `[Avatar] jawOpen=${raw.jawOpen?.toFixed(3) ?? 'N/A'}`
        + `  mouthClose=${raw.mouthClose?.toFixed(3) ?? 'N/A'}`
        + `  jawOpen mapped: ${this._morphMap.has('jawOpen')}`
        + `  jawBone: ${this._jawBone?.name ?? 'none'}`,
      );
    }

    for (const { categoryName, score } of blendshapes) {
      const targets = this._morphMap.get(categoryName);
      if (!targets) continue;

      let s = score;
      // Suppress mouthClose proportionally when jaw opens — prevents sealed-lip look
      if (categoryName === 'mouthClose') s = Math.max(0, s - (raw.jawOpen ?? 0) * 1.8);

      // Power curve: subtle expressions become clearly visible
      const amplified = Math.pow(s, 0.65);
      const target    = Math.min(1, amplified * (EXPRESSION_BOOST[categoryName] ?? 1.0));
      const lerp      = FAST_EXPRESSIONS.has(categoryName) ? 0.55 : 0.3;

      const prev = this._current[categoryName] ?? 0;
      const next = prev + (target - prev) * lerp;
      this._current[categoryName] = next;

      for (const { mesh, index } of targets) {
        if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = next;
      }
    }

    // Jaw bone drive (for models that use bone-based jaw)
    if (this._jawBone) {
      const jaw = this._current['jawOpen'] ?? 0;
      this._jawEuler.set(jaw * -0.38, 0, 0);
      this._jawQuat.setFromEuler(this._jawEuler);
      this._jawBone.quaternion.copy(this._jawRestQuat).multiply(this._jawQuat);
    }
  }

  /**
   * Drive arm bones from MediaPipe pose world landmarks.
   * @param {Array<{x,y,z,visibility}>|null} worldLandmarks
   */
  applyPose(worldLandmarks) {
    if (!worldLandmarks) return;
    const lm = worldLandmarks;

    for (const [boneName, , fromIdx, toIdx] of ARM_SEGMENTS) {
      const data = this._armRig[boneName];
      if (!data) continue;

      // Build the segment direction vector in Three.js world space.
      // MediaPipe pose world coords:  X right (camera view = mirrored), Y up, Z toward camera
      // Convert → Three.js:           negate X (un-mirror),              Y same, Z same
      this._armDir.set(
        -(lm[toIdx].x - lm[fromIdx].x),
          lm[toIdx].y - lm[fromIdx].y,
          lm[toIdx].z - lm[fromIdx].z,
      );

      if (this._armDir.lengthSq() < 0.0001) continue;
      this._armDir.normalize();

      this._rotateBoneToDir(data);
    }
  }

  /**
   * Drive the head bone from a MediaPipe facial transformation matrix.
   * @param {number[]|null} matrixData  column-major 4×4
   */
  rotateHead(matrixData) {
    if (!this._headBone || !matrixData) return;

    this._mat4.fromArray(matrixData);
    this._mat4.decompose(this._pos, this._rawQuat, this._scale);

    // MediaPipe → Three.js: negate Y and Z of the rotation quaternion
    this._targetQuat.set(
      this._rawQuat.x,
      -this._rawQuat.y,
      -this._rawQuat.z,
       this._rawQuat.w,
    );

    const LERP = 0.2;
    this._currentQuat.slerp(this._targetQuat, LERP);
    this._headBone.quaternion.copy(this._headRestQuat).multiply(this._currentQuat);
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /**
   * Rotate a bone so it points along this._armDir (world space).
   * Uses parent-local-space math so the rest quaternion is preserved as the base.
   */
  _rotateBoneToDir({ bone, restQuat, restParentLocalDir }) {
    // Convert world-space target direction into the parent's local space
    bone.parent.getWorldQuaternion(this._armParentQuat);
    this._armDir.applyQuaternion(this._armParentQuat.invert());
    this._armDir.normalize();

    // Delta rotation: rest direction → target direction (in parent local space)
    this._armDeltaQuat.setFromUnitVectors(restParentLocalDir, this._armDir);

    // Apply delta on top of the rest quaternion, then slerp for smoothness
    this._armQuat.copy(this._armDeltaQuat).multiply(restQuat);
    bone.quaternion.slerp(this._armQuat, 0.2);
  }
}
