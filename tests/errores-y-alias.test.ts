/** Tests de formato de errores, liga_casa_id string, y auto-alias seguro */

import { describe, it, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { crearServidor } from "../src/servidor.js";
import type { FastifyInstance } from "fastify";

process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_KEY = "test-key";
process.env.SYNC_TOKEN = "test-sync-token";

const TABLA_EQUIVALENCIAS = "equivalencias_liga";
const TABLA_PARTIDOS = "partidos_programados_365";
const TABLA_EQUIPOS = "equipos_365";

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

let llamadasFetch: FetchCall[] = [];
const fetchOriginal = globalThis.fetch;

function mockearFetch(config: {
  equivalencia?: Record<string, unknown> | null;
  partidos?: Record<string, unknown>[];
  allPartidos?: Record<string, unknown>[];
  equipos?: Record<string, unknown>[];
}) {
  llamadasFetch = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); }
    }
    llamadasFetch.push({ url, method, body });

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes(TABLA_EQUIVALENCIAS) && method === "GET") {
      return json(config.equivalencia ? [config.equivalencia] : []);
    }
    if (url.includes(TABLA_EQUIVALENCIAS) && method === "PATCH") {
      return new Response(null, { status: 204 });
    }

    if (url.includes(TABLA_PARTIDOS) && method === "GET" && url.includes("select=local_id")) {
      const fuente = config.allPartidos ?? config.partidos ?? [];
      return json(fuente.map((p: Record<string, unknown>) => ({
        local_id: p.local_id, visitante_id: p.visitante_id,
      })));
    }
    if (url.includes(TABLA_PARTIDOS) && method === "GET") {
      return json(config.partidos ?? []);
    }

    if (url.includes(TABLA_EQUIPOS) && method === "GET" && url.includes("select=alias")) {
      const match = url.match(/id=eq\.(\d+)/);
      const id = match ? parseInt(match[1]) : 0;
      const equipo = (config.equipos ?? []).find((e: Record<string, unknown>) => e.id === id);
      return json(equipo ? [{ alias: (equipo as Record<string, unknown>).alias ?? [] }] : []);
    }
    if (url.includes(TABLA_EQUIPOS) && method === "GET") {
      return json(config.equipos ?? []);
    }
    if (url.includes(TABLA_EQUIPOS) && method === "PATCH") {
      return new Response(null, { status: 204 });
    }
    if (url.includes(TABLA_EQUIPOS) && method === "POST") {
      return new Response(null, { status: 201 });
    }

    return json({ error: "Unexpected: " + url }, 500);
  }) as typeof globalThis.fetch;
}

function aliasGuardado(): boolean {
  return llamadasFetch.some(
    (c) => c.url.includes(TABLA_EQUIPOS) && c.method === "PATCH",
  );
}

const ahora = new Date().toISOString();

const equivalencia = {
  id: 1,
  casa: "testbet",
  liga_casa_id: "42",
  competition_id_365: 620,
  activa: true,
  ultima_sincronizacion: ahora,
};

const partido1 = {
  game_id: 1001,
  competition_id: 620,
  fecha_hora: "2025-02-15T20:00:00-05:00",
  estado: "programado",
  ronda: 5,
  local_id: 201,
  local_nombre: "Atletico Nacional",
  visitante_id: 202,
  visitante_nombre: "Millonarios FC",
  actualizado_en: ahora,
};

const partido2 = {
  game_id: 1002,
  competition_id: 620,
  fecha_hora: "2025-02-15T18:00:00-05:00",
  estado: "programado",
  ronda: 5,
  local_id: 203,
  local_nombre: "Deportivo Cali",
  visitante_id: 204,
  visitante_nombre: "America de Cali",
  actualizado_en: ahora,
};

const equipos = [
  { id: 201, nombre: "Atletico Nacional", alias: ["Nacional"] },
  { id: 202, nombre: "Millonarios FC", alias: ["Millos"] },
  { id: 203, nombre: "Deportivo Cali", alias: ["Cali"] },
  { id: 204, nombre: "America de Cali", alias: ["America"] },
];

