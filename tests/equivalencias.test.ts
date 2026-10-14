/** Tests de GET /equivalencias: filtro de activas, liga_casa_id string, orden, paginacion, auth y errores */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crearServidor } from "../src/servidor.js";
import type { FastifyInstance } from "fastify";

process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_KEY = "test-key";
process.env.SYNC_TOKEN = "test-sync-token";

const TABLA_EQUIVALENCIAS = "equivalencias_liga";
const TABLA_PARTIDOS = "partidos_programados_365";

interface Fila {
  id: number;
  casa: string;
  liga_casa_id: string | number;
  competition_id_365: number;
  activa: boolean | null;
  ultima_sincronizacion: string | null;
}

const ahora = new Date().toISOString();

const TABLA: Fila[] = [
  { id: 1, casa: "betplay", liga_casa_id: "1000094985", competition_id_365: 7, activa: true, ultima_sincronizacion: ahora },
  { id: 2, casa: "betplay", liga_casa_id: "00123", competition_id_365: 11, activa: true, ultima_sincronizacion: ahora },
  { id: 3, casa: "betplay", liga_casa_id: "555", competition_id_365: 99, activa: false, ultima_sincronizacion: ahora },
  { id: 4, casa: "betplay", liga_casa_id: "888", competition_id_365: 98, activa: null, ultima_sincronizacion: ahora },
  { id: 5, casa: "otracasa", liga_casa_id: "777", competition_id_365: 5, activa: true, ultima_sincronizacion: ahora },
];

const fetchOriginal = globalThis.fetch;

/** Simula PostgREST: filtros eq. de casa/liga_casa_id/activa, orden por id, offset/limit y tope max-rows */
function mockearSupabase(tabla: Fila[], opciones: { maxFilas?: number; status?: number } = {}) {
  const { maxFilas = 1000, status = 200 } = opciones;

  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const json = (data: unknown, codigo = 200) =>
      new Response(JSON.stringify(data), { status: codigo, headers: { "Content-Type": "application/json" } });

    if (status !== 200) return json({ message: "fallo simulado" }, status);

    if (url.pathname.endsWith(`/${TABLA_EQUIVALENCIAS}`)) {
      const p = url.searchParams;
      const filas = tabla
        .filter((f) =>
          (["casa", "liga_casa_id", "activa"] as const).every((col) => {
            const filtro = p.get(col);
            return filtro === null || String(f[col]) === filtro.replace(/^eq\./, "");
          }),
        )
        .sort((a, b) => a.id - b.id);
      const offset = Number(p.get("offset") ?? 0);
      const limite = Math.min(Number(p.get("limit") ?? Infinity), maxFilas);
      return json(filas.slice(offset, offset + limite));
    }
    if (url.pathname.endsWith(`/${TABLA_PARTIDOS}`)) return json([]);

    return json({ error: "Inesperado: " + url }, 500);
  }) as typeof globalThis.fetch;
}

