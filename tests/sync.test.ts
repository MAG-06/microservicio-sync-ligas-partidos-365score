/** Tests del sync: una liga que falla no tumba a las demas, errores en la respuesta, logs de progreso y 502 por respuesta invalida de 365 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z, ZodError } from "zod";
import { crearServidor } from "../src/servidor.js";
import {
  sincronizarTodas,
  sincronizarCompeticion,
  ErrorRespuesta365Invalida,
} from "../src/vistas-modelo/sync.vm.js";
import { describirFallo, resumirIssuesZod } from "../src/utilidades/errores.js";
import type { FastifyInstance } from "fastify";

process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_KEY = "test-key";
process.env.SYNC_TOKEN = "test-sync-token";

const AUTH = { authorization: "Bearer test-sync-token" };

const TABLA_EQUIVALENCIAS = "equivalencias_liga";
const TABLA_PARTIDOS = "partidos_programados_365";
const TABLA_EQUIPOS = "equipos_365";

/** 365Scores responde 2 partidos validos */
const COMPETICION_OK = 620;
const COMPETICION_OK_2 = 700;
/** 365Scores responde algo que no pasa Zod (6 issues) */
const COMPETICION_INVALIDA = 999;
/** 365Scores responde 404 (no reintentable) */
const COMPETICION_404 = 555;

interface LlamadaFetch {
  url: URL;
  method: string;
}

let llamadas: LlamadaFetch[] = [];
const fetchOriginal = globalThis.fetch;

function juego(id: number, competitionId: number) {
  return {
    id,
    competitionId,
    startTime: "2026-10-13T20:00:00-05:00",
    statusText: "Scheduled",
    statusGroup: 2,
    roundNum: 1,
    homeCompetitor: { id: id * 10 + 1, name: `Local ${id}` },
    awayCompetitor: { id: id * 10 + 2, name: `Visitante ${id}` },
  };
}

function mockearFetch(competiciones: number[], ultimaSincronizacion: string | null = new Date().toISOString()) {
  llamadas = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    llamadas.push({ url, method });

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.hostname.includes("365scores")) {
      const id = Number(url.searchParams.get("competitions"));
      if (id === COMPETICION_404) return new Response("no existe", { status: 404, statusText: "Not Found" });
      if (id === COMPETICION_INVALIDA) return json({ games: [{ id: "no-numero", competitionId: id }] });
      return json({ games: [juego(id * 100 + 1, id), juego(id * 100 + 2, id)] });
    }

    if (url.pathname.endsWith(`/${TABLA_EQUIVALENCIAS}`)) {
      if (method === "PATCH") return new Response(null, { status: 204 });
      return json(competiciones.map((c, i) => ({
        id: i + 1,
        casa: "betplay",
        liga_casa_id: String(100 + i),
        competition_id_365: c,
        activa: true,
        ultima_sincronizacion: ultimaSincronizacion,
      })));
    }
    if (url.pathname.endsWith(`/${TABLA_PARTIDOS}`) || url.pathname.endsWith(`/${TABLA_EQUIPOS}`)) {
      if (method === "POST") return new Response(null, { status: 201 });
      return json([]);
    }

    return json({ error: "Inesperado: " + url }, 500);
  }) as typeof globalThis.fetch;
}

/** Competiciones a las que se les marco ultima_sincronizacion (solo pasa si todo el upsert salio bien) */
function competicionesSincronizadas(): number[] {
  return llamadas
    .filter((l) => l.url.pathname.endsWith(`/${TABLA_EQUIVALENCIAS}`) && l.method === "PATCH")
    .map((l) => Number(l.url.searchParams.get("competition_id_365")?.replace(/^eq\./, "")))
    .sort((a, b) => a - b);
}

function capturarConsola() {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capturado = { log: [] as string[], warn: [] as string[], error: [] as string[] };
  const capturar = (destino: string[]) => (...args: unknown[]) => { destino.push(args.map(String).join(" ")); };
  console.log = capturar(capturado.log);
  console.warn = capturar(capturado.warn);
  console.error = capturar(capturado.error);
  return {
    ...capturado,
    restaurar: () => Object.assign(console, original),
  };
}

