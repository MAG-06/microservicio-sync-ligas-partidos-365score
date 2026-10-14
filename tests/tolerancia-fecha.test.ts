/** Tests de la segunda busqueda con tolerancia de fecha (casa y 365Scores con el partido en dias distintos) */

import { describe, it, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { crearServidor } from "../src/servidor.js";
import { esquemaRespuesta365 } from "../src/esquemas/validacion.js";
import { mapearEstado } from "../src/vistas-modelo/estado.js";
import type { PartidoProgramadoDB } from "../src/modelos/tipos.js";

process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_KEY = "test-key";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TABLA_EQUIVALENCIAS = "equivalencias_liga";
const TABLA_PARTIDOS = "partidos_programados_365";
const TABLA_EQUIPOS = "equipos_365";

const ahora = new Date().toISOString();

const equivalencia = {
  id: 1,
  casa: "betplay",
  liga_casa_id: "1000449742",
  competition_id_365: 620,
  activa: true,
  ultima_sincronizacion: ahora,
};

const equipos = [
  { id: 8637, nombre: "Millonarios", alias: [] },
  { id: 10377, nombre: "Jaguares de Córdoba", alias: [] },
];

/** Partidos reales de 365Scores (competicion 620) del 13 al 21 de octubre de 2026 */
function partidosReales(): PartidoProgramadoDB[] {
  const ruta = join(__dirname, "fixtures", "partidos-620-octubre-2026.json");
  const datos = esquemaRespuesta365.parse(JSON.parse(readFileSync(ruta, "utf-8")));
  return datos.games.map((g) => ({
    game_id: g.id,
    competition_id: g.competitionId,
    fecha_hora: g.startTime,
    estado: mapearEstado(g.statusGroup, g.statusText),
    ronda: g.roundNum ?? null,
    local_id: g.homeCompetitor.id,
    local_nombre: g.homeCompetitor.name,
    visitante_id: g.awayCompetitor.id,
    visitante_nombre: g.awayCompetitor.name,
    actualizado_en: ahora,
  }));
}

function millonariosJaguares(gameId: number, fechaHora: string): PartidoProgramadoDB {
  return {
    game_id: gameId,
    competition_id: 620,
    fecha_hora: fechaHora,
    estado: "programado",
    ronda: 15,
    local_id: 8637,
    local_nombre: "Millonarios",
    visitante_id: 10377,
    visitante_nombre: "Jaguares de Córdoba",
    actualizado_en: ahora,
  };
}

interface Llamada {
  url: URL;
  method: string;
}

let llamadas: Llamada[] = [];
const fetchOriginal = globalThis.fetch;

function rangoConsultado(url: URL): [number, number] | null {
  const m = (url.searchParams.get("and") ?? "").match(/fecha_hora\.gte\.([^,]+),fecha_hora\.lte\.([^)]+)/);
  return m ? [Date.parse(m[1]), Date.parse(m[2])] : null;
}

/** Simula PostgREST: los partidos se filtran por el rango fecha_hora.gte/lte de cada consulta */
function mockearFetch(partidos: PartidoProgramadoDB[]) {
  llamadas = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    llamadas.push({ url, method });

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.pathname.endsWith(TABLA_EQUIVALENCIAS) && method === "GET") {
      return json([equivalencia]);
    }
    if (url.pathname.endsWith(TABLA_PARTIDOS) && method === "GET") {
      const [desde, hasta] = rangoConsultado(url) ?? [-Infinity, Infinity];
      return json(partidos.filter((p) => {
        const t = Date.parse(p.fecha_hora);
        return t >= desde && t <= hasta;
      }));
    }
    if (url.pathname.endsWith(TABLA_EQUIPOS) && method === "GET") {
      return json(equipos);
    }
    if (url.pathname.endsWith(TABLA_EQUIPOS) && method === "PATCH") {
      return new Response(null, { status: 204 });
    }

    return json({ error: "Inesperado: " + url }, 500);
  }) as typeof globalThis.fetch;
}

function rangosDePartidosConsultados(): [string, string][] {
  return llamadas
    .filter((c) => c.url.pathname.endsWith(TABLA_PARTIDOS) && c.method === "GET")
    .map((c) => rangoConsultado(c.url))
    .filter((r): r is [number, number] => r !== null)
    .map(([desde, hasta]) => [new Date(desde).toISOString(), new Date(hasta).toISOString()]);
}

