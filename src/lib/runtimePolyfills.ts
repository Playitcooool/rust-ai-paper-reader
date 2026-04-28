type ReadResult<T> = { done: false; value: T } | { done: true; value: undefined };

export type RuntimePolyfillDiagnostics = {
  readableStreamHealthy: boolean;
  readableStreamOverridden: boolean;
  readableStreamOverrideFailed: boolean;
};

const diagnostics: RuntimePolyfillDiagnostics = {
  readableStreamHealthy: true,
  readableStreamOverridden: false,
  readableStreamOverrideFailed: false,
};

export function getRuntimePolyfillDiagnostics(): RuntimePolyfillDiagnostics {
  return { ...diagnostics };
}

function installAtPolyfills() {
  // pdfjs-dist@5.x assumes modern JS builtins (notably `.at()`); older WKWebView builds can miss them.

  if (typeof Array !== "undefined" && typeof Array.prototype.at !== "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Array.prototype as any).at = function atPolyfill<T>(this: ArrayLike<T>, index: number): T | undefined {
      const len = this.length >>> 0;
      const n = Number(index);
      if (!Number.isFinite(n)) return undefined;
      let k = Math.trunc(n);
      if (k < 0) k = len + k;
      if (k < 0 || k >= len) return undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (this as any)[k] as T;
    };
  }

  if (typeof String !== "undefined" && typeof String.prototype.at !== "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (String.prototype as any).at = function atPolyfill(this: string, index: number): string | undefined {
      const str = String(this);
      const len = str.length;
      const n = Number(index);
      if (!Number.isFinite(n)) return undefined;
      let k = Math.trunc(n);
      if (k < 0) k = len + k;
      if (k < 0 || k >= len) return undefined;
      // String.prototype.at matches index-based access (1 UTF-16 code unit), unlike `codePointAt`.
      return str.charAt(k);
    };
  }

  const typedArrayCtors: unknown[] = [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Int8Array,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Uint8Array,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Uint8ClampedArray,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Int16Array,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Uint16Array,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Int32Array,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Uint32Array,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Float32Array,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Float64Array,
    // BigInt typed arrays are not present everywhere.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).BigInt64Array,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).BigUint64Array,
  ];

  for (const ctor of typedArrayCtors) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const C = ctor as any;
    if (!C || !C.prototype) continue;
    if (typeof C.prototype.at === "function") continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (C.prototype as any).at = function atPolyfill(this: { length: number }, index: number) {
        const len = this.length >>> 0;
        const n = Number(index);
        if (!Number.isFinite(n)) return undefined;
        let k = Math.trunc(n);
        if (k < 0) k = len + k;
        if (k < 0 || k >= len) return undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (this as any)[k];
      };
    } catch {
      // Best-effort: some exotic environments might make typed array prototypes non-writable.
    }
  }
}

class ReadableStreamControllerPolyfill<T> {
  #stream: ReadableStreamPolyfill<T>;
  constructor(stream: ReadableStreamPolyfill<T>) {
    this.#stream = stream;
  }
  enqueue(chunk: T) {
    this.#stream._enqueue(chunk);
  }
  close() {
    this.#stream._close();
  }
  // pdf.js shouldn't hit this in our current paths, but keep it for completeness.
  error(reason?: unknown) {
    this.#stream._error(reason);
  }
}

class ReadableStreamDefaultReaderPolyfill<T> {
  #stream: ReadableStreamPolyfill<T> | null;
  constructor(stream: ReadableStreamPolyfill<T>) {
    this.#stream = stream;
  }
  read(): Promise<ReadResult<T>> {
    const stream = this.#stream;
    if (!stream) return Promise.resolve({ done: true, value: undefined });
    return stream._read();
  }
  releaseLock() {
    this.#stream = null;
  }
  cancel(_reason?: unknown) {
    const stream = this.#stream;
    if (!stream) return Promise.resolve();
    return stream.cancel();
  }
}