describe("sincronizarTodas: una competicion que falla no tumba el sync", () => {
  afterEach(() => { globalThis.fetch = fetchOriginal; });

  it("sigue con las demas ligas (en el mismo lote y en el siguiente) y reporta cada fallo", async () => {
    // CONCURRENCIA_MAX = 2 → lote 1: [620, 999], lote 2: [555, 700]
    mockearFetch([COMPETICION_OK, COMPETICION_INVALIDA, COMPETICION_404, COMPETICION_OK_2]);
    const consola = capturarConsola();
    let resultado;
    try {
      resultado = await sincronizarTodas();
    } finally {
      consola.restaurar();
    }

    assert.equal(resultado.ligas, 4);
    assert.equal(resultado.partidos, 4, "2 partidos por cada competicion que salio bien");
    assert.deepEqual(resultado.errores.map((e) => e.competition_id), [COMPETICION_INVALIDA, COMPETICION_404]);
    assert.match(
      resultado.errores[0].motivo,
      /^Respuesta de 365Scores con formato inesperado: games\.0\.id: Expected number, received string; /,
    );
    assert.match(resultado.errores[0].motivo, /\(\+3 mas\)$/, "Solo las 3 primeras issues");
    assert.match(resultado.errores[1].motivo, /365Scores 404/);

    assert.deepEqual(competicionesSincronizadas(), [COMPETICION_OK, COMPETICION_OK_2]);

    assert.equal(consola.error.length, 2);
    assert.ok(consola.error[0].includes(`competition_id ${COMPETICION_INVALIDA}`), consola.error[0]);
    assert.ok(consola.error[0].includes("games.0.id"), consola.error[0]);
    assert.ok(consola.error[1].includes(`competition_id ${COMPETICION_404}`), consola.error[1]);
    assert.ok(consola.error[1].includes("365Scores 404"), consola.error[1]);
  });

  it("loguea inicio, cada lote terminado y fin con segundos totales", async () => {
    mockearFetch([COMPETICION_OK, COMPETICION_INVALIDA, COMPETICION_OK_2]);
    const consola = capturarConsola();
    try {
      await sincronizarTodas();
    } finally {
      consola.restaurar();
    }

    assert.equal(consola.log.length, 4, consola.log.join("\n"));
    assert.match(consola.log[0], /^\[sync\] Inicio: 3 ligas en 2 lotes$/);
    assert.match(consola.log[1], /^\[sync\] Lote 1\/2 terminado \(2\/3 ligas\)$/);
    assert.match(consola.log[2], /^\[sync\] Lote 2\/2 terminado \(3\/3 ligas\)$/);
    assert.match(consola.log[3], /^\[sync\] Fin: 3 ligas, 4 partidos, 1 errores en \d+\.\d s$/);
  });

  it("sin ligas activas: inicio y fin, sin lotes", async () => {
    mockearFetch([]);
    const consola = capturarConsola();
    let resultado;
    try {
      resultado = await sincronizarTodas();
    } finally {
      consola.restaurar();
    }

    assert.deepEqual(resultado, { ligas: 0, partidos: 0, errores: [] });
    assert.equal(consola.log.length, 2);
    assert.match(consola.log[0], /Inicio: 0 ligas/);
    assert.match(consola.log[1], /Fin: 0 ligas/);
  });
});

describe("POST /api/sync: los errores van en la respuesta", () => {
  let app: FastifyInstance;
  before(async () => { app = crearServidor(); await app.ready(); });
  after(() => app.close());
  afterEach(() => { globalThis.fetch = fetchOriginal; });

  const sincronizar = async () => {
    const consola = capturarConsola();
    try {
      return await app.inject({ method: "POST", url: "/api/sync", headers: AUTH });
    } finally {
      consola.restaurar();
    }
  };

  it("200 con { ligas, partidos, errores } aunque una liga falle", async () => {
    mockearFetch([COMPETICION_OK, COMPETICION_INVALIDA]);
    const resp = await sincronizar();
    assert.equal(resp.statusCode, 200);

    const body = JSON.parse(resp.body);
    assert.deepEqual(Object.keys(body).sort(), ["errores", "ligas", "partidos"]);
    assert.equal(body.ligas, 2);
    assert.equal(body.partidos, 2);
    assert.equal(body.errores.length, 1);
    assert.deepEqual(Object.keys(body.errores[0]).sort(), ["competition_id", "motivo"]);
    assert.equal(body.errores[0].competition_id, COMPETICION_INVALIDA);
    assert.match(body.errores[0].motivo, /formato inesperado: games\.0\.id/);
  });

  it("todo bien: errores es una lista vacia", async () => {
    mockearFetch([COMPETICION_OK]);
    const resp = await sincronizar();
    assert.equal(resp.statusCode, 200);
    assert.deepEqual(JSON.parse(resp.body), { ligas: 1, partidos: 2, errores: [] });
  });
});

