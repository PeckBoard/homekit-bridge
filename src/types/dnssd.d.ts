// The slice of dnssd (untyped CJS, pulled in by hap-controller) we use.
declare module "dnssd" {
  interface Emitter {
    on(event: string, fn: (...args: never[]) => void): this;
    start(): this;
    stop(): void;
  }
  const dnssd: {
    Browser: new (type: unknown, options?: Record<string, unknown>) => Emitter;
    Advertisement: new (type: unknown, port: number, options?: Record<string, unknown>) => Emitter;
    ServiceType: new (type: string) => unknown;
  };
  export default dnssd;
}
