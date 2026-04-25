/// <reference types="vite/client" />

declare module "pdfjs-dist/build/pdf.worker.min.mjs?url" {
  const workerUrl: string;
  export default workerUrl;
}

declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url" {
  const workerUrl: string;
  export default workerUrl;
}
