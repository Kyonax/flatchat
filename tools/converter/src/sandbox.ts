// SPDX-License-Identifier: MPL-2.0
// Loaded with --import before the avatar converter runs under Node.js's permission model (S4.02):
// glTF-Transform's functions load ndarray-pixels, which imports sharp, a native addon the sandbox
// rightly refuses to load. The converter never calls it, so `sharp` resolves to a stub that throws
// if anything ever does, and native addons stay off. The hook runs in the converter's own thread
// (module.registerHooks): the sandbox allows no worker threads either.
import { registerHooks } from 'node:module';

const STUB = 'data:text/javascript,export default function sharp() { throw new Error("no native image library in the avatar converter"); }';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sharp') return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
