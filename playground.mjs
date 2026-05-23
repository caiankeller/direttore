import readline from "readline";

// ─── ANSI helpers ────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
  bgDark: "\x1b[40m",
  underline: "\x1b[4m",
};

const paint = (color, text) => `${color}${text}${c.reset}`;
const bold = (t) => paint(c.bold, t);
const dim = (t) => paint(c.dim, t);
const green = (t) => paint(c.green, t);
const red = (t) => paint(c.red, t);
const yellow = (t) => paint(c.yellow, t);
const cyan = (t) => paint(c.cyan, t);
const blue = (t) => paint(c.blue, t);
const gray = (t) => paint(c.gray, t);
const magenta = (t) => paint(c.magenta, t);

const line = (char = "─", len = 60) => gray(char.repeat(len));
const section = (title) =>
  `\n${line()}\n  ${bold(cyan(title))}\n${line()}\n`;

// ─── MOCK FETCH (simulates real network) ─────────────────────────────────────
const mockDb = {
  users: {
    "1": { id: "1", name: "Ada Lovelace", email: "ada@example.com", role: "admin" },
    "2": { id: "2", name: "Grace Hopper", email: "grace@example.com", role: "user" },
  },
  orders: {
    "101": { id: "101", userId: "1", status: "paid", total: 299.99 },
    "102": { id: "102", userId: "2", status: "pending", total: 49.0 },
    "103": { id: "103", userId: "1", status: "cancelled", total: 15.5 },
  },
  invoices: {
    "inv-1": { id: "inv-1", amount: 1200, due: "2024-03-01" },
  },
};

let currentToken = "valid-token-abc";
let requestCount = 0;

async function mockFetch(url, init = {}) {
  requestCount++;
  const reqId = `REQ-${String(requestCount).padStart(3, "0")}`;

  await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));

  const headers = init.headers || {};
  const auth = headers["Authorization"] || headers["authorization"] || "";
  const method = (init.method || "GET").toUpperCase();

  log(gray(`  [${reqId}] ${method} ${url}`));

  // simulate 401 for invalid token
  if (auth && !auth.includes(currentToken)) {
    return mockResponse(401, { message: "Token expired", code: "TOKEN_EXPIRED" });
  }

  // simulate 403 for non-admin on certain routes
  if (url.includes("/admin") && !auth.includes("admin")) {
    return mockResponse(403, { message: "Forbidden", code: "FORBIDDEN" });
  }

  // route matching
  const urlObj = new URL(url);
  const path = urlObj.pathname;

  if (method === "GET" && path.match(/\/users\/(\w+)$/)) {
    const id = path.split("/").pop();
    const user = mockDb.users[id];
    if (!user) return mockResponse(404, { message: `User ${id} not found`, code: "NOT_FOUND" });
    return mockResponse(200, user);
  }

  if (method === "GET" && path === "/users") {
    const q = urlObj.searchParams.get("q") || "";
    const results = Object.values(mockDb.users).filter(
      (u) => !q || u.name.toLowerCase().includes(q.toLowerCase())
    );
    return mockResponse(200, results);
  }

  if (method === "POST" && path === "/users") {
    const body = JSON.parse(init.body || "{}");
    if (!body.name) return mockResponse(422, { message: "name is required", code: "VALIDATION_ERROR", fields: { name: "required" } });
    const id = String(Date.now()).slice(-4);
    const user = { id, ...body };
    mockDb.users[id] = user;
    return mockResponse(201, user);
  }

  if (method === "PATCH" && path.match(/\/users\/(\w+)$/)) {
    const id = path.split("/").pop();
    if (!mockDb.users[id]) return mockResponse(404, { message: "User not found", code: "NOT_FOUND" });
    const body = JSON.parse(init.body || "{}");
    mockDb.users[id] = { ...mockDb.users[id], ...body };
    return mockResponse(200, mockDb.users[id]);
  }

  if (method === "DELETE" && path.match(/\/users\/(\w+)$/)) {
    const id = path.split("/").pop();
    if (!mockDb.users[id]) return mockResponse(404, { message: "User not found", code: "NOT_FOUND" });
    delete mockDb.users[id];
    return mockResponse(204, null);
  }

  if (method === "GET" && path.match(/\/orders\/(\w+)$/)) {
    const id = path.split("/").pop();
    const order = mockDb.orders[id];
    if (!order) return mockResponse(404, { message: `Order ${id} not found`, code: "NOT_FOUND" });
    return mockResponse(200, order);
  }

  if (method === "GET" && path.match(/\/invoices\/(.+)$/)) {
    const id = path.split("/invoices/")[1];
    const invoice = mockDb.invoices[id];
    if (!invoice) return mockResponse(404, { message: "Invoice not found", code: "NOT_FOUND" });
    return mockResponse(200, invoice);
  }

  return mockResponse(404, { message: "Route not found", code: "NOT_FOUND" });
}

