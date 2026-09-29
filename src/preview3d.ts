import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { addBody, MeshBuilder, type Heightfield } from './mesh';

const MAX_GRID = 320;

/** What to show: a lithophane (viewed from the bed side) or a front-lit print (viewed from the top). */
export interface Preview3DInput {
  frontLit: boolean;
  hf: Heightfield;
  /** Litho: color slab thickness under the body. */
  slab: number;
  baseColor: string;
}

export class Preview3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
  private controls: OrbitControls;
  private group = new THREE.Group();
  private bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide });
  private backMat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
  private faceMat = new THREE.MeshBasicMaterial();
  private simTex: THREE.CanvasTexture | null = null;
  private frontTex: THREE.CanvasTexture | null = null;
  private backlit = true;
  private frontLit = false;
  private key: THREE.DirectionalLight;
  private framedSize = '';

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color('#15171c');
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#303040', 1.2));
    const key = new THREE.DirectionalLight('#ffffff', 1.6);
    key.position.set(-1, 1.5, -2);
    this.key = key;
    this.scene.add(key);
    const back = new THREE.DirectionalLight('#ffffff', 0.8);
    back.position.set(1, 1, 2);
    this.scene.add(back);
    this.scene.add(this.group);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.render());
    new ResizeObserver(() => this.resize()).observe(container);
  }

  setBacklit(on: boolean) {
    this.backlit = on;
    this.applyFaceTexture();
    this.render();
  }

  update(input: Preview3DInput, sim: HTMLCanvasElement, front: HTMLCanvasElement) {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      (child as THREE.Mesh).geometry.dispose();
    }
    const r = input.hf;
    const w = r.cols * r.pixelMm;
    const h = r.rows * r.pixelMm;
    const { frontLit, slab } = input;

    const b = new MeshBuilder();
    // No bottom: the textured face covers it (drawing both causes z-fighting).
    addBody(b, r, {
      zBottom: 0,
      zTop: slab,
      step: Math.max(1, Math.ceil(Math.max(r.cols, r.rows) / MAX_GRID)),
    });
    // Front-lit prints are viewed from the top, so mirror X (and flip winding to keep normals outward).
    const m = b.finish(frontLit);
    const geo = new THREE.BufferGeometry();
    if (frontLit) {
      const uv = new Float32Array((m.positions.length / 3) * 2);
      for (let i = 0, j = 0; i < m.positions.length; i += 3, j += 2) {
        m.positions[i] = w - m.positions[i];
        uv[j] = m.positions[i] / w;
        uv[j + 1] = m.positions[i + 1] / h;
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    geo.computeVertexNormals();
    this.bodyMat.color.set(frontLit ? '#ffffff' : input.baseColor);
    this.group.add(new THREE.Mesh(geo, this.bodyMat));

    // Litho: textured viewing face. Painting: the back of the print, which is the first band's filament.
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), frontLit ? this.backMat : this.faceMat);
    this.backMat.color.set(input.baseColor);
    plane.rotation.y = Math.PI;
    plane.position.set(w / 2, h / 2, 0);
    this.group.add(plane);

    this.simTex?.dispose();
    this.frontTex?.dispose();
    this.simTex = new THREE.CanvasTexture(sim);
    this.frontTex = new THREE.CanvasTexture(front);
    for (const t of [this.simTex, this.frontTex]) {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
    }
    this.frontLit = frontLit;
    this.key.position.set(-1, 1.5, frontLit ? 2 : -2);
    this.applyFaceTexture();

    const size = `${frontLit}:${w.toFixed(1)}x${h.toFixed(1)}`;
    if (size !== this.framedSize) {
      this.framedSize = size;
      this.controls.target.set(w / 2, h / 2, frontLit ? 0 : 1);
      const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      const dist = 1.2 * Math.max(h / 2 / tan, w / 2 / (tan * this.camera.aspect));
      // Front-lit: look down at the top with a slight tilt; litho: look at the bed face (-Z).
      if (frontLit) this.camera.position.set(w / 2, h / 2 - dist * 0.35, dist * 0.95);
      else this.camera.position.set(w / 2, h / 2, -dist);
      this.camera.near = dist / 50;
      this.camera.far = dist * 20;
      this.camera.updateProjectionMatrix();
      this.controls.minDistance = dist / 10;
      this.controls.maxDistance = dist * 5;
      this.camera.up.set(0, 1, 0);
      this.controls.update();
    }
    this.render();
  }

  private applyFaceTexture() {
    const tex = this.backlit ? this.simTex : this.frontTex;
    this.faceMat.map = tex;
    this.faceMat.needsUpdate = true;
    this.bodyMat.map = this.frontLit ? tex : null;
    this.bodyMat.needsUpdate = true;
    this.scene.background = new THREE.Color(this.backlit && !this.frontLit ? '#0b0c0f' : '#20232a');
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    // updateStyle=false: CSS sizes the canvas, so resizing the buffer doesn't re-trigger the ResizeObserver.
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
