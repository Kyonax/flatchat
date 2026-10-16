# Client

The desktop app for Windows and Linux: sign-in, settings, the world browser, the 3D world, voice and the offline mode. It can also start a world server, for hosting and for offline play.

- Licence: MPL-2.0 ([LICENSE](LICENSE))
- Planned stack: Electron with three.js, Vue and TypeScript (provisional until the Stage 0 bake-off; Godot with C# is the alternative)
- Built with electron-vite (Vite 8) and packaged with electron-builder
- Status: the blank client of Stage 0. One window draws a greybox scene on three.js's WebGPURenderer (WebGPU, or WebGL2 when WebGPU is missing) and shows the backend, the frame rate and the versions. `--smoke` draws for 3 seconds, prints one JSON line (backend, frame rate, Chromium's GPU status) and quits; `--smoke-out=FILE` also writes it to a file.
