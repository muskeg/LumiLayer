import { hexToRgb, srgbToLinear } from '../color';
import { MAX_BANDS, type StackLayer } from './model';
import { CHROMA_WEIGHT, MATCH_TIE, oneLayer, type HeightMode } from './optics';

export const VERTEX_SHADER = /* glsl */ `#version 300 es
out vec2 v_uv;
void main() {
  // Fullscreen triangle from the vertex id: (0,0), (2,0), (0,2). No vertex buffers needed.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = vec2(p.x, 1.0 - p.y); // image row 0 at the top
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

#define MAX_LAYERS ${MAX_BANDS}

uniform sampler2D u_image;                  // RGBA32F: rgb = sRGB colour, a = luminance 0..1 (or < 0 for frame pixels)
uniform int u_layerCount;
uniform vec2 u_layerHeights[MAX_LAYERS];    // (startZ, endZ) in mm, bottom to top
uniform vec3 u_layerR[MAX_LAYERS];          // Kubelka-Munk reflectance of one layer of the band's filament (linear)
uniform vec3 u_layerT[MAX_LAYERS];          // and its transmittance
uniform float u_layerHeight;                // mm
uniform float u_minLayers;                  // lowest printable height, in layers
uniform float u_maxLayers;                  // highest printable height (top of the stack), in layers
uniform float u_frameLayers;                // height of frame pixels, in layers
uniform int u_mode;                         // 0 = backlit transmission, 1 = front-lit reflection
uniform int u_heightMode;                   // 0 = height from luminance, 1 = height whose colour best matches the pixel
uniform float u_chromaWeight;               // colour-match weight of chroma vs lightness
uniform int u_output;                       // 0 = display colour, 1 = layer count / 255 (read back for export)
uniform vec3 u_light;                       // linear light colour * exposure

in vec2 v_uv;
out vec4 outColor;

// Same constant as the CPU model in optics.ts.
const float MATCH_TIE = ${MATCH_TIE.toPrecision(16)};

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec3 toOklab(vec3 c) {
  vec3 lms = vec3(
    0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b,
    0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b,
    0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  lms = pow(max(lms, vec3(0.0)), vec3(1.0 / 3.0));
  return vec3(
    0.2104542553 * lms.x + 0.793617785 * lms.y - 0.0040720468 * lms.z,
    1.9779984951 * lms.x - 2.428592205 * lms.y + 0.4505937099 * lms.z,
    0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.808675766 * lms.z);
}

// Walk the front-lit colour up the stack and return the height (layers) that best matches the pixel.
float matchLayers(vec3 srgb) {
  float cw = sqrt(u_chromaWeight);
  vec3 target = toOklab(toLinear(srgb)) * vec3(1.0, cw, cw);
  float best = u_minLayers;
  float bestErr = 1e9;
  vec3 below = vec3(0.0);
  for (int i = 0; i < MAX_LAYERS; ++i) {
    if (i >= u_layerCount) break;
    float s = floor(u_layerHeights[i].x / u_layerHeight + 0.5);
    float e = floor(u_layerHeights[i].y / u_layerHeight + 0.5);
    vec3 r = u_layerR[i];
    vec3 t = u_layerT[i];
    // Height s belongs to the band below; add this band's layers one at a time over what's below.
    for (float h = s + 1.0; h <= e; h += 1.0) {
      below = r + t * t * below / (1.0 - r * below);
      if (h < u_minLayers || h > u_maxLayers) continue;
      vec3 d = toOklab(below) * vec3(1.0, cw, cw) - target;
      float err = dot(d, d);
      if (err < bestErr - MATCH_TIE) {
        bestErr = err;
        best = h;
      }
    }
  }
  return best;
}

void main() {
  ivec2 size = textureSize(u_image, 0);
  ivec2 texel = clamp(ivec2(v_uv * vec2(size)), ivec2(0), size - 1);
  vec4 px = texelFetch(u_image, texel, 0);

  // Z(x, y) in whole layers. Luminance mode rounds half up, identical to layersFromLuminance().
  float layers = px.a < 0.0 ? u_frameLayers
    : u_heightMode == 1 ? matchLayers(px.rgb)
    : floor(u_minLayers + px.a * (u_maxLayers - u_minLayers) + 0.5);
  if (u_output == 1) {
    outColor = vec4(layers / 255.0, 0.0, 0.0, 1.0);
    return;
  }
  // Kubelka-Munk stack seen from the top: reflectance over black (front-lit) and transmittance (backlit).
  vec3 R = vec3(0.0);
  vec3 T = vec3(1.0);
  for (int i = 0; i < MAX_LAYERS; ++i) {
    if (i >= u_layerCount) break;
    float s = floor(u_layerHeights[i].x / u_layerHeight + 0.5);
    float top = min(layers, floor(u_layerHeights[i].y / u_layerHeight + 0.5));
    vec3 r = u_layerR[i];
    vec3 t = u_layerT[i];
    for (float h = s + 1.0; h <= top; h += 1.0) {
      vec3 den = 1.0 - r * R;
      T = T * t / den;
      R = r + t * t * R / den;
    }
  }
  vec3 c = u_mode == 0 ? T : R;
  outColor = vec4(toSrgb(c * u_light), 1.0);
}`;

