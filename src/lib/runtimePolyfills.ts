type ReadResult<T> = { done: false; value: T } | { done: true; value: undefined };

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

export function installRuntimePolyfills() {
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

  // Some pdf.js text-layer paths expect ReadableStream to exist even when the document is loaded from bytes.
  // Older WKWebView builds may miss it entirely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (globalThis as any).ReadableStream !== "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ReadableStream = ReadableStreamPolyfill;
  }
}

