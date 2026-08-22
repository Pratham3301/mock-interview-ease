# Transformers.js browser runtime

These lazy-loaded browser assets are vendored from npm packages:

- `@huggingface/transformers` 4.2.0 (`transformers.min.js`)
- `onnxruntime-web` 1.26.0-dev.20260416-b7804b056c

Vendored files:

- `transformers-bundle.min.js`
- `ort-wasm-simd-threaded.asyncify.mjs`
- `ort-wasm-simd-threaded.asyncify.wasm`

Transformers.js is Apache-2.0 licensed; its license is included as
`TRANSFORMERS-LICENSE`. The JavaScript bundle retains ONNX Runtime Web's MIT
license notice. The Moonshine model weights are fetched from Hugging Face and
cached by the browser; they are not stored in this repository.
