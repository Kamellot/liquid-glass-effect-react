import {
  FROST_BLUR_SCALE,
  FROST_MIN_THRESHOLD,
  FROST_SATURATION_SCALE,
  WEBGL_PYRAMID_LEVELS,
} from './constants'
import type { TargetSnapshot } from './domSnapshot'
import { clamp } from './utils'

export interface WebGLBevelParams {
  width: number
  height: number
  hw: number
  hh: number
  bx: number
  by: number
  borderRadius: number
  effectiveDepth: number
  splayExp: number
  cornerExponent: number
  bufWidth: number
  bufHeight: number
}

interface BlurLevel {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
  width: number
  height: number
}

interface CachedSnapTexture {
  tex: WebGLTexture
  version: number
  width: number
  height: number
  blurLevels: BlurLevel[] | null
  blurVersion: number
}

interface GlState {
  canvas: HTMLCanvasElement
  gl: WebGLRenderingContext
  program: WebGLProgram
  downsampleProgram: WebGLProgram
  posBuf: WebGLBuffer
  uSnapshot: WebGLUniformLocation | null
  uBlur1: WebGLUniformLocation | null
  uBlur2: WebGLUniformLocation | null
  uBlur3: WebGLUniformLocation | null
  uBlur4: WebGLUniformLocation | null
  uBlur5: WebGLUniformLocation | null
  uSize: WebGLUniformLocation | null
  uHalfSize: WebGLUniformLocation | null
  uBoxHalf: WebGLUniformLocation | null
  uRadius: WebGLUniformLocation | null
  uEffectiveDepth: WebGLUniformLocation | null
  uSplayExp: WebGLUniformLocation | null
  uCornerExp: WebGLUniformLocation | null
  uSnapOffset: WebGLUniformLocation | null
  uSnapSize: WebGLUniformLocation | null
  uSnapTexel: WebGLUniformLocation | null
  uSnapDpr: WebGLUniformLocation | null
  uDispCssPx: WebGLUniformLocation | null
  uSpread: WebGLUniformLocation | null
  uFrostPx: WebGLUniformLocation | null
  uSat: WebGLUniformLocation | null
  uTint: WebGLUniformLocation | null
  uDsSrc: WebGLUniformLocation | null
  uDsTexel: WebGLUniformLocation | null
  textures: WeakMap<HTMLCanvasElement, CachedSnapTexture>
  contextLost: boolean
}

const VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

const DOWNSAMPLE_VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

// 13-tap dual-filter downsample kernel to avoid ringing across mip levels.
const DOWNSAMPLE_FRAG_SRC = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_srcTexel;

void main() {
  vec2 d = u_srcTexel;
  vec4 c  = texture2D(u_src, v_uv);
  vec4 a  = texture2D(u_src, v_uv + vec2(-2.0, -2.0) * d);
  vec4 b  = texture2D(u_src, v_uv + vec2( 0.0, -2.0) * d);
  vec4 c1 = texture2D(u_src, v_uv + vec2( 2.0, -2.0) * d);
  vec4 d1 = texture2D(u_src, v_uv + vec2(-2.0,  0.0) * d);
  vec4 f  = texture2D(u_src, v_uv + vec2( 2.0,  0.0) * d);
  vec4 g  = texture2D(u_src, v_uv + vec2(-2.0,  2.0) * d);
  vec4 h  = texture2D(u_src, v_uv + vec2( 0.0,  2.0) * d);
  vec4 i  = texture2D(u_src, v_uv + vec2( 2.0,  2.0) * d);

  vec4 j  = texture2D(u_src, v_uv + vec2(-1.0, -1.0) * d);
  vec4 k  = texture2D(u_src, v_uv + vec2( 1.0, -1.0) * d);
  vec4 l  = texture2D(u_src, v_uv + vec2(-1.0,  1.0) * d);
  vec4 m  = texture2D(u_src, v_uv + vec2( 1.0,  1.0) * d);

  gl_FragColor = c * 0.125
    + (b + d1 + f + h) * 0.0625
    + (a + c1 + g + i) * 0.03125
    + (j + k + l + m) * 0.125;
}
`

const FRAG_SRC = `
precision highp float;
varying vec2 v_uv;