function mockResponse(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return data; },
    async text() { return JSON.stringify(data); },
    clone() { return mockResponse(status, data); },
  };
}

// ─── API-ORCH CORE IMPLEMENTATION ─────────────────────────────────────────────
class ApiError extends Error {
  constructor({ message, code, status, fields, raw }) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.fields = fields;
    this.raw = raw;
  }
}

function defaultParseError(raw) {
  return {
    message: raw?.message || "Request failed",
    code: raw?.code || "UNKNOWN_ERROR",
    fields: raw?.fields,
    raw,
  };
}

function resolvePath(template, input) {
  return template.replace(/:(\w+)|\{(\w+)\}/g, (_, a, b) => {
    const key = a || b;
    return input?.[key] ?? input?.params?.[key] ?? `:${key}`;
  });
}

function buildQuery(queryFn, input) {
  if (!queryFn && !input?.query) return "";
  const params = queryFn ? queryFn(input) : input.query;
  if (!params) return "";
  const q = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
  );
  return q.toString() ? `?${q}` : "";
}

function buildBody(bodyFn, input, method) {
  if (!["POST", "PUT", "PATCH"].includes(method)) return undefined;
  const raw = bodyFn ? bodyFn(input) : input?.body ?? null;
  if (raw == null) return undefined;
  if (
    raw instanceof FormData ||
    raw instanceof URLSearchParams ||
    raw instanceof Blob ||
    raw instanceof ArrayBuffer ||
    typeof raw === "string"
  ) return { body: raw };
  return { body: JSON.stringify(raw), headers: { "content-type": "application/json" } };
}

function createApiClient(config = {}) {
  const services = config.services || {};
  const defaultService = config.defaultService;

  function endpoint(def) {
    const serviceName = def.service ?? defaultService;
    const service = serviceName ? services[serviceName] : null;

    if (serviceName && !service && serviceName !== defaultService) {
      // allow defaultService to be a string key
    }

    const getTransport = () => service?.fetch ?? config.fetch ?? mockFetch;

    async function getAuthHeaders(auth, ctx) {
      const fn = service?.getAuthHeaders ?? config.getAuthHeaders;
      return fn ? await fn(auth, ctx) : undefined;
    }

    function getParseError() {
      return def.parseError ?? service?.parseError ?? config.parseError ?? defaultParseError;
    }

    function getMiddleware() {
      return [
        ...(config.middleware || []),
        ...(service?.middleware || []),
        ...(def.middleware || []),
      ];
    }

    function getOnStatus() {
      const merged = {};
      for (const map of [config.onStatus, service?.onStatus, def.onStatus]) {
        if (map) Object.assign(merged, map);
      }
      return merged;
    }

    async function execute(input = {}, options = {}) {
      const svc = serviceName ? services[serviceName] : null;
      if (serviceName && !svc) throw new Error(`Unknown service: "${serviceName}"`);

      const baseUrl = def.baseUrl ?? svc?.baseUrl ?? config.baseUrl ?? "http://localhost";
      const method = (def.method || "GET").toUpperCase();
      const path = resolvePath(def.path || "/", input);
      const query = buildQuery(def.query, input);
      const url = `${baseUrl}${path}${query}`;

      const ctx = {
        input,
        method,
        path,
        serviceName,
        service: svc,
        auth: def.auth,
        endpointName: def.name,
        config,
      };

      const clientHeaders = config.headers || {};
      const serviceHeaders = svc?.headers || {};
      const authHeaders = (await getAuthHeaders(def.auth, ctx)) || {};
      const bodyData = buildBody(def.body, input, method);

      const init = {
        method,
        headers: {
          ...clientHeaders,
          ...serviceHeaders,
          ...(bodyData?.headers || {}),
          ...authHeaders,
          ...(options.headers || {}),
        },
        ...(bodyData?.body != null ? { body: bodyData.body } : {}),
        ...options,
      };

      const transport = getTransport();
      const middleware = getMiddleware();
      const onStatus = getOnStatus();

      async function run(mwIndex, req) {
        if (mwIndex < middleware.length) {
          return middleware[mwIndex](req, (next) => run(mwIndex + 1, next ?? req));
        }
        return transport(req.url, req.init);
      }

      const response = await run(0, { url, init, ctx });

      // status callbacks
      if (!response.ok) {
        const handler = onStatus[response.status] ?? onStatus["default"];
        const raw = await response.clone().json().catch(() => null);
        const parseError = getParseError();

        if (handler) {
          const override = await handler({ response, ctx });
          if (override) throw new ApiError({ ...override, status: response.status });
        }

        const parsed = parseError(raw);
        throw new ApiError({ ...parsed, status: response.status });
      }

      if (response.status === 204 || response.status === 205) return undefined;

      const contentType = response.headers?.get?.("content-type") ?? "application/json";
      const result = await response.json();

      if (def.output) {
        const schema = def.output;
        if (schema.parse) return schema.parse(result);
        if (schema.safeParse) {
          const r = schema.safeParse(result);
          if (!r.success) throw new Error("Output validation failed");
          return r.data;
        }
        if (schema.validate) return schema.validate(result);
      }

      return result;
    }

    function cacheKey(input) {
      const key = def.cacheKey?.(input) ?? [def.name ?? def.path, input];
      return serviceName ? [serviceName, ...key] : key;
    }

    return { fetch: execute, cacheKey, _def: def, _serviceName: serviceName };
  }

  return { endpoint, _config: config };
}

