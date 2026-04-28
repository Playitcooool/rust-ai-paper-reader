/// <reference types="vite/client" />

declare module "pdfjs-dist/build/pdf.worker.min.mjs?url" {
  const workerUrl: string;
  export default workerUrl;
}

declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url" {
  const workerUrl: string;
  export default workerUrl;
}

// Our TS config targets older libs, but runtime polyfills add `.at()` for older WebViews.
// Declare it here so `tsc -b` doesn't require bumping `lib` to ES2022+.
declare global {
  interface Array<T> {
    at(index: number): T | undefined;
  }
  interface ReadonlyArray<T> {
    at(index: number): T | undefined;
  }
  interface String {
    at(index: number): string;
  }
  interface Int8Array {
    at(index: number): number | undefined;
  }
  interface Uint8Array {
    at(index: number): number | undefined;
  }
  interface Uint8ClampedArray {
    at(index: number): number | undefined;
  }
  interface Int16Array {
    at(index: number): number | undefined;
  }
  interface Uint16Array {
    at(index: number): number | undefined;
  }
  interface Int32Array {
    at(index: number): number | undefined;
  }
  interface Uint32Array {
    at(index: number): number | undefined;
  }
  interface Float32Array {
    at(index: number): number | undefined;
  }
  interface Float64Array {
    at(index: number): number | undefined;
  }
  interface BigInt64Array {
    at(index: number): bigint | undefined;
  }
  interface BigUint64Array {
    at(index: number): bigint | undefined;
  }
}

export {};