export type OpticalMode = 'frontlit' | 'backlit';

export interface PreviewParams {
  layerHeight: number;
  minLayers: number;
  maxLayers: number;
  frameLayers: number;
  mode: OpticalMode;
  heightMode: HeightMode;
  /** Light colour (sRGB hex) and exposure multiplier. */
  light: string;
  exposure: number;
}

const UNIFORMS = [
  'u_image', 'u_layerCount', 'u_layerHeights', 'u_layerR', 'u_layerT',
  'u_layerHeight', 'u_minLayers', 'u_maxLayers', 'u_frameLayers', 'u_mode', 'u_light',
  'u_heightMode', 'u_chromaWeight', 'u_output',
] as const;
type UniformName = (typeof UNIFORMS)[number];

// Matches --stage in style.css.
const BACKGROUND = [0x10 / 255, 0x0f / 255, 0x0e / 255];

interface GlState {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  texture: WebGLTexture;
  loc: Record<UniformName, WebGLUniformLocation | null>;
}

/**
 * WebGL2 viewport for the filament painting preview. Changing the layer stack or light only updates
 * uniforms, so slider drags render at display refresh rate; the luminance texture is uploaded only
 * when the image itself changes.
 */
export class PaintPreview {
  private state: GlState | null = null;
  private image: { data: Float32Array; cols: number; rows: number } | null = null;
  private layers: StackLayer[] = [];
  private params: PreviewParams = { layerHeight: 0.08, minLayers: 1, maxLayers: 2, frameLayers: 1, mode: 'frontlit', heightMode: 'match', light: '#ffffff', exposure: 1 };
  private frame = 0;
  private readonly heights = new Float32Array(MAX_BANDS * 2);
  private readonly layerR = new Float32Array(MAX_BANDS * 3);
  private readonly layerT = new Float32Array(MAX_BANDS * 3);
  private readonly resizeObserver: ResizeObserver;
  error: string | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.state = null;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.init();
      if (this.image) this.upload();
      this.requestRender();
    });
    this.resizeObserver = new ResizeObserver(() => this.requestRender());
    this.resizeObserver.observe(canvas);
    this.init();
  }

  get ready() {
    return this.state !== null;
  }

  setImage(data: Float32Array, cols: number, rows: number) {
    this.image = { data, cols, rows };
    this.upload();
    this.requestRender();
  }

  setLayers(layers: StackLayer[]) {
    this.layers = layers.slice(0, MAX_BANDS);
    this.requestRender();
  }

  setParams(params: Partial<PreviewParams>) {
    Object.assign(this.params, params);
    this.requestRender();
  }

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** Render at image resolution and return it as a 2D canvas (e.g. as a texture for the 3D view). */
  snapshot(): HTMLCanvasElement | null {
    const pixels = this.renderOffscreen(0);
    if (!pixels || !this.image) return null;
    const { cols, rows } = this.image;
    const out = document.createElement('canvas');
    out.width = cols;
    out.height = rows;
    const img = new ImageData(cols, rows);
    img.data.set(pixels);
    out.getContext('2d')!.putImageData(img, 0, 0);
    return out;
  }

  /** Exact printed height (layers) of every pixel as computed by the shader, row 0 = top. Null without WebGL. */
  readLayers(): Uint8Array | null {
    const pixels = this.renderOffscreen(1);
    if (!pixels) return null;
    const out = new Uint8Array(pixels.length / 4);
    for (let i = 0; i < out.length; i++) out[i] = pixels[i * 4];
    return out;
  }

  /** Draw into an image-sized RGBA8 target and return its pixels top row first. */
  private renderOffscreen(output: 0 | 1): Uint8Array | null {
    const s = this.state;
    if (!s || !this.image || this.error) return null;
    const { gl } = s;
    const { cols, rows } = this.image;
    const target = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.viewport(0, 0, cols, rows);
    this.drawQuad(output);
    const raw = new Uint8Array(cols * rows * 4);
    gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(target);
    // readPixels starts at the bottom row.
    const pixels = new Uint8Array(raw.length);
    const stride = cols * 4;
    for (let y = 0; y < rows; y++) pixels.set(raw.subarray((rows - 1 - y) * stride, (rows - y) * stride), y * stride);
    return pixels;
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    const s = this.state;
    if (s) {
      s.gl.deleteTexture(s.texture);
      s.gl.deleteVertexArray(s.vao);
      s.gl.deleteProgram(s.program);
    }
    this.state = null;
  }

  private init() {
    const gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) {
      this.error = 'WebGL2 is not available in this browser.';
      return;
    }
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost())
        throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(sh)}`);
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost())
      throw new Error(`Shader link failed: ${gl.getProgramInfoLog(program)}`);

    const loc = {} as Record<UniformName, WebGLUniformLocation | null>;
    for (const name of UNIFORMS) loc[name] = gl.getUniformLocation(program, name);

    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Float textures are not filterable without an extension; texelFetch doesn't need filtering anyway.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.state = { gl, program, vao: gl.createVertexArray()!, texture, loc };
    this.error = null;
  }

  private upload() {
    const s = this.state;
    if (!s || !this.image) return;
    const { gl } = s;
    const { data, cols, rows } = this.image;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (cols > max || rows > max) {
      this.error = `Image grid ${cols}×${rows} exceeds the GPU texture limit (${max}). Increase the pixel size.`;
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, s.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    // 16 B/pixel; MAX_PIXELS (settings.ts) keeps this under ~25 MB of GPU memory.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0, gl.RGBA, gl.FLOAT, data);
    this.error = null;
  }

  private draw() {
    const s = this.state;
    if (!s) return;
    const { gl } = s;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.image || this.error) return;

    // Letterbox the image into the canvas (same fit as CSS object-fit: contain).
    const aspect = this.image.cols / this.image.rows;
    let vw = w, vh = Math.round(w / aspect);
    if (vh > h) {
      vh = h;
      vw = Math.round(h * aspect);
    }
    gl.viewport(Math.floor((w - vw) / 2), Math.floor((h - vh) / 2), vw, vh);
    this.drawQuad(0);
  }

  private drawQuad(output: 0 | 1) {
    const s = this.state!;
    const { gl, loc } = s;
    const p = this.params;
    const n = this.layers.length;
    this.heights.fill(0);
    this.layerR.fill(0);
    this.layerT.fill(1);
    this.layers.forEach((l, i) => {
      this.heights[i * 2] = l.startZ;
      this.heights[i * 2 + 1] = l.endZ;
      const { r, t } = oneLayer(l.colorHex, l.td, p.layerHeight);
      this.layerR.set(r, i * 3);
      this.layerT.set(t, i * 3);
    });
    const light = hexToRgb(p.light).map((c) => srgbToLinear(c) * p.exposure);

    gl.useProgram(s.program);
    gl.bindVertexArray(s.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, s.texture);
    gl.uniform1i(loc.u_image, 0);
    gl.uniform1i(loc.u_layerCount, n);
    gl.uniform2fv(loc.u_layerHeights, this.heights);
    gl.uniform3fv(loc.u_layerR, this.layerR);
    gl.uniform3fv(loc.u_layerT, this.layerT);
    gl.uniform1f(loc.u_layerHeight, p.layerHeight);
    gl.uniform1f(loc.u_minLayers, p.minLayers);
    gl.uniform1f(loc.u_maxLayers, p.maxLayers);
    gl.uniform1f(loc.u_frameLayers, p.frameLayers);
    gl.uniform1i(loc.u_mode, p.mode === 'backlit' ? 0 : 1);
    gl.uniform1i(loc.u_heightMode, p.heightMode === 'match' ? 1 : 0);
    gl.uniform1f(loc.u_chromaWeight, CHROMA_WEIGHT);
    gl.uniform1i(loc.u_output, output);
    gl.uniform3f(loc.u_light, light[0], light[1], light[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}