// ─── BUILT-IN MIDDLEWARE ──────────────────────────────────────────────────────
function authMiddleware(getHeaders) {
  return async (req, next) => {
    const headers = await getHeaders(req.ctx);
    req.init.headers = { ...req.init.headers, ...headers };
    return next(req);
  };
}

function retryMiddleware({ attempts = 3, delay = 200 } = {}) {
  return async (req, next) => {
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await next(req);
        return res;
      } catch (err) {
        last = err;
        if (err instanceof ApiError && err.status < 500) throw err;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, delay * (i + 1)));
      }
    }
    throw last;
  };
}

function loggerMiddleware() {
  return async (req, next) => {
    const start = Date.now();
    try {
      const res = await next(req);
      log(green(`  ✓ ${req.init.method} ${req.url} ${dim(`${Date.now() - start}ms`)}`));
      return res;
    } catch (err) {
      log(red(`  ✗ ${req.init.method} ${req.url} ${dim(`${Date.now() - start}ms`)} → ${err.message}`));
      throw err;
    }
  };
}

// ─── SIMPLE SCHEMA HELPERS ───────────────────────────────────────────────────
function schema(parseFn) {
  return { parse: parseFn };
}

// ─── PLAYGROUND CLIENT SETUP ─────────────────────────────────────────────────
const session = {
  token: currentToken,
  invalidate() { this.token = null; log(red("  ⚠ Session invalidated")); },
  refresh() { this.token = currentToken = `refreshed-${Date.now()}`; log(green("  ✓ Token refreshed")); },
};

const authDeniedStore = { show: () => log(red("  ⚠ Access denied dialog shown")) };

const client = createApiClient({
  defaultService: "core",
  headers: { "x-app": "api-orch-playground" },
  services: {
    core: {
      baseUrl: "https://api.example.com",
      headers: { "x-service": "core" },
      getAuthHeaders: async (_auth, ctx) => {
        if (!session.token) return undefined;
        return {
          Authorization: `Bearer ${session.token}`,
          "x-service-name": ctx.serviceName ?? "default",
        };
      },
      onStatus: {
        401: async ({ ctx }) => {
          session.invalidate();
          log(yellow(`  ↺ 401 on service "${ctx.serviceName}" — session expired`));
        },
        403: () => {
          authDeniedStore.show();
        },
        default: ({ response }) => {
          log(gray(`  ℹ status ${response.status} caught by default handler`));
        },
      },
      middleware: [loggerMiddleware()],
    },
    billing: {
      baseUrl: "https://billing.example.com",
      headers: { "x-service": "billing" },
      getAuthHeaders: async () =>
        session.token ? { Authorization: `Bearer ${session.token}` } : undefined,
    },
  },
});

