// Next.js instrumentation hook — runs once when the server worker starts,
// before any route module is loaded.  Privy (and WalletConnect internals)
// access localStorage at module-init time which crashes in the Node.js
// server environment.  This polyfill makes those accesses no-ops so SSR
// completes successfully; real localStorage is always used on the client.
export function register() {
  if (typeof window === "undefined") {
    const noop = () => null;
    const store: Record<string, string> = {};
    // @ts-ignore — patching a server global
    globalThis.localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { Object.keys(store).forEach(k => delete store[k]); },
      get length() { return Object.keys(store).length; },
      key: (i: number) => Object.keys(store)[i] ?? null,
    };
  }
}
