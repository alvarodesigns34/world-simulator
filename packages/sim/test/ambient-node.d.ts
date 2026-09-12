/** Minimal Worker typing so sim tests can exercise SAB without @types/node. */
declare module 'node:worker_threads' {
  export class Worker {
    constructor(filename: string, options?: { eval?: boolean; workerData?: unknown });
    once(event: 'message', listener: (value: unknown) => void): this;
    once(event: 'error', listener: (err: Error) => void): this;
    terminate(): Promise<number>;
  }
}