describe("GET /equivalencias", () => {
  let app: FastifyInstance;
  before(async () => { app = crearServidor(); await app.ready(); });
  after(() => app.close());
  afterEach(() => { globalThis.fetch = fetchOriginal; delete process.env.API_TOKEN; });

  const pedir = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers });

  it("casa con equivalencias: solo activas, ordenadas por liga_casa_id", async () => {
    mockearSupabase(TABLA);
    const resp = await pedir("/equivalencias?casa=betplay");
    assert.equal(resp.statusCode, 200);
    assert.deepEqual(JSON.parse(resp.body), {
      casa: "betplay",
      total: 2,
      equivalencias: [
        { liga_casa_id: "00123", competition_id_365: 11 },
        { liga_casa_id: "1000094985", competition_id_365: 7 },
      ],
    });
  });

  it("casa sin equivalencias: 200 con total 0 y lista vacia", async () => {
    mockearSupabase(TABLA);
    const resp = await pedir("/equivalencias?casa=sinligas");
    assert.equal(resp.statusCode, 200);
    assert.deepEqual(JSON.parse(resp.body), { casa: "sinligas", total: 0, equivalencias: [] });
  });

  it("liga_casa_id \"00123\" se mantiene como string con ceros a la izquierda", async () => {
    mockearSupabase(TABLA);
    const body = JSON.parse((await pedir("/equivalencias?casa=betplay")).body);
    const liga = body.equivalencias.find((e: { competition_id_365: number }) => e.competition_id_365 === 11);
    assert.strictEqual(liga.liga_casa_id, "00123");
  });

  it("liga_casa_id sale como string aunque la columna devuelva un numero", async () => {
    mockearSupabase([{ ...TABLA[0], liga_casa_id: 1000094985 }]);
    const body = JSON.parse((await pedir("/equivalencias?casa=betplay")).body);
    assert.strictEqual(body.equivalencias[0].liga_casa_id, "1000094985");
    assert.strictEqual(body.equivalencias[0].competition_id_365, 7);
  });

  it("una equivalencia inactiva (false o null) no aparece", async () => {
    mockearSupabase(TABLA);
    const body = JSON.parse((await pedir("/equivalencias?casa=betplay")).body);
    const ids = body.equivalencias.map((e: { liga_casa_id: string }) => e.liga_casa_id);
    assert.ok(!ids.includes("555"), "activa=false no debe aparecer");
    assert.ok(!ids.includes("888"), "activa=null no debe aparecer");
  });

  it("lista exactamente las ligas que /buscar-partido no rechaza con LIGA_NO_MAPEADA", async () => {
    mockearSupabase(TABLA);
    const body = JSON.parse((await pedir("/equivalencias?casa=betplay")).body);
    const listadas = new Set(body.equivalencias.map((e: { liga_casa_id: string }) => e.liga_casa_id));

    for (const fila of TABLA.filter((f) => f.casa === "betplay")) {
      const query = new URLSearchParams({
        casa: "betplay", liga_casa_id: String(fila.liga_casa_id), fecha: "2026-10-13", local: "A", visitante: "B",
      });
      const resp = await pedir(`/buscar-partido?${query}`);
      const noMapeada = JSON.parse(resp.body).error?.codigo === "LIGA_NO_MAPEADA";
      assert.equal(noMapeada, !listadas.has(String(fila.liga_casa_id)), `liga_casa_id ${fila.liga_casa_id}`);
    }
  });

  it("trae todas las filas aunque superen el max-rows de PostgREST", async () => {
    const muchas: Fila[] = Array.from({ length: 2500 }, (_, i) => ({
      id: i + 1,
      casa: "grande",
      liga_casa_id: String(i).padStart(5, "0"),
      competition_id_365: i,
      activa: true,
      ultima_sincronizacion: null,
    }));

    for (const maxFilas of [1000, 300]) {
      mockearSupabase(muchas, { maxFilas });
      const body = JSON.parse((await pedir("/equivalencias?casa=grande")).body);
      assert.equal(body.total, 2500, `max-rows ${maxFilas}`);
      assert.equal(body.equivalencias.length, 2500, `max-rows ${maxFilas}`);
      assert.equal(new Set(body.equivalencias.map((e: { liga_casa_id: string }) => e.liga_casa_id)).size, 2500);
    }
  });

  it("casa ausente o vacia: 400 VALIDACION", async () => {
    mockearSupabase(TABLA);
    for (const url of ["/equivalencias", "/equivalencias?casa="]) {
      const resp = await pedir(url);
      assert.equal(resp.statusCode, 400, url);
      assert.equal(JSON.parse(resp.body).error.codigo, "VALIDACION", url);
    }
  });

  it("token incorrecto o ausente: 401 NO_AUTORIZADO; correcto: 200", async () => {
    process.env.API_TOKEN = "secreto";
    mockearSupabase(TABLA);

    for (const headers of [{ authorization: "Bearer otro" }, {}]) {
      const resp = await pedir("/equivalencias?casa=betplay", headers);
      assert.equal(resp.statusCode, 401);
      assert.equal(JSON.parse(resp.body).error.codigo, "NO_AUTORIZADO");
    }

    const resp = await pedir("/equivalencias?casa=betplay", { authorization: "Bearer secreto" });
    assert.equal(resp.statusCode, 200);
  });

  it("fallo de Supabase: 502 STATS_NO_DISPONIBLE como el resto del servicio", async () => {
    const errorOriginal = console.error;
    console.error = () => {};
    try {
      mockearSupabase(TABLA, { status: 500 });
      const resp = await pedir("/equivalencias?casa=betplay");
      assert.equal(resp.statusCode, 502);
      assert.equal(JSON.parse(resp.body).error.codigo, "STATS_NO_DISPONIBLE");
    } finally {
      console.error = errorOriginal;
    }
  });
});