// ─── ENDPOINTS ───────────────────────────────────────────────────────────────
const OrderStatus = { PAID: "paid", PENDING: "pending", CANCELLED: "cancelled" };

const orderSchema = schema((raw) => ({
  id: String(raw.id),
  userId: String(raw.userId),
  status: raw.status,
  total: Number(raw.total),
  isPaid: raw.status === OrderStatus.PAID,
  isPending: raw.status === OrderStatus.PENDING,
}));

const api = {
  users: {
    get: client.endpoint({
      name: "users.get",
      method: "GET",
      path: "/users/:id",
    }),
    search: client.endpoint({
      name: "users.search",
      method: "GET",
      path: "/users",
      query: (input) => ({ q: input.q }),
    }),
    create: client.endpoint({
      name: "users.create",
      method: "POST",
      path: "/users",
      auth: { scope: "users:write" },
    }),
    update: client.endpoint({
      name: "users.update",
      method: "PATCH",
      path: "/users/:id",
    }),
    remove: client.endpoint({
      name: "users.remove",
      method: "DELETE",
      path: "/users/:id",
    }),
  },
  orders: {
    get: client.endpoint({
      name: "orders.get",
      method: "GET",
      path: "/orders/:id",
      output: orderSchema,
    }),
  },
  billing: {
    invoice: client.endpoint({
      name: "billing.invoice",
      service: "billing",
      method: "GET",
      path: "/invoices/:id",
    }),
  },
};

// ─── UI HELPERS ──────────────────────────────────────────────────────────────
function log(...args) { console.log(...args); }

function printResult(label, data) {
  log(`\n  ${bold(green("✓"))} ${bold(label)}`);
  const serialized = data === undefined ? "undefined" : JSON.stringify(data, null, 2);
  const lines = (serialized ?? String(data)).split("\n");
  for (const l of lines) log(`    ${gray(l)}`);
}

function printError(label, err) {
  log(`\n  ${bold(red("✗"))} ${bold(label)}`);
  if (err instanceof ApiError) {
    log(`    ${red("ApiError")} ${gray("→")} status=${yellow(err.status)} code=${cyan(err.code)}`);
    log(`    message: ${err.message}`);
    if (err.fields) log(`    fields:  ${JSON.stringify(err.fields)}`);
  } else {
    log(`    ${err.message}`);
  }
}

function printCacheKey(label, key) {
  log(`\n  ${bold(blue("⚿"))} ${bold(label)}`);
  log(`    ${gray(JSON.stringify(key))}`);
}

// ─── DEMO SCENARIOS ──────────────────────────────────────────────────────────
async function demoBasicFetch() {
  log(section("1. Basic fetch — GET user by id"));
  try {
    const user = await api.users.get.fetch({ id: "1" });
    printResult("users.get({ id: '1' })", user);
  } catch (e) { printError("users.get", e); }

  log("\n" + dim("  Fetching unknown user (404):"));
  try {
    await api.users.get.fetch({ id: "999" });
  } catch (e) { printError("users.get({ id: '999' })", e); }
}

async function demoQueryStrings() {
  log(section("2. Query strings — search users"));
  try {
    const results = await api.users.search.fetch({ q: "ada" });
    printResult("users.search({ q: 'ada' })", results);
  } catch (e) { printError("users.search", e); }

  try {
    const all = await api.users.search.fetch({});
    printResult("users.search({}) — no filter", all);
  } catch (e) { printError("users.search", e); }
}

async function demoBodyAndCreate() {
  log(section("3. Request body — POST/PATCH/DELETE"));

  log(dim("\n  Creating a new user:"));
  try {
    const user = await api.users.create.fetch({ body: { name: "Linus Torvalds", email: "linus@kernel.org", role: "user" } });
    printResult("users.create", user);

    log(dim("\n  Patching that user:"));
    const updated = await api.users.update.fetch({ id: user.id, body: { role: "admin" } });
    printResult("users.update", updated);

    log(dim("\n  Deleting that user (204 → undefined):"));
    const del = await api.users.remove.fetch({ id: user.id });
    printResult("users.remove (204 → undefined)", del);
  } catch (e) { printError("create/update/delete", e); }

  log(dim("\n  Creating with missing required field:"));
  try {
    await api.users.create.fetch({ body: {} });
  } catch (e) { printError("users.create — validation error", e); }
}

