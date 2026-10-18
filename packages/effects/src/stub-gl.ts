// SPDX-License-Identifier: Apache-2.0
// A WebGL2 context that draws nothing (S6.01): the WebGL build of the runtime runs over it in Node,
// for the converter's dry run of every uploaded effect and for the loader's fuzzing in CI. The
// runtime simulates and builds its vertices exactly as it would in the client; only the GPU's part
// is skipped. What it would have drawn is counted the way Effekseer's GL renderer draws it: models
// (.efkmodel and procedural meshes) by the programs whose vertex shader places them with a model
// matrix (mModel, in EffekseerRendererGL's ShaderHeader), as triangles times instances; everything
// else (sprites, ribbons, rings, tracks: the runtime's squares) as quads, six indices each.

/** What the runtime asked the stand-in to draw since the last reset. */
export interface DrawCount {
  calls: number;
  quads: number;
  modelTriangles: number;
}

const GL = {
  TRIANGLES: 0x0004,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  VALIDATE_STATUS: 0x8b83,
  DELETE_STATUS: 0x8b80,
  ACTIVE_UNIFORMS: 0x8b86,
  ACTIVE_ATTRIBUTES: 0x8b89,
  ACTIVE_UNIFORM_BLOCKS: 0x8a36,
  SHADER_TYPE: 0x8b4f,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
  MAX_RENDERBUFFER_SIZE: 0x84e8,
  MAX_VIEWPORT_DIMS: 0x0d3a,
  MAX_DRAW_BUFFERS: 0x8824,
  MAX_COLOR_ATTACHMENTS: 0x8cdf,
  MAX_SAMPLES: 0x8d57,
  MAX_UNIFORM_BUFFER_BINDINGS: 0x8a2f,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
  VIEWPORT: 0x0ba2,
  SCISSOR_BOX: 0x0c10,
  COLOR_CLEAR_VALUE: 0x0c22,
  COLOR_WRITEMASK: 0x0c23,
  VERSION: 0x1f02,
  VENDOR: 0x1f00,
  RENDERER: 0x1f01,
  SHADING_LANGUAGE_VERSION: 0x8b8c,
  NO_ERROR: 0,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
};

/** The stand-in and its counter. Its constants are WebGL's for the names the runtime reads off
 *  the context; any other name reads as 0, any other method does nothing and returns nothing. */
export function stubGl(): { gl: object; count: DrawCount; reset(): void } {
  const count: DrawCount = { calls: 0, quads: 0, modelTriangles: 0 };
  const object = (): object => ({});
  let program: { model?: boolean } | null = null;
  const drew = (mode: number, indices: number, instances = 1): void => {
    count.calls += 1;
    if (mode !== GL.TRIANGLES) return;
    if (program?.model) count.modelTriangles += Math.floor(indices / 3) * Math.max(0, instances);
    else count.quads += Math.floor(indices / 6) * Math.max(0, instances);
  };
  const methods: Record<string, (...a: unknown[]) => unknown> = {
    getContextAttributes: () => ({ alpha: true, depth: true, stencil: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false }),
    isContextLost: () => false,
    getError: () => GL.NO_ERROR,
    getSupportedExtensions: () => [],
    getExtension: () => null,
    createBuffer: object,
    createTexture: object,
    createProgram: object,
    createShader: object,
    createFramebuffer: object,
    createRenderbuffer: object,
    createVertexArray: object,
    createQuery: object,
    createSampler: object,
    getUniformLocation: object,
    getAttribLocation: () => 0,
    getUniformBlockIndex: () => 0,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    checkFramebufferStatus: () => GL.FRAMEBUFFER_COMPLETE,
    getShaderParameter: (_s, pname) => (pname === GL.SHADER_TYPE ? 0 : true),
    getProgramParameter: (_p, pname) => (pname === GL.ACTIVE_UNIFORMS || pname === GL.ACTIVE_ATTRIBUTES || pname === GL.ACTIVE_UNIFORM_BLOCKS ? 0 : true),
    getParameter: (pname) => {
      switch (pname) {
        case GL.VERSION:
          return 'WebGL 2.0 (FlatChat stand-in)';
        case GL.SHADING_LANGUAGE_VERSION:
          return 'WebGL GLSL ES 3.00';
        case GL.VENDOR:
        case GL.RENDERER:
          return 'FlatChat';
        case GL.MAX_TEXTURE_SIZE:
        case GL.MAX_RENDERBUFFER_SIZE:
          return 4096;
        case GL.MAX_VERTEX_ATTRIBS:
        case GL.MAX_TEXTURE_IMAGE_UNITS:
        case GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS:
        case GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS:
        case GL.MAX_UNIFORM_BUFFER_BINDINGS:
          return 16;
        case GL.MAX_DRAW_BUFFERS:
        case GL.MAX_COLOR_ATTACHMENTS:
        case GL.MAX_SAMPLES:
          return 4;
        case GL.MAX_VERTEX_UNIFORM_VECTORS:
        case GL.MAX_FRAGMENT_UNIFORM_VECTORS:
          return 256;
        case GL.MAX_VIEWPORT_DIMS:
          return new Int32Array([4096, 4096]);
        case GL.VIEWPORT:
        case GL.SCISSOR_BOX:
          return new Int32Array([0, 0, 1280, 720]);
        case GL.COLOR_CLEAR_VALUE:
          return new Float32Array([0, 0, 0, 0]);
        case GL.COLOR_WRITEMASK:
          return [true, true, true, true];
        default:
          return null;
      }
    },
    shaderSource: (shader, source) => {
      (shader as { model?: boolean }).model = /\bmModel/.test(String(source));
    },
    attachShader: (p, shader) => {
      if ((shader as { model?: boolean }).model) (p as { model?: boolean }).model = true;
    },
    useProgram: (p) => {
      program = (p as { model?: boolean } | null) ?? null;
    },
    drawArrays: (mode, _first, n) => drew(mode as number, n as number),
    drawElements: (mode, n) => drew(mode as number, n as number),
    drawArraysInstanced: (mode, _first, n, instances) => drew(mode as number, n as number, instances as number),
    drawElementsInstanced: (mode, n, _type, _offset, instances) => drew(mode as number, n as number, instances as number),
    drawRangeElements: (mode, _start, _end, n) => drew(mode as number, n as number),
  };
  const constants = GL as Record<string, number>;
  const gl = new Proxy(
    {} as Record<string, unknown>,
    {
      get(target, key) {
        if (typeof key !== 'string') return undefined;
        // What Emscripten keeps on the context itself (the current program, its extensions).
        if (key in target) return target[key];
        if (key in methods) return methods[key];
        if (key in constants) return constants[key];
        // A WebGL constant the runtime reads by name; any other method: nothing to do.
        if (/^[A-Z][A-Z0-9_]*$/.test(key)) return 0;
        if (key === 'canvas' || key === 'drawingBufferWidth' || key === 'drawingBufferHeight') return key === 'canvas' ? undefined : 720;
        return () => undefined;
      },
    },
  );
  return {
    gl,
    count,
    reset: () => {
      count.calls = 0;
      count.quads = 0;
      count.modelTriangles = 0;
    },
  };
}
