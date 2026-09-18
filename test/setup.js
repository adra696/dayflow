// Stub minimali dell'ambiente browser per importare i moduli dell'app in Node.
// Va importato per primo in ogni test (`import './setup.js'`): i moduli si valutano in ordine di import,
// quindi i globali esistono già quando state.js / sync.js eseguono il loro codice top-level.

// localStorage in memoria
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
  clear: () => { store.clear(); },
  key: i => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

// Client Supabase inerte: ogni query risolve { data: null, error: null }, auth non fa nulla
const inertQuery = () => {
  const q = {};
  for (const m of ['from', 'select', 'insert', 'upsert', 'update', 'delete', 'eq', 'gte', 'lte', 'order', 'limit']) q[m] = () => q;
  q.single = q.maybeSingle = () => Promise.resolve({ data: null, error: null });
  q.then = (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej);
  return q;
};
globalThis.supabase = {
  createClient: () => ({
    from: () => inertQuery(),
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() { } } } }),
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      signOut: () => Promise.resolve({ error: null }),
    },
  }),
};

// window / document: solo quello che serve al codice top-level (listener no-op, nessun elemento)
const noop = () => { };
globalThis.window = globalThis.window || globalThis;
globalThis.window.addEventListener = noop;
globalThis.window.removeEventListener = noop;
globalThis.window.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
globalThis.window.innerWidth = 1024;
globalThis.document = {
  addEventListener: noop,
  removeEventListener: noop,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  visibilityState: 'visible',
  activeElement: null,
  body: { appendChild: noop, classList: { add: noop, remove: noop, toggle: noop } },
  contains: () => false,
  createElement: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, setAttribute: noop, appendChild: noop, remove: noop }),
};
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { onLine: true };