async function demoOutputSchema() {
  log(section("4. Output schema — typed order status"));
  log(dim("  Raw backend returns { status: 'paid' }"));
  log(dim("  Schema transforms into domain type with isPaid/isPending flags\n"));

  for (const id of ["101", "102", "103"]) {
    try {
      const order = await api.orders.get.fetch({ id });
      printResult(`orders.get({ id: '${id}' })`, order);
    } catch (e) { printError(`orders.get({ id: '${id}' })`, e); }
  }
}

async function demoMultiService() {
  log(section("5. Multi-service — billing vs core"));
  log(dim("  core → https://api.example.com"));
  log(dim("  billing → https://billing.example.com\n"));

  try {
    const user = await api.users.get.fetch({ id: "2" });
    printResult("core: users.get", user);
  } catch (e) { printError("core: users.get", e); }

  try {
    const invoice = await api.billing.invoice.fetch({ id: "inv-1" });
    printResult("billing: invoice.get", invoice);
  } catch (e) { printError("billing: invoice.get", e); }
}

async function demoAuth() {
  log(section("6. Auth flows — token expiry and refresh"));
  log(dim(`  Current token: ${session.token}\n`));

  log(dim("  Valid request:"));
  try {
    const user = await api.users.get.fetch({ id: "1" });
    printResult("users.get (authenticated)", user);
  } catch (e) { printError("users.get", e); }

  log(dim("\n  Simulating expired token:"));
  const old = session.token;
  session.token = "expired-token-xyz";
  try {
    await api.users.get.fetch({ id: "1" });
  } catch (e) { printError("users.get (expired token)", e); }

  session.token = old;
  log(dim(`\n  Token restored: ${session.token}`));

  log(dim("\n  Request without auth (null token):"));
  const saved = session.token;
  session.token = null;
  try {
    await api.users.get.fetch({ id: "1" });
  } catch (e) { printError("users.get (no token)", e); }
  session.token = saved;
}

async function demoOnStatus() {
  log(section("7. onStatus handlers — centralized side effects"));
  log(dim("  Handlers live in service config, not at call sites\n"));

  log(dim("  Triggering 401 (bad token):"));
  const old = session.token;
  session.token = "bad-token";
  try { await api.users.get.fetch({ id: "1" }); } catch (_) {}
  session.token = old;

  log(dim("\n  Triggering 403 (forbidden route):"));
  try { await api.users.get.fetch({ id: "admin/secret" }); } catch (_) {}

  log(dim("\n  Triggering default handler (404 not caught by specific handler):"));
  try { await api.users.get.fetch({ id: "999" }); } catch (_) {}
}

async function demoCustomParseError() {
  log(section("8. Custom parseError — full control over error shape"));

  const legacyClient = createApiClient({
    defaultService: "legacy",
    services: {
      legacy: {
        baseUrl: "https://api.example.com",
        parseError(raw) {
          return {
            message: `Legacy error: ${raw?.message ?? "unknown"}`,
            code: `LEGACY_${(raw?.code ?? "ERROR").toUpperCase()}`,
            raw,
          };
        },
      },
    },
  });

  const legacyUser = legacyClient.endpoint({ method: "GET", path: "/users/:id" });

  try {
    await legacyUser.fetch({ id: "999" });
  } catch (e) {
    printError("legacy endpoint (custom parseError)", e);
  }
}

async function demoMiddleware() {
  log(section("9. Middleware — retry + custom auth injection"));

  const tracedClient = createApiClient({
    defaultService: "traced",
    services: {
      traced: {
        baseUrl: "https://api.example.com",
        getAuthHeaders: async () => ({ Authorization: `Bearer ${session.token}` }),
        middleware: [
          authMiddleware(() => ({ "x-trace-id": `trace-${Math.random().toString(36).slice(2, 9)}` })),
          loggerMiddleware(),
        ],
      },
    },
  });

  const tracedUser = tracedClient.endpoint({ method: "GET", path: "/users/:id" });

  log(dim("  Fetch with trace-id middleware injecting header:"));
  try {
    const user = await tracedUser.fetch({ id: "2" });
    printResult("traced users.get", user);
  } catch (e) { printError("traced users.get", e); }

  log(dim("\n  Retry middleware (simulates transient failure recovery):"));
  let attempts = 0;
  const flakeyClient = createApiClient({
    baseUrl: "https://api.example.com",
    middleware: [
      retryMiddleware({ attempts: 3, delay: 50 }),
      loggerMiddleware(),
    ],
  });
  const flakeyEndpoint = flakeyClient.endpoint({
    method: "GET",
    path: "/users/:id",
    request: async ({ input }) => {
      attempts++;
      if (attempts < 3) throw new ApiError({ message: "Service unavailable", code: "SERVICE_UNAVAILABLE", status: 503 });
      return { id: input.id, name: "Recovered!", email: "ok@example.com", role: "user" };
    },
  });

  try {
    const user = await flakeyEndpoint.fetch({ id: "1" });
    log(green(`  ✓ recovered after ${attempts} attempt(s)`));
    printResult("flakey endpoint (retry)", user);
  } catch (e) { printError("flakey endpoint", e); }
}