uniform sampler2D u_snapshot;
uniform sampler2D u_blur1;
uniform sampler2D u_blur2;
uniform sampler2D u_blur3;
uniform sampler2D u_blur4;
uniform sampler2D u_blur5;
uniform vec2 u_size;
uniform vec2 u_halfSize;
uniform vec2 u_boxHalf;
uniform float u_radius;
uniform float u_effectiveDepth;
uniform float u_splayExp;
uniform float u_cornerExp;
uniform vec2 u_snapOffset;
uniform vec2 u_snapSize;
uniform vec2 u_snapTexel;
uniform float u_snapDpr;
uniform float u_dispCssPx;
uniform float u_spread;
uniform float u_frostPx;
uniform float u_sat;
uniform vec4 u_tint;

float evalBevelMag(float u, float p) {
  if (u <= 0.0) return 0.0;
  if (u >= 1.0) return 1.0;
  return pow(u, p);
}

vec3 applySat(vec3 c, float sat) {
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return clamp(mix(vec3(luma), c, sat), 0.0, 1.0);
}

vec4 sampleTex4(sampler2D tex, vec2 uv, vec2 halfTexel) {
  vec2 lo = halfTexel;
  vec2 hi = 1.0 - halfTexel;
  return (
    texture2D(tex, clamp(uv + vec2(-halfTexel.x, -halfTexel.y), lo, hi)) +
    texture2D(tex, clamp(uv + vec2( halfTexel.x, -halfTexel.y), lo, hi)) +
    texture2D(tex, clamp(uv + vec2(-halfTexel.x,  halfTexel.y), lo, hi)) +
    texture2D(tex, clamp(uv + vec2( halfTexel.x,  halfTexel.y), lo, hi))
  ) * 0.25;
}

vec4 samplePyramidLevel(int idx, vec2 uv) {
  if (idx <= 0) {
    return texture2D(u_snapshot, clamp(uv, u_snapTexel, 1.0 - u_snapTexel));
  }
  vec2 h = u_snapTexel * exp2(float(idx));
  if (idx == 1) return sampleTex4(u_blur1, uv, h);
  if (idx == 2) return sampleTex4(u_blur2, uv, h);
  if (idx == 3) return sampleTex4(u_blur3, uv, h);
  if (idx == 4) return sampleTex4(u_blur4, uv, h);
  return sampleTex4(u_blur5, uv, h);
}

vec4 sampleFrostedSnap(vec2 cssPos) {
  vec2 uv = (u_snapOffset + cssPos) / u_snapSize;
  if (u_frostPx <= 0.05) {
    return texture2D(u_snapshot, clamp(uv, u_snapTexel, 1.0 - u_snapTexel));
  }
  float blurDevPx = u_frostPx * u_snapDpr;
  float lvl = clamp(log2(1.0 + blurDevPx * 0.75), 0.0, 5.0);
  int i0 = int(floor(lvl));
  int i1 = i0 < 5 ? i0 + 1 : 5;
  float f = lvl - float(i0);
  vec4 c0 = samplePyramidLevel(i0, uv);
  vec4 c1 = i1 == i0 ? c0 : samplePyramidLevel(i1, uv);
  vec4 acc = mix(c0, c1, f);
  acc.rgb = applySat(acc.rgb, u_sat);
  return acc;
}