function queryBase(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    casa: "testbet",
    liga_casa_id: "42",
    fecha: "2025-02-15",
    local: "Atletico Nacional",
    visitante: "Millonarios",
    ...overrides,
  });
  return `/buscar-partido?${params}`;
}

describe("liga_casa_id string", () => {
  let app: FastifyInstance;
  before(async () => { app = crearServidor(); await app.ready(); });
  after(() => app.close());
  afterEach(() => { globalThis.fetch = fetchOriginal; delete process.env.API_TOKEN; });

  it("acepta liga_casa_id alfanumerico", async () => {
    mockearFetch({ equivalencia: { ...equivalencia, liga_casa_id: "abc-123" }, partidos: [partido1], equipos });
    const resp = await app.inject({ method: "GET", url: queryBase({ liga_casa_id: "abc-123" }) });
    assert.equal(resp.statusCode, 200);
    const body = JSON.parse(resp.body);
    assert.equal(body.game_id, 1001);
  });

  it("acepta liga_casa_id numerico como string", async () => {
    mockearFetch({ equivalencia, partidos: [partido1], equipos });
    const resp = await app.inject({ method: "GET", url: queryBase() });
    assert.equal(resp.statusCode, 200);
    const body = JSON.parse(resp.body);
    assert.equal(body.game_id, 1001);
  });

  it("preserva ceros a la izquierda en liga_casa_id", async () => {
    mockearFetch({ equivalencia: { ...equivalencia, liga_casa_id: "00123" }, partidos: [partido1], equipos });
    const resp = await app.inject({ method: "GET", url: queryBase({ liga_casa_id: "00123" }) });
    assert.equal(resp.statusCode, 200);
    const llamadaEquivalencia = llamadasFetch.find(
      (c) => c.url.includes(TABLA_EQUIVALENCIAS) && c.method === "GET",
    )!;
    assert.ok(llamadaEquivalencia.url.includes("liga_casa_id=eq.00123"), "Debe enviar '00123' sin convertir a numero");
  });
});

describe("formato de errores", () => {
  let app: FastifyInstance;
  before(async () => { app = crearServidor(); await app.ready(); });
  after(() => app.close());
  afterEach(() => { globalThis.fetch = fetchOriginal; delete process.env.API_TOKEN; });

  it("VALIDACION: parametros invalidos", async () => {
    mockearFetch({});
    const resp = await app.inject({ method: "GET", url: "/buscar-partido" });
    assert.equal(resp.statusCode, 400);
    const body = JSON.parse(resp.body);
    assert.equal(body.error.codigo, "VALIDACION");
    assert.equal(body.error.mensaje, "Parámetros inválidos");
    assert.ok(Array.isArray(body.error.detalles));
  });

  it("NO_AUTORIZADO: token API requerido", async () => {
    process.env.API_TOKEN = "secreto";
    mockearFetch({});
    const resp = await app.inject({ method: "GET", url: queryBase() });
    assert.equal(resp.statusCode, 401);
    const body = JSON.parse(resp.body);
    assert.equal(body.error.codigo, "NO_AUTORIZADO");
  });

  it("NO_AUTORIZADO: permite acceso con token correcto", async () => {
    process.env.API_TOKEN = "secreto";
    mockearFetch({ equivalencia, partidos: [partido1], equipos });
    const resp = await app.inject({
      method: "GET",
      url: queryBase(),
      headers: { authorization: "Bearer secreto" },
    });
    assert.equal(resp.statusCode, 200);
  });

  it("LIGA_NO_MAPEADA: equivalencia no encontrada", async () => {
    mockearFetch({ equivalencia: null });
    const resp = await app.inject({ method: "GET", url: queryBase() });
    assert.equal(resp.statusCode, 404);
    const body = JSON.parse(resp.body);
    assert.equal(body.error.codigo, "LIGA_NO_MAPEADA");
  });

  it("PARTIDO_NO_ENCONTRADO: sin partidos en la fecha", async () => {
    mockearFetch({ equivalencia, partidos: [], equipos: [] });
    const resp = await app.inject({ method: "GET", url: queryBase() });
    assert.equal(resp.statusCode, 404);
    const body = JSON.parse(resp.body);
    assert.equal(body.error.codigo, "PARTIDO_NO_ENCONTRADO");
  });

  it("PARTIDO_AMBIGUO: multiples candidatos con lista", async () => {
    const partidoDuplicado = { ...partido1, game_id: 1099 };
    mockearFetch({ equivalencia, partidos: [partido1, partidoDuplicado], equipos });
    const resp = await app.inject({ method: "GET", url: queryBase() });
    assert.equal(resp.statusCode, 409);
    const body = JSON.parse(resp.body);
    assert.equal(body.error.codigo, "PARTIDO_AMBIGUO");
    assert.ok(Array.isArray(body.error.candidatos));
    assert.equal(body.error.candidatos.length, 2);
  });

  it("NO_AUTORIZADO en POST /api/sync sin token", async () => {
    mockearFetch({});
    const resp = await app.inject({ method: "POST", url: "/api/sync" });
    assert.equal(resp.statusCode, 401);
    const body = JSON.parse(resp.body);
    assert.equal(body.error.codigo, "NO_AUTORIZADO");
  });
});