async function demoCacheKeys() {
  log(section("10. Cache keys — framework-agnostic (e.g. React Query)"));
  log(dim("  useQuery({ queryKey: api.users.get.cacheKey({ id: '1' }) })\n"));

  printCacheKey("users.get({ id: '1' })", api.users.get.cacheKey({ id: "1" }));
  printCacheKey("users.search({ q: 'ada' })", api.users.search.cacheKey({ q: "ada" }));
  printCacheKey("orders.get({ id: '101' })", api.orders.get.cacheKey({ id: "101" }));
  printCacheKey("billing.invoice({ id: 'inv-1' })", api.billing.invoice.cacheKey({ id: "inv-1" }));

  log(dim("\n  Custom cache key example:"));
  const customEndpoint = client.endpoint({
    name: "custom.endpoint",
    method: "GET",
    path: "/users/:id",
    cacheKey: (input) => ["my-custom-key", input.id, "v2"],
  });
  printCacheKey("custom endpoint", customEndpoint.cacheKey({ id: "42" }));
}

// ─── MENU ─────────────────────────────────────────────────────────────────────
const DEMOS = [
  { label: "Basic fetch (GET, 404 error)", fn: demoBasicFetch },
  { label: "Query strings (search)", fn: demoQueryStrings },
  { label: "Request body (POST / PATCH / DELETE)", fn: demoBodyAndCreate },
  { label: "Output schema (typed domain model)", fn: demoOutputSchema },
  { label: "Multi-service (core + billing)", fn: demoMultiService },
  { label: "Auth flows (token, expiry)", fn: demoAuth },
  { label: "onStatus handlers", fn: demoOnStatus },
  { label: "Custom parseError", fn: demoCustomParseError },
  { label: "Middleware (retry, trace headers)", fn: demoMiddleware },
  { label: "Cache keys", fn: demoCacheKeys },
  { label: "Run all demos", fn: null },
];

function printMenu() {
  log(`\n${line("═")}`);
  log(`  ${bold(cyan("api-orch"))} ${gray("playground")}   ${dim("(mock fetch, no network needed)")}`);
  log(line("═"));
  DEMOS.forEach((d, i) => {
    const num = bold(String(i + 1).padStart(2));
    log(`  ${num}  ${i === DEMOS.length - 1 ? yellow(d.label) : d.label}`);
  });
  log(`\n  ${bold("q")}   quit`);
  log(line("─"));
}

async function runDemo(choice) {
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= DEMOS.length) {
    log(red("  Invalid choice."));
    return;
  }
  if (idx === DEMOS.length - 1) {
    for (const d of DEMOS.slice(0, -1)) {
      await d.fn();
      await new Promise((r) => setTimeout(r, 200));
    }
  } else {
    await DEMOS[idx].fn();
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => { closed = true; });
  const ask = () => new Promise((res) => {
    if (closed) {
      res(null);
      return;
    }

    rl.question(`\n${bold(">")} `, res);
  });

  printMenu();

  while (true) {
    const answer = await ask();
    if (answer === null) {
      log(dim("\n  bye\n"));
      process.exit(0);
    }

    const input = answer.trim().toLowerCase();
    if (input === "q" || input === "quit" || input === "exit") {
      log(dim("\n  bye\n"));
      rl.close();
      process.exit(0);
    }
    if (input === "m" || input === "menu" || input === "") {
      printMenu();
      continue;
    }
    await runDemo(input);
    log(dim("\n  [m] menu  [q] quit"));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