void main() {
  bool hasRefract = u_effectiveDepth > 0.5 && u_dispCssPx > 0.001;
  bool hasFrost = u_frostPx > 0.05;
  if (!hasRefract && !hasFrost) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 fragCss = v_uv * u_size;
  vec2 rel = fragCss - u_halfSize;
  float cx = abs(rel.x);
  float cy = abs(rel.y);

  float qx = cx - u_boxHalf.x;
  float qy = cy - u_boxHalf.y;
  float ox = max(qx, 0.0);
  float oy = max(qy, 0.0);
  float outLen = length(vec2(ox, oy));
  float sd = outLen + min(max(qx, qy), 0.0) - u_radius;

  if (sd > 0.75) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float outerAlpha = sd <= 0.0 ? 1.0 : 1.0 - sd / 0.75;
  float distInward = sd < 0.0 ? -sd : 0.0;
  if (!hasRefract || distInward >= u_effectiveDepth) {
    vec4 s = sampleFrostedSnap(fragCss);
    vec3 rgb = s.rgb;
    if (u_tint.a > 0.001) {
      rgb = mix(rgb, u_tint.rgb, u_tint.a);
    }
    gl_FragColor = vec4(rgb, outerAlpha * s.a);
    return;
  }

  float u = clamp(1.0 - distInward / u_effectiveDepth, 0.0, 1.0);
  if (outerAlpha <= 0.002) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float mag = evalBevelMag(u, u_splayExp) * outerAlpha;

  float ux = 0.0;
  float uy = 0.0;
  if (ox > 0.0 && oy > 0.0) {
    float n1 = u_cornerExp - 1.0;
    float gx = pow(ox, n1);
    float gy = pow(oy, n1);
    float gl = length(vec2(gx, gy));
    if (gl > 0.0) {
      ux = gx / gl;
      uy = gy / gl;
    }
  } else if (outLen > 1e-6) {
    ux = ox / outLen;
    uy = oy / outLen;
  } else if (qx > qy) {
    ux = 1.0;
  } else if (qy > qx) {
    uy = 1.0;
  } else {
    ux = 0.70710678;
    uy = 0.70710678;
  }

  float sxSign = fragCss.x < u_halfSize.x ? 1.0 : -1.0;
  float sySign = fragCss.y < u_halfSize.y ? 1.0 : -1.0;
  vec2 disp = vec2(ux * sxSign, uy * sySign) * (mag * u_dispCssPx);

  vec3 rgb;
  float sA;
  if (u_spread <= 0.0005) {
    vec4 s = sampleFrostedSnap(fragCss + disp);
    rgb = s.rgb;
    sA = s.a;
  } else {
    float m0 = 1.0 - u_spread;
    float m1 = 1.0 - u_spread * 0.5;
    float m3 = 1.0 + u_spread * 0.5;
    float m4 = 1.0 + u_spread;

    vec4 s0 = sampleFrostedSnap(fragCss + disp * m0);
    vec4 s1 = sampleFrostedSnap(fragCss + disp * m1);
    vec4 s2 = sampleFrostedSnap(fragCss + disp);
    vec4 s3 = sampleFrostedSnap(fragCss + disp * m3);
    vec4 s4 = sampleFrostedSnap(fragCss + disp * m4);

    rgb.r = s0.r * 0.65 + s1.r * 0.35;
    rgb.g = s1.g * 0.22 + s2.g * 0.56 + s3.g * 0.22;
    rgb.b = s3.b * 0.35 + s4.b * 0.65;
    sA = s2.a;
  }

  if (u_tint.a > 0.001) {
    rgb = mix(rgb, u_tint.rgb, u_tint.a);
  }

  gl_FragColor = vec4(rgb, outerAlpha * sA);
}
`

let glState: GlState | null = null
let glSupported: boolean | null = null

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function createLinkedProgram(
  gl: WebGLRenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc)
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs)
    if (fs) gl.deleteShader(fs)
    return null
  }

  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    return null
  }
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.bindAttribLocation(program, 0, 'a_pos')
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }
  return program
}

function configureClampLinearTexture(gl: WebGLRenderingContext, tex: WebGLTexture): void {
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
}

function initGlState(): GlState | null {
  if (glSupported === false) return null
  if (glState && !glState.contextLost) return glState
  if (typeof document === 'undefined') return null

  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256

  const opts: WebGLContextAttributes = {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  }
  const gl =
    (canvas.getContext('webgl', opts) as WebGLRenderingContext | null) ||
    (canvas.getContext('experimental-webgl', opts) as WebGLRenderingContext | null)

  if (!gl) {
    glSupported = false
    return null
  }

  const program = createLinkedProgram(gl, VERT_SRC, FRAG_SRC)
  const downsampleProgram = createLinkedProgram(gl, DOWNSAMPLE_VERT_SRC, DOWNSAMPLE_FRAG_SRC)
  if (!program || !downsampleProgram) {
    if (program) gl.deleteProgram(program)
    if (downsampleProgram) gl.deleteProgram(downsampleProgram)
    glSupported = false
    return null
  }

  const posBuf = gl.createBuffer()
  if (!posBuf) {
    gl.deleteProgram(program)
    gl.deleteProgram(downsampleProgram)
    glSupported = false
    return null
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.useProgram(program)

  const state: GlState = {
    canvas,
    gl,
    program,
    downsampleProgram,
    posBuf,
    uSnapshot: gl.getUniformLocation(program, 'u_snapshot'),
    uBlur1: gl.getUniformLocation(program, 'u_blur1'),
    uBlur2: gl.getUniformLocation(program, 'u_blur2'),
    uBlur3: gl.getUniformLocation(program, 'u_blur3'),
    uBlur4: gl.getUniformLocation(program, 'u_blur4'),
    uBlur5: gl.getUniformLocation(program, 'u_blur5'),
    uSize: gl.getUniformLocation(program, 'u_size'),
    uHalfSize: gl.getUniformLocation(program, 'u_halfSize'),
    uBoxHalf: gl.getUniformLocation(program, 'u_boxHalf'),
    uRadius: gl.getUniformLocation(program, 'u_radius'),
    uEffectiveDepth: gl.getUniformLocation(program, 'u_effectiveDepth'),
    uSplayExp: gl.getUniformLocation(program, 'u_splayExp'),
    uCornerExp: gl.getUniformLocation(program, 'u_cornerExp'),
    uSnapOffset: gl.getUniformLocation(program, 'u_snapOffset'),
    uSnapSize: gl.getUniformLocation(program, 'u_snapSize'),
    uSnapTexel: gl.getUniformLocation(program, 'u_snapTexel'),
    uSnapDpr: gl.getUniformLocation(program, 'u_snapDpr'),
    uDispCssPx: gl.getUniformLocation(program, 'u_dispCssPx'),
    uSpread: gl.getUniformLocation(program, 'u_spread'),
    uFrostPx: gl.getUniformLocation(program, 'u_frostPx'),
    uSat: gl.getUniformLocation(program, 'u_sat'),
    uTint: gl.getUniformLocation(program, 'u_tint'),
    uDsSrc: gl.getUniformLocation(downsampleProgram, 'u_src'),
    uDsTexel: gl.getUniformLocation(downsampleProgram, 'u_srcTexel'),
    textures: new WeakMap(),
    contextLost: false,
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    state.contextLost = true
    glState = null
  })
  canvas.addEventListener('webglcontextrestored', () => {
    glState = null
  })

  glState = state
  glSupported = true
  return state
}

export function isWebGLRefractionAvailable(): boolean {
  return initGlState() !== null
}

/** Releases GPU textures and downsample pyramid FBOs owned by a snapshot canvas. */
export function releaseWebGLSnapshot(snapCanvas: HTMLCanvasElement): void {
  const state = glState
  if (!state) return
  const entry = state.textures.get(snapCanvas)
  if (!entry) return
  state.textures.delete(snapCanvas)

  if (state.contextLost || state.gl.isContextLost()) return
  const { gl } = state
  gl.deleteTexture(entry.tex)
  if (entry.blurLevels) {
    for (const level of entry.blurLevels) {
      gl.deleteTexture(level.tex)
      gl.deleteFramebuffer(level.fbo)
    }
    entry.blurLevels = null
  }
}

function allocateBlurPyramid(gl: WebGLRenderingContext): BlurLevel[] | null {
  const levels: BlurLevel[] = []
  for (let i = 0; i < WEBGL_PYRAMID_LEVELS; i++) {
    const tex = gl.createTexture()
    const fbo = gl.createFramebuffer()
    if (!tex || !fbo) {
      if (tex) gl.deleteTexture(tex)
      if (fbo) gl.deleteFramebuffer(fbo)
      for (const level of levels) {
        gl.deleteTexture(level.tex)
        gl.deleteFramebuffer(level.fbo)
      }
      return null
    }
    configureClampLinearTexture(gl, tex)
    levels.push({ tex, fbo, width: 0, height: 0 })
  }
  return levels
}

function ensureBlurPyramid(state: GlState, texEntry: CachedSnapTexture): boolean {
  const { gl } = state
  if (texEntry.blurVersion === texEntry.version && texEntry.blurLevels) {
    return true
  }

  if (!texEntry.blurLevels) {
    texEntry.blurLevels = allocateBlurPyramid(gl)
    if (!texEntry.blurLevels) return false
  }
  const levels = texEntry.blurLevels

  gl.disable(gl.SCISSOR_TEST)
  gl.disable(gl.BLEND)
  gl.useProgram(state.downsampleProgram)
  gl.activeTexture(gl.TEXTURE0)
  gl.uniform1i(state.uDsSrc, 0)

  let srcTex = texEntry.tex
  let srcW = texEntry.width
  let srcH = texEntry.height

  for (let i = 0; i < WEBGL_PYRAMID_LEVELS; i++) {
    const level = levels[i]
    const dstW = Math.max(1, Math.ceil(srcW * 0.5))
    const dstH = Math.max(1, Math.ceil(srcH * 0.5))

    if (level.width !== dstW || level.height !== dstH) {
      gl.bindTexture(gl.TEXTURE_2D, level.tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, dstW, dstH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, level.fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, level.tex, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.useProgram(state.program)
        return false
      }
      level.width = dstW
      level.height = dstH
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, level.fbo)
    }

    gl.viewport(0, 0, dstW, dstH)
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    gl.uniform2f(state.uDsTexel, 1 / srcW, 1 / srcH)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    srcTex = level.tex
    srcW = dstW
    srcH = dstH
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.useProgram(state.program)
  texEntry.blurVersion = texEntry.version
  return true
}

function syncSnapshotTexture(state: GlState, snapshot: TargetSnapshot): CachedSnapTexture | null {
  const { gl } = state
  gl.activeTexture(gl.TEXTURE0)

  let texEntry = state.textures.get(snapshot.canvas)
  if (!texEntry) {
    const tex = gl.createTexture()
    if (!tex) return null
    configureClampLinearTexture(gl, tex)
    texEntry = { tex, version: -1, width: 0, height: 0, blurLevels: null, blurVersion: -1 }
    state.textures.set(snapshot.canvas, texEntry)
  } else {
    gl.bindTexture(gl.TEXTURE_2D, texEntry.tex)
  }

  if (
    texEntry.version !== snapshot.version ||
    texEntry.width !== snapshot.width ||
    texEntry.height !== snapshot.height
  ) {
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snapshot.canvas)
    } catch {
      return null
    }
    texEntry.version = snapshot.version
    texEntry.width = snapshot.width
    texEntry.height = snapshot.height
  }

  return texEntry
}

export function renderRefractedBevelWebGL(
  targetCtx: CanvasRenderingContext2D,
  field: WebGLBevelParams,
  snapshot: TargetSnapshot,
  offsetX: number,
  offsetY: number,
  dispCssPx: number,
  spread: number,
  tintRgba: [number, number, number, number] | null,
  frost = 0,
): boolean {
  const state = initGlState()
  if (!state) return false

  const { gl, canvas } = state
  if (gl.isContextLost()) {
    state.contextLost = true
    glState = null
    return false
  }

  const { bufWidth, bufHeight } = field
  if (canvas.width < bufWidth || canvas.height < bufHeight) {
    canvas.width = Math.max(canvas.width, bufWidth)
    canvas.height = Math.max(canvas.height, bufHeight)
  }

  const texEntry = syncSnapshotTexture(state, snapshot)
  if (!texEntry) return false

  const frostClamped = clamp(frost, 0, 100)
  const frostPx = frostClamped * FROST_BLUR_SCALE
  const hasBlurPyramid = frostPx > FROST_MIN_THRESHOLD && ensureBlurPyramid(state, texEntry)

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texEntry.tex)
  for (let i = 0; i < WEBGL_PYRAMID_LEVELS; i++) {
    gl.activeTexture(gl.TEXTURE1 + i)
    gl.bindTexture(
      gl.TEXTURE_2D,
      hasBlurPyramid && texEntry.blurLevels ? texEntry.blurLevels[i].tex : texEntry.tex,
    )
  }
  gl.activeTexture(gl.TEXTURE0)

  // Scissor restricts clear and fragment shading to the element's exact subregion inside the shared WebGL backing canvas.
  gl.viewport(0, 0, bufWidth, bufHeight)
  gl.enable(gl.SCISSOR_TEST)
  gl.scissor(0, 0, bufWidth, bufHeight)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)

  gl.uniform1i(state.uSnapshot, 0)
  gl.uniform1i(state.uBlur1, 1)
  gl.uniform1i(state.uBlur2, 2)
  gl.uniform1i(state.uBlur3, 3)
  gl.uniform1i(state.uBlur4, 4)
  gl.uniform1i(state.uBlur5, 5)
  gl.uniform2f(state.uSize, field.width, field.height)
  gl.uniform2f(state.uHalfSize, field.hw, field.hh)
  gl.uniform2f(state.uBoxHalf, field.bx, field.by)
  gl.uniform1f(state.uRadius, field.borderRadius)
  gl.uniform1f(state.uEffectiveDepth, field.effectiveDepth)
  gl.uniform1f(state.uSplayExp, field.splayExp)
  gl.uniform1f(state.uCornerExp, field.cornerExponent)
  gl.uniform2f(state.uSnapOffset, offsetX, offsetY)
  gl.uniform2f(state.uSnapSize, snapshot.cssWidth, snapshot.cssHeight)
  gl.uniform2f(state.uSnapTexel, 0.5 / snapshot.width, 0.5 / snapshot.height)
  gl.uniform1f(state.uSnapDpr, snapshot.cssWidth > 0 ? snapshot.width / snapshot.cssWidth : 1)
  gl.uniform1f(state.uDispCssPx, dispCssPx)
  gl.uniform1f(state.uSpread, spread)
  gl.uniform1f(state.uFrostPx, hasBlurPyramid ? frostPx : 0)
  gl.uniform1f(state.uSat, 1 + (frostClamped * FROST_SATURATION_SCALE) / 100)
  if (tintRgba) {
    gl.uniform4f(state.uTint, tintRgba[0], tintRgba[1], tintRgba[2], tintRgba[3])
  } else {
    gl.uniform4f(state.uTint, 0, 0, 0, 0)
  }

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

  targetCtx.clearRect(0, 0, bufWidth, bufHeight)
  targetCtx.drawImage(canvas, 0, canvas.height - bufHeight, bufWidth, bufHeight, 0, 0, bufWidth, bufHeight)
  return true
}