describe("auto-alias seguro", () => {
  let app: FastifyInstance;
  before(async () => { app = crearServidor(); await app.ready(); });
  after(() => app.close());
  afterEach(() => { globalThis.fetch = fetchOriginal; delete process.env.API_TOKEN; });

  it("guarda alias cuando inicio esta dentro de 30 min", async () => {
    mockearFetch({
      equivalencia,
      partidos: [partido1],
      allPartidos: [partido1, partido2],
      equipos,
    });
    const resp = await app.inject({
      method: "GET",
      url: queryBase({
        local: "Atletico Nacional",
        visitante: "Embajadores",
        inicio: "2025-02-15T20:15:00-05:00",
      }),
    });
    assert.equal(resp.statusCode, 200);
    const body = JSON.parse(resp.body);
    assert.equal(body.game_id, 1001);
    assert.ok(aliasGuardado(), "Debio guardar el alias");
  });

  it("no guarda alias sin parametro inicio", async () => {
    mockearFetch({
      equivalencia,
      partidos: [partido1],
      equipos,
    });
    const resp = await app.inject({
      method: "GET",
      url: queryBase({ local: "Atletico Nacional", visitante: "Embajadores" }),
    });
    assert.equal(resp.statusCode, 200);
    assert.ok(!aliasGuardado(), "No debio guardar el alias");
  });

  it("no guarda alias cuando inicio esta lejos (>30 min)", async () => {
    mockearFetch({
      equivalencia,
      partidos: [partido1],
      equipos,
    });
    const resp = await app.inject({
      method: "GET",
      url: queryBase({
        local: "Atletico Nacional",
        visitante: "Embajadores",
        inicio: "2025-02-15T21:00:00-05:00",
      }),
    });
    assert.equal(resp.statusCode, 200);
    assert.ok(!aliasGuardado(), "No debio guardar el alias (inicio lejano)");
  });

  it("no guarda alias cuando coincide con otro equipo de la competicion", async () => {
    mockearFetch({
      equivalencia,
      partidos: [partido1],
      allPartidos: [partido1, partido2],
      equipos,
    });
    const resp = await app.inject({
      method: "GET",
      url: queryBase({
        local: "Atletico Nacional",
        visitante: "Cali",
        inicio: "2025-02-15T20:00:00-05:00",
      }),
    });
    assert.equal(resp.statusCode, 200);
    assert.ok(!aliasGuardado(), "No debio guardar el alias (coincide con Deportivo Cali)");
  });
});