describe("sincronizarCompeticion: respuesta de 365 que no pasa Zod", () => {
  afterEach(() => { globalThis.fetch = fetchOriginal; });

  it("lanza ErrorRespuesta365Invalida (no ZodError) y no escribe en Supabase", async () => {
    mockearFetch([COMPETICION_INVALIDA]);
    await assert.rejects(sincronizarCompeticion(COMPETICION_INVALIDA), (error: unknown) => {
      assert.ok(error instanceof ErrorRespuesta365Invalida);
      assert.ok(!(error instanceof ZodError));
      assert.equal(error.competitionId, COMPETICION_INVALIDA);
      assert.ok(error.cause instanceof ZodError, "El ZodError original queda como cause");
      assert.match(error.message, /games\.0\.id: Expected number, received string/);
      return true;
    });
    assert.ok(!llamadas.some((l) => l.method !== "GET"), "No debe hacer upserts ni PATCH");
  });
});

describe("manejador de errores: respuesta invalida de 365 durante /buscar-partido", () => {
  let app: FastifyInstance;
  before(async () => { app = crearServidor(); await app.ready(); });
  after(() => app.close());
  afterEach(() => { globalThis.fetch = fetchOriginal; });

  it("502 STATS_NO_DISPONIBLE (no 400 VALIDACION) y loguea el detalle con console.error", async () => {
    // ultima_sincronizacion null → buscar-partido sincroniza la competicion antes de buscar
    mockearFetch([COMPETICION_INVALIDA], null);
    const query = new URLSearchParams({
      casa: "betplay", liga_casa_id: "100", fecha: "2026-10-13", local: "A", visitante: "B",
    });
    const consola = capturarConsola();
    let resp;
    try {
      resp = await app.inject({ method: "GET", url: `/buscar-partido?${query}` });
    } finally {
      consola.restaurar();
    }

    assert.equal(resp.statusCode, 502);
    const body = JSON.parse(resp.body);
    assert.equal(body.error.codigo, "STATS_NO_DISPONIBLE");
    assert.equal(body.error.mensaje, "Servicio de estadísticas no disponible");
    assert.equal(body.error.detalles, undefined, "Las issues de Zod no van al cliente");

    assert.equal(consola.error.length, 1);
    const linea = consola.error[0];
    assert.ok(linea.includes("GET /buscar-partido"), linea);
    assert.ok(linea.includes("ErrorRespuesta365Invalida"), linea);
    assert.ok(linea.includes("games.0.id"), linea);
  });
});

describe("describirFallo / resumirIssuesZod", () => {
  const esquema = z.object({
    a: z.number(),
    b: z.string(),
    c: z.object({ d: z.number() }),
    e: z.boolean(),
    f: z.number(),
  });
  const zodError = esquema.safeParse({ a: "x", c: {} }).error!;

  it("un ZodError se resume en sus 3 primeras issues con path y message", () => {
    assert.equal(zodError.issues.length, 5);
    const esperado = "a: Expected number, received string; b: Required; c.d: Required (+2 mas)";
    assert.equal(resumirIssuesZod(zodError), esperado);
    assert.equal(describirFallo(zodError), esperado);
  });

  it("con 3 issues o menos no agrega el contador; una issue en la raiz se marca como (raiz)", () => {
    const pocas = z.object({ a: z.number() }).safeParse({}).error!;
    assert.equal(resumirIssuesZod(pocas), "a: Required");
    const raiz = z.number().safeParse("x").error!;
    assert.equal(resumirIssuesZod(raiz), "(raiz): Expected number, received string");
  });

  it("otros errores usan su mensaje; lo que no es Error se convierte a texto", () => {
    assert.equal(describirFallo(new Error("se cayo")), "se cayo");
    assert.equal(describirFallo("texto suelto"), "texto suelto");
  });
});