function aliasGuardado(): boolean {
  return llamadas.some((c) => c.url.pathname.endsWith(TABLA_EQUIPOS) && c.method === "PATCH");
}

/** Peticion real de BetPlay; un cambio con valor null quita el parametro */
function queryBetplay(cambios: Record<string, string | null> = {}): string {
  const params = new URLSearchParams({
    casa: "betplay",
    liga_casa_id: "1000449742",
    fecha: "2026-10-17",
    local: "Millonarios FC",
    visitante: "Jaguares de Córdoba",
    inicio: "2026-10-17T18:05:00-05:00",
  });
  for (const [k, v] of Object.entries(cambios)) {
    if (v === null) params.delete(k);
    else params.set(k, v);
  }
  return `/buscar-partido?${params}`;
}

describe("tolerancia de fecha (segunda busqueda)", () => {
  let app: FastifyInstance;
  before(async () => { app = crearServidor(); await app.ready(); });
  after(() => app.close());
  afterEach(() => { globalThis.fetch = fetchOriginal; });

  it("caso real: BetPlay 17-oct 18:05 encuentra Millonarios-Jaguares de 365Scores el 19-oct 18:30", async () => {
    mockearFetch(partidosReales());
    const resp = await app.inject({ method: "GET", url: queryBetplay() });
    assert.equal(resp.statusCode, 200);
    const body = JSON.parse(resp.body);
    assert.equal(body.game_id, 4731954);
    assert.equal(body.local, "Millonarios");
    assert.equal(body.visitante, "Jaguares de Córdoba");
    assert.equal(body.fecha_hora, "2026-10-19T18:30:00-05:00");
    assert.equal(body.fecha_difiere, true);
    // 2 dias y 25 minutos despues de la hora que da la casa
    assert.equal(body.diferencia_minutos, 2905);
    assert.ok(!aliasGuardado(), "No debio guardar alias");
  });

  it("no acepta un parcial fuera del dia exacto ni aprende alias", async () => {
    // Ningun Millonarios-Pasto existe; en la ventana solo esta Millonarios-Jaguares (parcial)
    mockearFetch(partidosReales());
    const resp = await app.inject({ method: "GET", url: queryBetplay({ visitante: "Deportivo Pasto" }) });
    assert.equal(resp.statusCode, 404);
    assert.equal(JSON.parse(resp.body).error.codigo, "PARTIDO_NO_ENCONTRADO");
    assert.deepEqual(rangosDePartidosConsultados(), [
      ["2026-10-17T05:00:00.000Z", "2026-10-18T04:59:59.999Z"],
      ["2026-10-14T05:00:00.000Z", "2026-10-21T04:59:59.999Z"],
    ], "Debio hacer la busqueda del dia y luego la ventana de ±3 dias");
    assert.ok(!aliasGuardado(), "No debio guardar alias en la segunda busqueda");
  });

  it("con varias coincidencias completas elige la mas cercana y el empate es ambiguo", async () => {
    mockearFetch([
      millonariosJaguares(9001, "2026-10-16T18:05:00-05:00"),
      millonariosJaguares(9002, "2026-10-19T18:30:00-05:00"),
    ]);
    const resp = await app.inject({ method: "GET", url: queryBetplay() });
    assert.equal(resp.statusCode, 200);
    const body = JSON.parse(resp.body);
    assert.equal(body.game_id, 9001);
    assert.equal(body.fecha_difiere, true);
    assert.equal(body.diferencia_minutos, -1440);

    // Sin inicio la referencia es el mediodia de fecha: los dos quedan a 24 h
    mockearFetch([
      millonariosJaguares(9003, "2026-10-16T12:00:00-05:00"),
      millonariosJaguares(9004, "2026-10-18T12:00:00-05:00"),
    ]);
    const respEmpate = await app.inject({ method: "GET", url: queryBetplay({ inicio: null }) });
    assert.equal(respEmpate.statusCode, 409);
    const error = JSON.parse(respEmpate.body).error;
    assert.equal(error.codigo, "PARTIDO_AMBIGUO");
    assert.deepEqual(error.candidatos.map((c: { game_id: number }) => c.game_id).sort(), [9003, 9004]);
    assert.ok(error.candidatos.every((c: { fecha_difiere: boolean }) => c.fecha_difiere));
  });
});