// Minimal, queue-based Web Streams polyfill for older WebKit builds.
// This is intentionally tiny: it only supports the bits pdf.js TextLayer needs.
class ReadableStreamPolyfill<T = unknown> {
  #queue: T[] = [];
  #readWaiters: Array<(result: ReadResult<T>) => void> = [];
  #closed = false;
  #errored: unknown | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(source?: any) {
    if (source && typeof source.start === "function") {
      const controller = new ReadableStreamControllerPolyfill<T>(this);
      try {
        source.start(controller);
      } catch (error) {
        this._error(error);
      }
    }
  }

  getReader() {
    return new ReadableStreamDefaultReaderPolyfill<T>(this);
  }

  cancel() {
    // Resolve any pending reads as done.
    this.#queue = [];
    this.#closed = true;
    while (this.#readWaiters.length > 0) {
      const waiter = this.#readWaiters.shift();
      waiter?.({ done: true, value: undefined });
    }
    return Promise.resolve();
  }

  _enqueue(chunk: T) {
    if (this.#closed || this.#errored) return;
    if (this.#readWaiters.length > 0) {
      const waiter = this.#readWaiters.shift();
      waiter?.({ done: false, value: chunk });
      return;
    }
    this.#queue.push(chunk);
  }

  _close() {
    if (this.#closed || this.#errored) return;
    this.#closed = true;
    while (this.#readWaiters.length > 0) {
      const waiter = this.#readWaiters.shift();
      waiter?.({ done: true, value: undefined });
    }
  }

  _error(reason?: unknown) {
    if (this.#closed || this.#errored) return;
    this.#errored = reason ?? new Error("ReadableStream errored");
    // Treat errors as closed for our tiny polyfill.
    this._close();
  }

  _read(): Promise<ReadResult<T>> {
    if (this.#queue.length > 0) {
      const value = this.#queue.shift() as T;
      return Promise.resolve({ done: false, value });
    }
    if (this.#closed || this.#errored) return Promise.resolve({ done: true, value: undefined });
    return new Promise<ReadResult<T>>((resolve) => {
      this.#readWaiters.push(resolve);
    });
  }
}

// Tiny health check for the specific usage pdf.js TextLayer relies on:
// `start(controller) -> enqueue(value) -> close() -> reader.read()` yields the first chunk.
// Some older or partial Web Streams implementations in embedded WebViews can break this.
async function isReadableStreamHealthy(ReadableStreamCtor: unknown): Promise<boolean> {
  try {
    if (typeof ReadableStreamCtor !== "function") return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = new (ReadableStreamCtor as any)({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      start(controller: any) {
        controller.enqueue("x");
        controller.close();
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reader = (stream as any).getReader?.();
    if (!reader || typeof reader.read !== "function") return false;
    const first = (await reader.read()) as unknown;
    const second = (await reader.read()) as unknown;
    if (
      typeof first !== "object" ||
      !first ||
      typeof second !== "object" ||
      !second
    ) {
      return false;
    }
    return (
      (first as { done?: unknown; value?: unknown }).done === false &&
      (first as { value?: unknown }).value === "x" &&
      (second as { done?: unknown; value?: unknown }).done === true &&
      (second as { value?: unknown }).value === undefined
    );
  } catch {
    return false;
  }
}

async function ensureReadableStreamPolyfillInstalled() {
  diagnostics.readableStreamOverridden = false;
  diagnostics.readableStreamOverrideFailed = false;

  // Some pdf.js text-layer paths expect ReadableStream to exist even when the document is loaded from bytes.
  // Older WKWebView builds may miss it entirely, or ship a partial implementation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const current = (globalThis as any).ReadableStream;

  if (typeof current !== "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ReadableStream = ReadableStreamPolyfill;
    diagnostics.readableStreamOverridden = true;
    diagnostics.readableStreamHealthy = true;
    return;
  }

  const healthy = await isReadableStreamHealthy(current);
  if (healthy) {
    diagnostics.readableStreamHealthy = true;
    return;
  }

  // Existing ReadableStream is present but unhealthy for our required path; try overriding.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ReadableStream = ReadableStreamPolyfill;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    diagnostics.readableStreamOverridden = (globalThis as any).ReadableStream === ReadableStreamPolyfill;
    if (!diagnostics.readableStreamOverridden) diagnostics.readableStreamOverrideFailed = true;
  } catch {
    diagnostics.readableStreamOverrideFailed = true;
  }

  // Re-check after the attempted override so diagnostics reflect reality.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  diagnostics.readableStreamHealthy = await isReadableStreamHealthy((globalThis as any).ReadableStream);
}

export async function installRuntimePolyfills() {
  installAtPolyfills();

  // pdf.js AnnotationLayer uses Element.prototype.replaceChildren.
  if (
    typeof Element !== "undefined" &&
    typeof (Element.prototype as unknown as { replaceChildren?: unknown }).replaceChildren !== "function"
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).replaceChildren = function replaceChildrenPolyfill(this: Element, ...nodes: Node[]) {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (const node of nodes) this.appendChild(node);
    };
  }

  // pdfjs-dist 5.x uses URL.parse in some code paths; older WKWebView builds don't have it.
  if (typeof URL !== "undefined" && typeof (URL as unknown as { parse?: unknown }).parse !== "function") {
    (URL as unknown as { parse: (input: string, base?: string) => URL | null }).parse = (
      input: string,
      base?: string,
    ) => {
      try {
        return base ? new URL(input, base) : new URL(input);
      } catch {
        return null;
      }
    };
  }

  // Some older WebKit builds still miss Promise.allSettled.
  if (typeof Promise !== "undefined" && typeof Promise.allSettled !== "function") {
    Promise.allSettled = ((promises: Iterable<unknown>) =>
      Promise.all(
        Array.from(promises).map((promise) =>
          Promise.resolve(promise).then(
            (value) => ({ status: "fulfilled", value }) as const,
            (reason) => ({ status: "rejected", reason }) as const,
          ),
        ),
      )) as typeof Promise.allSettled;
  }

  // pdfjs-dist 5.x TextLayer uses Promise.withResolvers; older WebKit/Tauri builds may miss it.
  if (
    typeof Promise !== "undefined" &&
    typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers !== "function"
  ) {
    (
      Promise as unknown as {
        withResolvers: <T>() => {
          promise: Promise<T>;
          resolve: (value: T | PromiseLike<T>) => void;
          reject: (reason?: unknown) => void;
        };
      }
    ).withResolvers = <T,>() => {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
  }

  await ensureReadableStreamPolyfillInstalled();
}
