// SPDX-License-Identifier: MPL-2.0
// Stands in for the `sharp` image library in the main process's bundle (S2.13). glTF Transform's
// image helpers (ndarray-pixels) import it when they load, but the converter never calls them (it
// decodes and fits textures itself, and offline worlds skip KTX2); sharp's native binary is not in
// the packaged client, so loading the real module would stop the converter from loading at all.
export default function sharp(): never {
  throw new Error('image resizing through sharp is not available in the client');
}
