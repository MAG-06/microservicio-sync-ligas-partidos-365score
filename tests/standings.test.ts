/** Tests de /api/sync-standings con JSON reales de 365 (Premier 7, Liga BetPlay 620): recorte, validacion de fase, fotos sin cambios, temporada anterior y fallos por liga */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { crearServidor } from "../src/servidor.js";
import {
  recortarFilas,
  filasIguales,
  describirCambios,
  equiposQueNoCuadran,
  sincronizarStandingsCompeticion,
  sincronizarTodasStandings,
} from "../src/vistas-modelo/standings.vm.js";
import { esquemaStandings365 } from "../src/esquemas/validacion.js";
import { upsertFotosStandings } from "../src/modelos/supabase.js";
import { hoyBogota } from "../src/utilidades/fecha.js";
import type { FotoStandingDB } from "../src/modelos/tipos.js";

process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_KEY = "test-key";
process.env.SYNC_TOKEN = "test-sync-token";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TABLA_EQUIVALENCIAS = "equivalencias_liga";
const TABLA_STANDINGS = "standings_365";
const TABLA_PARTIDOS = "partidos_programados_365";

/** Asi responde 365 una temporada sin datos: sin la clave `standings` */
const SIN_DATOS = { lastUpdateId: 0, ttl: 0 };

const PREMIER = 7;
const BETPLAY = 620;
/** Liga de una fase que no esta en TEMPORADA_ANTERIOR (usa los JSON de la Premier) */
const LIGA_SIN_MAPA = 8;
/** 365Scores responde 404 (no reintentable) */
const LIGA_404 = 555;

const AYER = "2000-01-01";

type Json = any;

function fixture(nombre: string): Json {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", "365-standings", nombre), "utf-8"));
}

/** Copia de un fixture con otra temporada/fase en standings[0] y/o competitions[0] */
function conTemporada(base: Json, cambios: { seasonNum?: number; stageNum?: number; actual?: number }): Json {
  const copia = structuredClone(base);
  if (cambios.seasonNum !== undefined) copia.standings[0].seasonNum = cambios.seasonNum;
  if (cambios.stageNum !== undefined) copia.standings[0].stageNum = cambios.stageNum;
  if (cambios.actual !== undefined) copia.competitions[0].currentSeasonNum = cambios.actual;
  return copia;
}

function filasDe(nombre: string) {
  return recortarFilas(esquemaStandings365.parse(fixture(nombre)).standings[0].rows);
}

// --- Respuestas de 365 por competicion ---

interface Peticion365 {
  competitionId: number;
  seasonNum?: number;
  stageNum?: number;
  type: number;
}

type Responder365 = (p: Peticion365) => Json | Response;

const PREMIER_ACTUAL: Record<number, string> = {
  1: "premier-standings-total.json",
  2: "premier-standings-local.json",
  3: "premier-standings-visitante.json",
};
const PREMIER_ANTERIOR: Record<number, string> = {
  1: "premier-standings-anterior-total.json",
  2: "premier-standings-anterior-local.json",
  3: "premier-standings-anterior-local.json",
};

/**
 * Para tablas con un solo JSON de ejemplo: arma la local (type 2) o la visitante (type 3) partiendo los
 * partidos de cada equipo, asi local + visitante = total como en 365
 */
function partirPorType(base: Json, type: number): Json {
  if (type === 1) return base;
  const copia = structuredClone(base);
  for (const r of copia.standings[0].rows) {
    const local = Math.floor(r.gamePlayed / 2);
    r.gamePlayed = type === 2 ? local : r.gamePlayed - local;
  }
  return copia;
}

/** No hay JSON de la visitante 2025/26: se arma con la total menos la local, equipo por equipo */
function visitanteDesde(total: Json, local: Json): Json {
  const copia = structuredClone(local);
  const partidosTotal = new Map(total.standings[0].rows.map((r: Json) => [r.competitor.id, r.gamePlayed]));
  for (const r of copia.standings[0].rows) r.gamePlayed = (partidosTotal.get(r.competitor.id) as number) - r.gamePlayed;
  return copia;
}

function responderPremier(p: Peticion365): Json {
  if (p.seasonNum === undefined || p.seasonNum === 132) return fixture(PREMIER_ACTUAL[p.type]);
  if (p.seasonNum === 131 && p.type === 3) {
    return visitanteDesde(fixture(PREMIER_ANTERIOR[1]), fixture(PREMIER_ANTERIOR[2]));
  }
  if (p.seasonNum === 131) return fixture(PREMIER_ANTERIOR[p.type]);
  return SIN_DATOS;
}

const BETPLAY_CLAUSURA: Record<number, string> = {
  1: "betplay-standings-clausura-total.json",
  2: "betplay-standings-clausura-local.json",
  3: "betplay-standings-clausura-local.json",
};

function responderBetplay(p: Peticion365): Json {
  if (p.seasonNum === undefined || (p.seasonNum === 130 && p.stageNum === 7)) return fixture(BETPLAY_CLAUSURA[p.type]);
  if (p.seasonNum === 130 && p.stageNum === 3) return partirPorType(fixture("betplay-standings-apertura-2026-local.json"), p.type);
  if (p.seasonNum === 130 && p.stageNum === 2) return fixture("betplay-standings-reclasificacion-2026.json");
  if (p.seasonNum === 127 && p.stageNum === 3) return partirPorType(fixture("betplay-standings-2025-apertura.json"), p.type);
  if (p.seasonNum === 127 && p.stageNum === 6) return partirPorType(fixture("betplay-standings-2025-finalizacion.json"), p.type);
  return SIN_DATOS;
}

const RESPONDERES: Record<number, Responder365> = {
  [PREMIER]: responderPremier,
  [BETPLAY]: responderBetplay,
  [LIGA_404]: () => new Response("no existe", { status: 404, statusText: "Not Found" }),
};

// --- Mock de fetch: 365 + Supabase en memoria ---

type FotoGuardada = FotoStandingDB & { id: number };

let peticiones365: Peticion365[] = [];
let fotosDB: FotoGuardada[] = [];
let posts: FotoStandingDB[][] = [];
let siguienteId = 1;
const fetchOriginal = globalThis.fetch;

function guardarFoto(foto: Omit<FotoStandingDB, "actualizado_en"> & { actualizado_en?: string }): void {
  fotosDB.push({ actualizado_en: "2000-01-01T00:00:00-05:00", ...foto, id: siguienteId++ });
}

/** Filtro `and` de cada consulta a partidos_programados_365 */
let filtrosPartidos: string[] = [];

/**
 * @param competiciones equivalencias activas
 * @param conPartidos las que tienen partidos en la ventana de dias (por defecto, todas las activas)
 */
function mockearFetch(
  competiciones: number[],
  responderes: Record<number, Responder365> = RESPONDERES,
  conPartidos: number[] = competiciones,
): void {
  peticiones365 = [];
  posts = [];
  filtrosPartidos = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    const numero = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);

    if (url.hostname.includes("365scores")) {
      assert.equal(url.pathname, "/web/standings/");
      const p: Peticion365 = {
        competitionId: Number(url.searchParams.get("competitions")),
        seasonNum: numero("seasonNum"),
        stageNum: numero("stageNum"),
        type: Number(url.searchParams.get("type")),
      };
      peticiones365.push(p);
      const respuesta = responderes[p.competitionId](p);
      return respuesta instanceof Response ? respuesta : json(respuesta);
    }

    if (url.pathname.endsWith(`/${TABLA_EQUIVALENCIAS}`)) {
      return json(competiciones.map((c, i) => ({
        id: i + 1, casa: "betplay", liga_casa_id: String(100 + i), competition_id_365: c, activa: true, ultima_sincronizacion: null,
      })));
    }

    if (url.pathname.endsWith(`/${TABLA_PARTIDOS}`)) {
      assert.equal(url.searchParams.get("select"), "competition_id");
      filtrosPartidos.push(url.searchParams.get("and") ?? "");
      // Un partido por competicion (dos para la primera) y pagina vacia despues
      if (Number(url.searchParams.get("offset")) > 0) return json([]);
      return json(conPartidos.flatMap((c, i) => (i === 0 ? [c, c] : [c])).map((c) => ({ competition_id: c })));
    }

    if (url.pathname.endsWith(`/${TABLA_STANDINGS}`)) {
      if (method === "POST") {
        assert.equal(url.searchParams.get("on_conflict"), "competition_id,season_num,stage_num,type,fecha");
        const fotos = JSON.parse(String(init?.body)) as FotoStandingDB[];
        posts.push(fotos);
        for (const f of fotos) {
          fotosDB = fotosDB.filter((g) => !(g.competition_id === f.competition_id && g.season_num === f.season_num &&
            g.stage_num === f.stage_num && g.type === f.type && g.fecha === f.fecha));
          guardarFoto(f);
        }
        return new Response(null, { status: 201 });
      }
      const ids = url.searchParams.get("id");
      if (ids) {
        const lista = ids.replace(/^in\.\(|\)$/g, "").split(",").map(Number);
        return json(fotosDB.filter((f) => lista.includes(f.id)).map((f) => ({ id: f.id, rows: f.rows })));
      }
      const competicion = Number(url.searchParams.get("competition_id")?.replace(/^eq\./, ""));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      const filas = fotosDB
        .filter((f) => f.competition_id === competicion)
        .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.id - a.id)
        .slice(offset, offset + limit)
        .map(({ id, season_num, stage_num, type, fecha, vigente_al_capturar }) =>
          ({ id, season_num, stage_num, type, fecha, vigente_al_capturar }));
      return json(filas);
    }

    return json({ error: "Inesperado: " + url }, 500);
  }) as typeof globalThis.fetch;
}

let pausas = 0;
const sinPausa = async () => { pausas++; };

function capturarConsola() {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capturado = { log: [] as string[], warn: [] as string[], error: [] as string[] };
  const capturar = (destino: string[]) => (...args: unknown[]) => { destino.push(args.map(String).join(" ")); };
  console.log = capturar(capturado.log);
  console.warn = capturar(capturado.warn);
  console.error = capturar(capturado.error);
  return { ...capturado, restaurar: () => Object.assign(console, original) };
}

/** Corre la sincronizacion de una liga con la consola silenciada */
async function sincronizar(competitionId: number) {
  const consola = capturarConsola();
  try {
    return await sincronizarStandingsCompeticion(competitionId, hoyBogota(), sinPausa);
  } finally {
    consola.restaurar();
  }
}

function clavesNuevas(): string[] {
  return posts.flat().map((f) => `${f.season_num}/${f.stage_num}/${f.type}`).sort();
}

function reiniciar(): void {
  fotosDB = [];
  siguienteId = 1;
  pausas = 0;
}

// --- Tests ---

describe("recortarFilas / filasIguales", () => {
  it("recorta cada fila a los 11 campos que se guardan; grupo null en una tabla sin grupos", () => {
    const filas = filasDe("premier-standings-total.json");
    assert.equal(filas.length, 20);
    assert.deepEqual(filas[0], {
      equipo_id: 110, nombre: "Manchester City", posicion: 1, partidos: 8,
      ganados: 7, empatados: 0, perdidos: 1, gf: 20, gc: 9, puntos: 21, grupo: null,
    });
    for (const f of filas) assert.equal(Object.keys(f).length, 11);
  });

  it("grupo es el groupNum de 365 en una tabla con conferencias (MLS)", () => {
    const filas = filasDe("mls-standings-total.json");
    const crudas = fixture("mls-standings-total.json").standings[0].rows as Json[];
    assert.deepEqual(filas.map((f) => f.grupo), crudas.map((r) => r.groupNum));
    assert.equal(filas.filter((f) => f.grupo === 1).length, 15);
    assert.equal(filas.filter((f) => f.grupo === 2).length, 15);
  });

  it("un cambio de grupo cuenta como filas distintas", () => {
    const filas = filasDe("mls-standings-total.json");
    const otroGrupo = filas.map((f, i) => (i === 0 ? { ...f, grupo: f.grupo === 1 ? 2 : 1 } : f));
    assert.ok(!filasIguales(filas, otroGrupo));
  });

  it("ignora el orden de filas y de claves (jsonb) pero detecta un cambio en un campo", () => {
    const filas = filasDe("premier-standings-total.json");
    const desordenadas = [...filas].reverse().map((f) => Object.fromEntries(Object.entries(f).reverse())) as typeof filas;
    assert.ok(filasIguales(filas, desordenadas));
    const cambiada = filas.map((f, i) => (i === 5 ? { ...f, gf: f.gf + 1 } : f));
    assert.ok(!filasIguales(filas, cambiada));
    assert.ok(!filasIguales(filas, filas.slice(1)));
  });
});

describe("describirCambios: que cambio en una foto nueva (para el log)", () => {
  const filas = filasDe("premier-standings-total.json");

  it("primera foto de la clave", () => {
    assert.equal(describirCambios({ rows: filas, vigente_al_capturar: true }), "primera foto (20 equipos)");
  });

  it("cuenta equipos y lista los campos que cambiaron, sin importar el orden de las filas", () => {
    const nuevas = filas.map((f, i) => {
      if (i === 0) return { ...f, partidos: f.partidos + 1, ganados: f.ganados + 1, gf: f.gf + 2, puntos: f.puntos + 3 };
      if (i === 1) return { ...f, partidos: f.partidos + 1, perdidos: f.perdidos + 1, gc: f.gc + 2 };
      return f;
    });
    assert.equal(
      describirCambios({ rows: nuevas, vigente_al_capturar: true }, { rows: [...filas].reverse(), vigente_al_capturar: true }),
      "2 equipos cambiaron (partidos, ganados, perdidos, gf, gc, puntos)",
    );
  });

  it("equipos que entran o salen y cambio de vigencia", () => {
    const otro = { ...filas[0], equipo_id: 1, nombre: "Nuevo" };
    assert.equal(
      describirCambios({ rows: [...filas.slice(1), otro], vigente_al_capturar: false }, { rows: filas, vigente_al_capturar: true }),
      "1 equipos entran; 1 equipos salen; vigente_al_capturar true -> false",
    );
  });
});

describe("equiposQueNoCuadran: local/visitante con los mismos equipos que la total", () => {
  const total = filasDe("premier-standings-total.json");
  const local = filasDe("premier-standings-local.json");
  const visitante = filasDe("premier-standings-visitante.json");

  it("mismos equipos: null", () => {
    assert.equal(equiposQueNoCuadran(total, local, visitante), null);
  });

  it("faltan equipos con partidos (como la 5062 77: 16 en la total, 14 en local/visitante)", () => {
    const fuera = new Set(total.slice(0, 2).map((f) => f.equipo_id));
    const sinDos = (filas: typeof total) => filas.filter((f) => !fuera.has(f.equipo_id));
    assert.equal(equiposQueNoCuadran(total, sinDos(local), sinDos(visitante)), "faltan 2, sobran 0");
  });

  it("un equipo que no esta en la total sobra", () => {
    const intruso = { ...local[0], equipo_id: 999_999 };
    assert.equal(equiposQueNoCuadran(total, [...local, intruso], visitante), "faltan 0, sobran 1");
  });

  it("un equipo que no aparece en la local pero tiene todos sus partidos en la visitante no falta", () => {
    const id = total[0].equipo_id;
    const sinLocal = local.filter((f) => f.equipo_id !== id);
    const todoVisitante = visitante.map((f) => (f.equipo_id === id ? { ...f, partidos: total[0].partidos } : f));
    assert.equal(equiposQueNoCuadran(total, sinLocal, todoVisitante), null);
  });
});

describe("upsertFotosStandings: merge sobre la clave unica, no sobre la PK id", () => {
  afterEach(() => { globalThis.fetch = fetchOriginal; });

  it("POST con ?on_conflict=competition_id,season_num,stage_num,type,fecha y Prefer resolution=merge-duplicates", async () => {
    const enviadas: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      enviadas.push({ url: String(input), init });
      return new Response(null, { status: 201 });
    }) as typeof globalThis.fetch;

    await upsertFotosStandings([{
      competition_id: PREMIER, season_num: 132, stage_num: 1, type: 1, fecha: "2026-10-27",
      rows: filasDe("premier-standings-total.json"), vigente_al_capturar: true, actualizado_en: "2026-10-27T02:00:00-05:00",
    }]);

    assert.equal(enviadas.length, 1);
    assert.equal(
      enviadas[0].url,
      "http://localhost:54321/rest/v1/standings_365?on_conflict=competition_id,season_num,stage_num,type,fecha",
    );
    assert.equal(enviadas[0].init?.method, "POST");
    const headers = enviadas[0].init?.headers as Record<string, string>;
    assert.match(headers.Prefer, /resolution=merge-duplicates/);
  });

  it("sin fotos no hace ninguna peticion", async () => {
    let llamadas = 0;
    globalThis.fetch = (async () => { llamadas++; return new Response(null, { status: 201 }); }) as typeof globalThis.fetch;
    await upsertFotosStandings([]);
    assert.equal(llamadas, 0);
  });
});

describe("sincronizarStandingsCompeticion: liga de una fase (Premier)", () => {
  afterEach(() => { globalThis.fetch = fetchOriginal; reiniciar(); });

  it("primera corrida: actual (vigente) y anterior (mapa) en los 3 types, reutilizando la tabla total de la consulta inicial", async () => {
    mockearFetch([PREMIER]);
    const resultado = await sincronizar(PREMIER);

    assert.deepEqual(resultado, { fotos_nuevas: 6, sin_cambios: 0, sin_tabla: 0, en_juego: 0, avisos: [], descartadas: [] });
    assert.deepEqual(clavesNuevas(), ["131/1/1", "131/1/2", "131/1/3", "132/1/1", "132/1/2", "132/1/3"]);
    // La actual va con su stageNum explicito; la anterior sin stageNum para la total, y local/visitante con la
    // fase que devolvio la total
    assert.deepEqual(peticiones365.map((p) => [p.seasonNum, p.stageNum, p.type]), [
      [undefined, undefined, 1],
      [132, 1, 2], [132, 1, 3],
      [131, undefined, 1], [131, 1, 2], [131, 1, 3],
    ]);
    assert.equal(pausas, 5, "Pausa entre cada llamada a 365 de la misma liga");

    const fotos = posts.flat();
    assert.ok(fotos.every((f) => f.fecha === hoyBogota() && f.competition_id === PREMIER));
    assert.ok(fotos.filter((f) => f.season_num === 132).every((f) => f.vigente_al_capturar));
    assert.ok(fotos.filter((f) => f.season_num === 131).every((f) => !f.vigente_al_capturar));
    assert.deepEqual(fotos.find((f) => f.season_num === 132 && f.type === 1)?.rows, filasDe("premier-standings-total.json"));
  });

  it("foto sin cambios no se inserta y la temporada anterior ya guardada no se vuelve a pedir", async () => {
    for (const [type, archivo] of Object.entries(PREMIER_ACTUAL)) {
      // Filas en otro orden: igual cuentan como sin cambios
      guardarFoto({ competition_id: PREMIER, season_num: 132, stage_num: 1, type: Number(type), fecha: AYER,
        rows: filasDe(archivo).reverse(), vigente_al_capturar: true });
    }
    for (const [type, archivo] of Object.entries(PREMIER_ANTERIOR)) {
      guardarFoto({ competition_id: PREMIER, season_num: 131, stage_num: 1, type: Number(type), fecha: AYER,
        rows: filasDe(archivo), vigente_al_capturar: false });
    }
    mockearFetch([PREMIER]);
    const resultado = await sincronizar(PREMIER);

    assert.deepEqual(resultado, { fotos_nuevas: 0, sin_cambios: 3, sin_tabla: 0, en_juego: 0, avisos: [], descartadas: [] });
    assert.equal(posts.length, 0, "Sin fotos nuevas no hay POST");
    assert.ok(!peticiones365.some((p) => p.seasonNum === 131), "La temporada anterior ya cerrada no se pide");
    assert.equal(peticiones365.length, 3);
  });

  it("solo inserta el type cuyas filas cambiaron", async () => {
    for (const [type, archivo] of Object.entries(PREMIER_ACTUAL)) {
      const filas = filasDe(archivo);
      if (type === "1") filas[0] = { ...filas[0], gf: 99 };
      guardarFoto({ competition_id: PREMIER, season_num: 132, stage_num: 1, type: Number(type), fecha: AYER,
        rows: filas, vigente_al_capturar: true });
    }
    for (const type of [1, 2, 3]) {
      guardarFoto({ competition_id: PREMIER, season_num: 131, stage_num: 1, type, fecha: AYER, rows: [], vigente_al_capturar: false });
    }
    mockearFetch([PREMIER]);
    const resultado = await sincronizar(PREMIER);

    assert.deepEqual(resultado, { fotos_nuevas: 1, sin_cambios: 2, sin_tabla: 0, en_juego: 0, avisos: [], descartadas: [] });
    assert.deepEqual(clavesNuevas(), ["132/1/1"]);
  });

  it("loguea una linea por foto nueva con que cambio", async () => {
    for (const [type, archivo] of Object.entries(PREMIER_ACTUAL)) {
      const filas = filasDe(archivo);
      if (type === "1") filas[0] = { ...filas[0], gf: 99 };
      guardarFoto({ competition_id: PREMIER, season_num: 132, stage_num: 1, type: Number(type), fecha: AYER,
        rows: filas, vigente_al_capturar: true });
    }
    mockearFetch([PREMIER]);
    const consola = capturarConsola();
    try {
      await sincronizarStandingsCompeticion(PREMIER, hoyBogota(), sinPausa);
    } finally {
      consola.restaurar();
    }

    const lineas = consola.log.filter((l) => l.includes("foto nueva"));
    assert.deepEqual(lineas.slice(0, 1), [
      "[standings] competition_id 7 seasonNum 132 stageNum 1 type 1 foto nueva: 1 equipos cambiaron (gf)",
    ]);
    assert.deepEqual(lineas.slice(1), [1, 2, 3].map((t) =>
      `[standings] competition_id 7 seasonNum 131 stageNum 1 type ${t} foto nueva: primera foto (20 equipos)`));
  });

  it("temporada cuya ultima foto quedo vigente se pide una vez mas para cerrarla, y despues ya no", async () => {
    // Fotos tomadas cuando 131 era la actual: mismas filas, pero vigente_al_capturar = true
    for (const [type, archivo] of Object.entries(PREMIER_ANTERIOR)) {
      guardarFoto({ competition_id: PREMIER, season_num: 131, stage_num: 1, type: Number(type), fecha: AYER,
        rows: filasDe(archivo), vigente_al_capturar: true });
    }
    mockearFetch([PREMIER]);
    const primera = await sincronizar(PREMIER);

    assert.equal(primera.fotos_nuevas, 6, "3 de la actual + 3 de cierre de la anterior");
    assert.deepEqual(
      posts.flat().filter((f) => f.season_num === 131).map((f) => f.vigente_al_capturar),
      [false, false, false],
    );

    mockearFetch([PREMIER]);
    const segunda = await sincronizar(PREMIER);
    assert.deepEqual(segunda, { fotos_nuevas: 0, sin_cambios: 3, sin_tabla: 0, en_juego: 0, avisos: [], descartadas: [] });
    assert.ok(!peticiones365.some((p) => p.seasonNum === 131));
  });

  it("sin partidos jugados (pretemporada) no escribe nada", async () => {
    const sinPartidos = (base: Json) => {
      const copia = structuredClone(base);
      for (const r of copia.standings[0].rows) Object.assign(r, { gamePlayed: 0, gamesWon: 0, gamesEven: 0, gamesLost: 0, for: 0, against: 0, points: 0 });
      return copia;
    };
    for (const type of [1, 2, 3]) {
      guardarFoto({ competition_id: PREMIER, season_num: 131, stage_num: 1, type, fecha: AYER, rows: [], vigente_al_capturar: false });
    }
    mockearFetch([PREMIER], { [PREMIER]: (p) => sinPartidos(responderPremier(p)) });
    const resultado = await sincronizar(PREMIER);

    assert.deepEqual(resultado, { fotos_nuevas: 0, sin_cambios: 3, sin_tabla: 0, en_juego: 0, avisos: [], descartadas: [] });
    assert.equal(posts.length, 0);
  });
});

describe("sincronizarStandingsCompeticion: temporada anterior por mapa o buscando hacia atras", () => {
  afterEach(() => { globalThis.fetch = fetchOriginal; reiniciar(); });

  /** Liga sin mapa: 131 vacia, 130 con filas */
  const responderSinMapa: Responder365 = (p) => {
    if (p.seasonNum === undefined || p.seasonNum === 132) return fixture(PREMIER_ACTUAL[p.type]);
    if (p.seasonNum === 130) return conTemporada(fixture(PREMIER_ANTERIOR[p.type]), { seasonNum: 130 });
    return SIN_DATOS;
  };

  it("con TEMPORADA_ANTERIOR pide directo esa temporada", async () => {
    mockearFetch([PREMIER]);
    await sincronizar(PREMIER);
    const temporadas = [...new Set(peticiones365.map((p) => p.seasonNum).filter((s) => s !== undefined))];
    assert.deepEqual(temporadas, [132, 131]);
  });

  it("sin mapa prueba seasonNum - 1, - 2… y se queda con la primera que tiene filas", async () => {
    mockearFetch([LIGA_SIN_MAPA], { [LIGA_SIN_MAPA]: responderSinMapa });
    const resultado = await sincronizar(LIGA_SIN_MAPA);

    assert.deepEqual(peticiones365.map((p) => [p.seasonNum, p.type]), [
      [undefined, 1],
      [131, 1], [130, 1],
      [132, 2], [132, 3],
      [130, 2], [130, 3],
    ], "La tabla total de 130 que encontro la busqueda se reutiliza");
    assert.equal(resultado.fotos_nuevas, 6);
    assert.deepEqual(clavesNuevas().filter((c) => c.startsWith("130/")), ["130/1/1", "130/1/2", "130/1/3"]);
  });

  it("sin mapa, si ya hay fotos de una temporada anterior no busca", async () => {
    for (const type of [1, 2, 3]) {
      guardarFoto({ competition_id: LIGA_SIN_MAPA, season_num: 130, stage_num: 1, type, fecha: AYER, rows: [], vigente_al_capturar: false });
    }
    mockearFetch([LIGA_SIN_MAPA], { [LIGA_SIN_MAPA]: responderSinMapa });
    await sincronizar(LIGA_SIN_MAPA);
    assert.ok(!peticiones365.some((p) => p.seasonNum === 131 || p.seasonNum === 130));
  });

  it("sin mapa y ninguna temporada sirve: no hay temporada anterior", async () => {
    mockearFetch([LIGA_SIN_MAPA], { [LIGA_SIN_MAPA]: (p) => (p.seasonNum === undefined || p.seasonNum === 132 ? responderPremier(p) : SIN_DATOS) });
    const resultado = await sincronizar(LIGA_SIN_MAPA);
    assert.deepEqual(peticiones365.filter((p) => p.seasonNum !== undefined && p.seasonNum < 132).map((p) => p.seasonNum), [131, 130, 129]);
    assert.deepEqual(resultado, { fotos_nuevas: 3, sin_cambios: 0, sin_tabla: 0, en_juego: 0, avisos: [], descartadas: [] });
  });
});

describe("sincronizarStandingsCompeticion: respuestas sin tabla (sin_tabla, no errores)", () => {
  afterEach(() => { globalThis.fetch = fetchOriginal; reiniciar(); });

  it("liga sin standings en la consulta inicial: sin_tabla 1, sin avisos ni mas llamadas", async () => {
    mockearFetch([LIGA_SIN_MAPA], { [LIGA_SIN_MAPA]: () => SIN_DATOS });
    const resultado = await sincronizar(LIGA_SIN_MAPA);
    assert.deepEqual(resultado, { fotos_nuevas: 0, sin_cambios: 0, sin_tabla: 1, en_juego: 0, avisos: [], descartadas: [] });
    assert.equal(peticiones365.length, 1);
  });

  it("competitions[0].hasStandings = false cuenta como sin tabla", async () => {
    const sinTabla = structuredClone(fixture(PREMIER_ACTUAL[1]));
    sinTabla.competitions[0].hasStandings = false;
    mockearFetch([LIGA_SIN_MAPA], { [LIGA_SIN_MAPA]: () => sinTabla });
    const resultado = await sincronizar(LIGA_SIN_MAPA);
    assert.deepEqual(resultado, { fotos_nuevas: 0, sin_cambios: 0, sin_tabla: 1, en_juego: 0, avisos: [], descartadas: [] });
  });

  it("tabla sin split local/visitante (Tabla Anual de la Primera B 2025): solo se guarda la total", async () => {
    // Sin filterTypes 365 ignora type=2/3 y devuelve la tabla total: guardarla como local/visitante seria falso
    const sinSplit = conTemporada(fixture(PREMIER_ANTERIOR[1]), { seasonNum: 130 });
    delete sinSplit.standings[0].filterTypes;
    mockearFetch([LIGA_SIN_MAPA], {
      [LIGA_SIN_MAPA]: (p) => (p.seasonNum === undefined || p.seasonNum === 132 ? responderPremier(p)
        : p.seasonNum === 130 ? sinSplit : SIN_DATOS),
    });
    const resultado = await sincronizar(LIGA_SIN_MAPA);

    assert.deepEqual(resultado, { fotos_nuevas: 4, sin_cambios: 0, sin_tabla: 2, en_juego: 0, avisos: [], descartadas: [] });
    assert.deepEqual(clavesNuevas().filter((c) => c.startsWith("130/")), ["130/1/1"]);
  });
});

describe("sincronizarStandingsCompeticion: liga con varias fases (Liga BetPlay)", () => {
  afterEach(() => { globalThis.fetch = fetchOriginal; reiniciar(); });

  it("guarda las fases regulares de FASES_REGULARES: Apertura cerrada y Clausura vigente, y las de 2025", async () => {
    mockearFetch([BETPLAY]);
    const resultado = await sincronizar(BETPLAY);

    assert.deepEqual(resultado.avisos, []);
    assert.deepEqual(clavesNuevas(), [
      "127/3/1", "127/3/2", "127/3/3", "127/6/1", "127/6/2", "127/6/3",
      "130/3/1", "130/3/2", "130/3/3", "130/7/1", "130/7/2", "130/7/3",
    ]);
    const fotos = posts.flat();
    assert.ok(fotos.filter((f) => f.season_num === 130 && f.stage_num === 7).every((f) => f.vigente_al_capturar));
    assert.ok(fotos.filter((f) => !(f.season_num === 130 && f.stage_num === 7)).every((f) => !f.vigente_al_capturar));
    assert.ok(!peticiones365.some((p) => p.stageNum === 2 || p.stageNum === 1), "Ni Reclasificacion ni Promedios");
    assert.ok(peticiones365.filter((p) => p.seasonNum !== undefined).every((p) => p.stageNum !== undefined));
  });

  it("si 365 devuelve otra fase que la pedida no guarda esa consulta y la reporta", async () => {
    // stageNum 6 "no existe": 365 devuelve la Apertura 2025 (stageNum 3) sin error
    mockearFetch([BETPLAY], {
      [BETPLAY]: (p) => (p.seasonNum === 127 && p.stageNum === 6 ? fixture("betplay-standings-2025-apertura.json") : responderBetplay(p)),
    });
    const resultado = await sincronizar(BETPLAY);

    assert.ok(!clavesNuevas().some((c) => c.startsWith("127/6/")));
    assert.equal(resultado.fotos_nuevas, 9);
    assert.deepEqual(resultado.avisos, [1, 2, 3].map((t) =>
      `365 devolvio seasonNum 127 stageNum 3 al pedir seasonNum 127 stageNum 6 type ${t}: no se guarda`));
    // Las fotos de 127/3 siguen siendo las de la Apertura pedida, no duplicadas
    assert.equal(clavesNuevas().filter((c) => c.startsWith("127/3/")).length, 3);
  });

  it("fase cerrada con foto no vigente no se vuelve a pedir; la vigente si", async () => {
    for (const [season, stage] of [[130, 3], [127, 3], [127, 6]]) {
      for (const type of [1, 2, 3]) {
        guardarFoto({ competition_id: BETPLAY, season_num: season, stage_num: stage, type, fecha: AYER, rows: [], vigente_al_capturar: false });
      }
    }
    mockearFetch([BETPLAY]);
    await sincronizar(BETPLAY);

    assert.deepEqual(peticiones365.map((p) => [p.seasonNum, p.stageNum, p.type]), [
      [undefined, undefined, 1], [130, 7, 2], [130, 7, 3],
    ]);
  });

  it("temporada actual fuera de FASES_REGULARES: guarda solo la fase actual y lo avisa", async () => {
    mockearFetch([BETPLAY], {
      [BETPLAY]: (p) => {
        if (p.seasonNum === undefined || (p.seasonNum === 133 && p.stageNum === 7)) {
          return conTemporada(fixture(BETPLAY_CLAUSURA[p.type]), { seasonNum: 133, actual: 133 });
        }
        return responderBetplay(p);
      },
    });
    const resultado = await sincronizar(BETPLAY);

    assert.deepEqual(resultado.avisos, [
      "temporada 133 no esta en FASES_REGULARES: se guarda solo la fase actual (stageNum 7)",
    ]);
    assert.deepEqual(clavesNuevas().filter((c) => c.startsWith("133/")), ["133/7/1", "133/7/2", "133/7/3"]);
  });
});

describe("sincronizarStandingsCompeticion: ligas con grupos o conferencias (MLS real)", () => {
  afterEach(() => { globalThis.fetch = fetchOriginal; reiniciar(); });

  /** Una fase, sin mapa, sin temporada anterior: solo se piden las 3 tablas de la temporada 32 */
  const MLS = 104;
  const MLS_ACTUAL: Record<number, string> = {
    1: "mls-standings-total.json",
    2: "mls-standings-local.json",
    3: "mls-standings-visitante.json",
  };
  const responderMls = (p: Peticion365): Json =>
    p.seasonNum === undefined || p.seasonNum === 32 ? fixture(MLS_ACTUAL[p.type]) : SIN_DATOS;

  it("conferencias Este y Oeste en la misma tabla y la total cierra: guarda los 30 equipos en los 3 types", async () => {
    const total = fixture(MLS_ACTUAL[1]).standings[0];
    assert.deepEqual([...new Set(total.rows.map((r: Json) => r.groupNum))], [1, 2]);

    mockearFetch([MLS], { [MLS]: responderMls });
    const resultado = await sincronizar(MLS);

    assert.deepEqual(resultado, { fotos_nuevas: 3, sin_cambios: 0, sin_tabla: 0, en_juego: 0, avisos: [], descartadas: [] });
    assert.deepEqual(clavesNuevas(), ["32/1/1", "32/1/2", "32/1/3"]);
    for (const foto of posts.flat()) assert.equal(foto.rows.length, 30);
    // posicion es dentro de la conferencia: hay dos primeros
    const tablaTotal = posts.flat().find((f) => f.type === 1)!;
    assert.equal(tablaTotal.rows.filter((f) => f.posicion === 1).length, 2);
  });

  it("falta una conferencia en la total (media liga): sin_tabla con aviso y no guarda nada", async () => {
    const soloEste = (base: Json) => {
      const copia = structuredClone(base);
      if (!copia.standings) return copia; // busqueda de la temporada anterior
      copia.standings[0].rows = copia.standings[0].rows.filter((r: Json) => r.groupNum === 1);
      return copia;
    };
    mockearFetch([MLS], { [MLS]: (p) => (p.type === 1 ? soloEste(responderMls(p)) : responderMls(p)) });
    const resultado = await sincronizar(MLS);

    assert.equal(posts.length, 0);
    assert.deepEqual(resultado.avisos, [], "No va a errores");
    assert.equal(resultado.sin_tabla, 3);
    assert.deepEqual(resultado.descartadas, [
      "tabla por grupos incompleta (goles a favor/en contra o ganados/perdidos no cuadran) en seasonNum 32 stageNum 1 type 1: no se guarda",
      "tabla por grupos sin tabla total verificada en seasonNum 32 stageNum 1 type 2: no se guarda",
      "tabla por grupos sin tabla total verificada en seasonNum 32 stageNum 1 type 3: no se guarda",
    ]);
  });

  it("local con un equipo que no esta en la total: no guarda la local ni (por ir juntas) la visitante", async () => {
    const conIntruso = (base: Json) => {
      const copia = structuredClone(base);
      copia.standings[0].rows[0].competitor.id = 999_999;
      return copia;
    };
    mockearFetch([MLS], { [MLS]: (p) => (p.type === 2 ? conIntruso(responderMls(p)) : responderMls(p)) });
    const resultado = await sincronizar(MLS);

    assert.deepEqual(clavesNuevas(), ["32/1/1"]);
    assert.equal(resultado.sin_tabla, 2);
    assert.deepEqual(resultado.descartadas, [
      "tabla por grupos con equipos que no estan en la total en seasonNum 32 stageNum 1 type 2: no se guarda",
      "local y visitante van juntas: falta la local en seasonNum 32 stageNum 1: no se guarda la visitante",
    ]);
  });

  it("365 devuelve varias tablas separadas: la liga cuenta como sin_tabla con aviso", async () => {
    const separadas = (base: Json) => {
      const copia = structuredClone(base);
      copia.standings = [copia.standings[0], structuredClone(copia.standings[0])];
      return copia;
    };
    mockearFetch([MLS], { [MLS]: (p) => separadas(responderMls(p)) });
    const resultado = await sincronizar(MLS);

    assert.deepEqual(resultado, {
      fotos_nuevas: 0, sin_cambios: 0, sin_tabla: 1, en_juego: 0, avisos: [],
      descartadas: ["365 devolvio 2 tablas separadas para la fase actual: no se guarda"],
    });
    assert.equal(peticiones365.length, 1);
  });

  it("equipos repetidos en una tabla sin grupos tampoco se guardan", async () => {
    const repetida = (base: Json) => {
      const copia = structuredClone(base);
      copia.standings[0].rows.push(copia.standings[0].rows[0]);
      return copia;
    };
    for (const type of [1, 2, 3]) {
      guardarFoto({ competition_id: PREMIER, season_num: 131, stage_num: 1, type, fecha: AYER, rows: [], vigente_al_capturar: false });
    }
    mockearFetch([PREMIER], { [PREMIER]: (p) => (p.type === 1 ? repetida(responderPremier(p)) : responderPremier(p)) });
    const resultado = await sincronizar(PREMIER);

    assert.deepEqual(clavesNuevas(), ["132/1/2", "132/1/3"]);
    assert.deepEqual(resultado.descartadas, ["equipos repetidos en seasonNum 132 stageNum 1 type 1: no se guarda"]);
  });

  it("en sincronizarTodasStandings el aviso va al log (console.warn) y no a errores", async () => {
    mockearFetch([MLS], { [MLS]: (p) => (p.type === 1 ? { ...responderMls(p), standings: [] } : responderMls(p)) });
    const sinTablaInicial = await (async () => {
      const consola = capturarConsola();
      try { return await sincronizarTodasStandings(sinPausa); } finally { consola.restaurar(); }
    })();
    assert.equal(sinTablaInicial.sin_tabla, 1);
    assert.deepEqual(sinTablaInicial.errores, []);

    const separadas = (base: Json) => ({ ...base, standings: [base.standings[0], base.standings[0]] });
    mockearFetch([MLS], { [MLS]: (p) => separadas(responderMls(p)) });
    const consola = capturarConsola();
    let resultado;
    try {
      resultado = await sincronizarTodasStandings(sinPausa);
    } finally {
      consola.restaurar();
    }
    assert.equal(resultado.sin_tabla, 1);
    assert.deepEqual(resultado.errores, []);
    assert.deepEqual(consola.warn, [
      "[standings] competition_id 104 sin tabla: 365 devolvio 2 tablas separadas para la fase actual: no se guarda",
    ]);
  });
});

describe("sincronizarStandingsCompeticion: partidos en vivo y retraso de 365", () => {
  afterEach(() => { globalThis.fetch = fetchOriginal; reiniciar(); });

  /** Como la 620 a las 6:55 p. m.: las dos filas del partido en juego traen liveGameId en la total */
  const conPartidoEnVivo = (base: Json) => {
    const copia = structuredClone(base);
    if (!copia.standings) return copia;
    copia.standings[0].rows[0].liveGameId = 4731946;
    copia.standings[0].rows[1].liveGameId = 4731946;
    return copia;
  };

  async function sincronizarConConsola(competitionId: number) {
    const consola = capturarConsola();
    try {
      return { resultado: await sincronizarStandingsCompeticion(competitionId, hoyBogota(), sinPausa), consola };
    } finally {
      consola.restaurar();
    }
  }

  it("fase vigente con partido en vivo: no escribe ninguna de sus 3 tablas ni pide local/visitante; la anterior si", async () => {
    mockearFetch([PREMIER], {
      [PREMIER]: (p) => (p.type === 1 && (p.seasonNum ?? 132) === 132 ? conPartidoEnVivo(responderPremier(p)) : responderPremier(p)),
    });
    const { resultado, consola } = await sincronizarConConsola(PREMIER);

    assert.deepEqual(resultado, { fotos_nuevas: 3, sin_cambios: 0, sin_tabla: 0, en_juego: 1, avisos: [], descartadas: [] });
    assert.deepEqual(clavesNuevas(), ["131/1/1", "131/1/2", "131/1/3"]);
    assert.ok(!peticiones365.some((p) => p.seasonNum === 132), "No pide local/visitante de la fase en juego");
    assert.ok(consola.log.includes(
      "[standings] competition_id 7 seasonNum 132 stageNum 1 en juego: 1 partidos en vivo, no se escribe la fase vigente",
    ), consola.log.join("\n"));
  });

  it("liga con varias fases: solo se salta la vigente; la Apertura cerrada y 2025 se guardan", async () => {
    mockearFetch([BETPLAY], {
      [BETPLAY]: (p) => (p.seasonNum === undefined ? conPartidoEnVivo(responderBetplay(p)) : responderBetplay(p)),
    });
    const { resultado } = await sincronizarConConsola(BETPLAY);

    assert.equal(resultado.en_juego, 1);
    assert.ok(!clavesNuevas().some((c) => c.startsWith("130/7/")));
    assert.equal(clavesNuevas().filter((c) => c.startsWith("130/3/")).length, 3);
    assert.equal(clavesNuevas().filter((c) => c.startsWith("127/")).length, 6);
  });

  it("total distinta de local + visitante (365 aun no actualiza): guarda igual y avisa con los dos numeros", async () => {
    const conRetraso = (base: Json) => {
      const copia = structuredClone(base);
      copia.standings[0].rows[0].gamePlayed += 1;
      return copia;
    };
    mockearFetch([PREMIER], {
      [PREMIER]: (p) => (p.type === 2 && (p.seasonNum ?? 132) === 132 ? conRetraso(responderPremier(p)) : responderPremier(p)),
    });
    const { resultado, consola } = await sincronizarConConsola(PREMIER);

    assert.equal(resultado.fotos_nuevas, 6);
    assert.equal(resultado.en_juego, 0);
    assert.deepEqual(consola.warn, [
      "[standings] competition_id 7 seasonNum 132 stageNum 1 no cuadra: total 160 partidos, local + visitante 161 (se guarda igual)",
    ]);
  });

  it("sin retraso no avisa", async () => {
    mockearFetch([PREMIER]);
    const { consola } = await sincronizarConConsola(PREMIER);
    assert.deepEqual(consola.warn, []);
  });

  /** Cambia los partidos de cada fila de la local/visitante de la Premier 2026/27 */
  const conPartidosLocalVisitante = (partidos: (gp: number) => number): Responder365 => (p) => {
    const base = responderPremier(p);
    if (p.type === 1 || (p.seasonNum ?? 132) !== 132) return base;
    const copia = structuredClone(base);
    for (const r of copia.standings[0].rows) r.gamePlayed = partidos(r.gamePlayed);
    return copia;
  };

  it("mas de una jornada de diferencia (como la Liga Pro 5062): guarda la total y no la local ni la visitante", async () => {
    // Total 160; local y visitante con 1 partido por equipo: 40 en total (60 partidos de diferencia > 10 = una jornada)
    mockearFetch([PREMIER], { [PREMIER]: conPartidosLocalVisitante(() => 1) });
    const { resultado, consola } = await sincronizarConConsola(PREMIER);

    assert.deepEqual(clavesNuevas(), ["131/1/1", "131/1/2", "131/1/3", "132/1/1"]);
    assert.equal(resultado.sin_tabla, 2);
    assert.deepEqual(resultado.avisos, [], "No va a errores");
    assert.deepEqual(resultado.descartadas, [
      "local y visitante no cuadran con la total (total 160 partidos, local + visitante 40, mas de una jornada) " +
        "en seasonNum 132 stageNum 1: no se guardan",
    ]);
    assert.deepEqual(consola.warn, []);
  });

  it("justo una jornada de diferencia (equipos / 2 partidos): se guarda igual con el aviso", async () => {
    // Local con un partido menos por equipo: 140 = 20 de diferencia = 10 partidos = una jornada de 20 equipos
    mockearFetch([PREMIER], {
      [PREMIER]: (p) => (p.type === 2 ? conPartidosLocalVisitante((gp) => gp - 1)(p) : responderPremier(p)),
    });
    const { resultado, consola } = await sincronizarConConsola(PREMIER);

    assert.equal(resultado.fotos_nuevas, 6);
    assert.equal(resultado.sin_tabla, 0);
    assert.deepEqual(consola.warn, [
      "[standings] competition_id 7 seasonNum 132 stageNum 1 no cuadra: total 160 partidos, local + visitante 140 (se guarda igual)",
    ]);
  });

  it("liga de una fase sin mapa: local/visitante de la actual se piden con stageNum (como la 119, que sin el no devuelve nada)", async () => {
    mockearFetch([LIGA_SIN_MAPA], {
      [LIGA_SIN_MAPA]: (p) => (p.seasonNum === 132 && p.stageNum === undefined ? SIN_DATOS : responderPremier(p)),
    });
    const { resultado } = await sincronizarConConsola(LIGA_SIN_MAPA);

    assert.deepEqual(clavesNuevas().filter((c) => c.startsWith("132/")), ["132/1/1", "132/1/2", "132/1/3"]);
    assert.equal(resultado.sin_tabla, 0);
    assert.deepEqual(peticiones365.filter((p) => p.seasonNum === 132).map((p) => [p.stageNum, p.type]), [[1, 2], [1, 3]]);
  });

  it("temporada anterior sin stageNum: local/visitante se piden con la fase que devolvio la total", async () => {
    // Sin stageNum, 365 devuelve para local/visitante otra fase (el Repechaje de la 5653, sin partidos)
    const otraFase = (base: Json) => conTemporada(base, { stageNum: 6 });
    mockearFetch([LIGA_SIN_MAPA], {
      [LIGA_SIN_MAPA]: (p) => {
        if (p.seasonNum === 131) {
          const tabla = responderPremier(p);
          return p.type !== 1 && p.stageNum === undefined ? otraFase(tabla) : tabla;
        }
        return responderPremier(p);
      },
    });
    const { resultado } = await sincronizarConConsola(LIGA_SIN_MAPA);

    assert.deepEqual(peticiones365.filter((p) => p.seasonNum === 131).map((p) => [p.stageNum, p.type]), [
      [undefined, 1], [1, 2], [1, 3],
    ]);
    assert.deepEqual(clavesNuevas().filter((c) => c.startsWith("131/")), ["131/1/1", "131/1/2", "131/1/3"]);
    assert.equal(resultado.fotos_nuevas, 6);
  });

  /** Como la 64: currentStageNum 3 (Cuartos, sin tabla); sin parametros 365 devuelve la fase 1 */
  const conFaseActualSinTabla = (base: Json) => {
    const copia = structuredClone(base);
    if (copia.competitions) copia.competitions[0].currentStageNum = 3;
    return copia;
  };

  it("fase actual = la de la tabla que devuelve 365 sin parametros, no currentStageNum", async () => {
    mockearFetch([LIGA_SIN_MAPA], {
      [LIGA_SIN_MAPA]: (p) => {
        if (p.seasonNum === 132 && p.stageNum === 3) return conTemporada(fixture(PREMIER_ACTUAL[1]), { stageNum: 1 });
        return p.seasonNum === undefined ? conFaseActualSinTabla(responderPremier(p)) : responderPremier(p);
      },
    });
    const { resultado } = await sincronizarConConsola(LIGA_SIN_MAPA);

    assert.deepEqual(resultado.avisos, []);
    assert.deepEqual(peticiones365.filter((p) => p.seasonNum === 132).map((p) => [p.stageNum, p.type]), [[1, 2], [1, 3]]);
    assert.deepEqual(clavesNuevas().filter((c) => c.startsWith("132/")), ["132/1/1", "132/1/2", "132/1/3"]);
    assert.ok(posts.flat().filter((f) => f.season_num === 132).every((f) => f.vigente_al_capturar));
  });

  it("si la local de la fase vigente vuelve de otra fase: sin_tabla (no errores) y la visitante tampoco se guarda", async () => {
    mockearFetch([PREMIER], {
      [PREMIER]: (p) => (p.type === 2 && p.seasonNum === 132 ? conTemporada(responderPremier(p), { stageNum: 2 }) : responderPremier(p)),
    });
    const { resultado } = await sincronizarConConsola(PREMIER);

    assert.deepEqual(resultado.avisos, [], "No va a errores");
    assert.equal(resultado.sin_tabla, 2);
    assert.deepEqual(clavesNuevas().filter((c) => c.startsWith("132/")), ["132/1/1"]);
    assert.deepEqual(resultado.descartadas, [
      "365 devolvio seasonNum 132 stageNum 2 al pedir seasonNum 132 stageNum 1 type 2: no se guarda",
      "local y visitante van juntas: falta la local en seasonNum 132 stageNum 1: no se guarda la visitante",
    ]);
  });

  it("local y visitante juntas o ninguna: visitante sin split (como la 634 90/6) → tampoco la local", async () => {
    const sinVisitante = (base: Json) => {
      const copia = structuredClone(base);
      copia.standings[0].filterTypes = [{ type: 1 }, { type: 2 }];
      return copia;
    };
    mockearFetch([PREMIER], {
      [PREMIER]: (p) => (p.type === 3 && p.seasonNum === 132 ? sinVisitante(responderPremier(p)) : responderPremier(p)),
    });
    const { resultado } = await sincronizarConConsola(PREMIER);

    assert.deepEqual(clavesNuevas().filter((c) => c.startsWith("132/")), ["132/1/1"]);
    assert.equal(resultado.sin_tabla, 2);
    assert.deepEqual(resultado.descartadas, [
      "local y visitante van juntas: falta la visitante en seasonNum 132 stageNum 1: no se guarda la local",
    ]);
  });

  it("local sin partidos y visitante con partidos (la 634 90/6 real): no se guarda ninguna de las dos", async () => {
    mockearFetch([PREMIER], {
      [PREMIER]: (p) => (p.type === 2 && p.seasonNum === 132 ? conPartidosLocalVisitante(() => 0)(p) : responderPremier(p)),
    });
    const { resultado } = await sincronizarConConsola(PREMIER);

    assert.deepEqual(clavesNuevas().filter((c) => c.startsWith("132/")), ["132/1/1"]);
    assert.ok(resultado.descartadas.includes(
      "local y visitante van juntas: no tiene partidos la local en seasonNum 132 stageNum 1: no se guarda la visitante",
    ), resultado.descartadas.join("\n"));
  });

  it("local/visitante sin un equipo: no se guardan aunque la diferencia sea de menos de una jornada", async () => {
    // Sin Man City (8 partidos): 152 contra 160 = 4 partidos, menos de una jornada (10), pero falta un equipo entero
    const sinManCity = (base: Json) => {
      const copia = structuredClone(base);
      copia.standings[0].rows = copia.standings[0].rows.filter((r: Json) => r.competitor.id !== 110);
      return copia;
    };
    mockearFetch([PREMIER], {
      [PREMIER]: (p) => (p.type !== 1 && p.seasonNum === 132 ? sinManCity(responderPremier(p)) : responderPremier(p)),
    });
    const { resultado, consola } = await sincronizarConConsola(PREMIER);

    assert.deepEqual(clavesNuevas().filter((c) => c.startsWith("132/")), ["132/1/1"]);
    assert.equal(resultado.sin_tabla, 2);
    assert.deepEqual(resultado.descartadas, [
      "local y visitante no tienen los mismos equipos que la total (faltan 1, sobran 0) en seasonNum 132 stageNum 1: no se guardan",
    ]);
    assert.deepEqual(consola.warn, [], "No es el aviso de retraso");
  });

  it("sincronizarTodasStandings suma en_juego y lo muestra en el log de Fin", async () => {
    mockearFetch([PREMIER, BETPLAY], {
      ...RESPONDERES,
      [PREMIER]: (p) => (p.type === 1 && (p.seasonNum ?? 132) === 132 ? conPartidoEnVivo(responderPremier(p)) : responderPremier(p)),
    });
    const consola = capturarConsola();
    let resultado;
    try {
      resultado = await sincronizarTodasStandings(sinPausa);
    } finally {
      consola.restaurar();
    }
    assert.equal(resultado.en_juego, 1);
    assert.deepEqual(resultado.errores, []);
    assert.match(consola.log.at(-1)!, / 1 en juego, 0 errores en /);
  });
});

describe("sincronizarTodasStandings: dos corridas seguidas con los mismos datos de 365", () => {
  afterEach(() => { globalThis.fetch = fetchOriginal; reiniciar(); });

  it("la segunda escribe 0 fotos y no vuelve a pedir las fases cerradas, aunque su local/visitante se hayan descartado", async () => {
    // Liga sin mapa cuya temporada anterior tiene local/visitante sin 2 equipos (como la 5062 77)
    const sinDosEquipos = (base: Json) => {
      const copia = structuredClone(base);
      copia.standings[0].rows = copia.standings[0].rows.slice(2);
      return copia;
    };
    const responderes = {
      ...RESPONDERES,
      [LIGA_SIN_MAPA]: (p: Peticion365) =>
        p.seasonNum === 131 && p.type !== 1 ? sinDosEquipos(responderPremier(p)) : responderPremier(p),
    };
    const correr = async () => {
      mockearFetch([PREMIER, BETPLAY, LIGA_SIN_MAPA], responderes);
      const consola = capturarConsola();
      try {
        return await sincronizarTodasStandings(sinPausa);
      } finally {
        consola.restaurar();
      }
    };

    const primera = await correr();
    assert.equal(primera.fotos_nuevas, 6 + 12 + 4);
    assert.equal(primera.sin_tabla, 2, "local y visitante 131 de la liga sin mapa");
    assert.deepEqual(primera.errores, []);

    const segunda = await correr();
    assert.equal(segunda.fotos_nuevas, 0);
    assert.equal(segunda.sin_tabla, 0);
    assert.equal(segunda.sin_cambios, 3 + 3 + 3, "Solo la fase vigente de cada liga");
    assert.deepEqual(segunda.errores, []);
    assert.ok(
      !peticiones365.some((p) => p.seasonNum === 131 || p.seasonNum === 127 || (p.seasonNum === 130 && p.stageNum === 3)),
      "Las fases cerradas no se vuelven a pedir",
    );
  });
});

describe("sincronizarTodasStandings: una liga que falla no tumba el resto", () => {
  afterEach(() => { globalThis.fetch = fetchOriginal; reiniciar(); });

  it("sigue con las demas, suma fotos y reporta el fallo y los avisos con su competition_id", async () => {
    mockearFetch([LIGA_404, PREMIER, BETPLAY], {
      ...RESPONDERES,
      [BETPLAY]: (p) => (p.seasonNum === 127 && p.stageNum === 6 ? fixture("betplay-standings-2025-apertura.json") : responderBetplay(p)),
    });
    const consola = capturarConsola();
    let resultado;
    try {
      resultado = await sincronizarTodasStandings(sinPausa);
    } finally {
      consola.restaurar();
    }

    assert.equal(resultado.ligas, 3);
    assert.equal(resultado.fotos_nuevas, 6 + 9);
    assert.equal(resultado.sin_cambios, 0);
    assert.equal(resultado.sin_tabla, 0);
    assert.equal(typeof resultado.duracion_s, "number");
    assert.deepEqual(resultado.errores.map((e) => e.competition_id), [LIGA_404, BETPLAY, BETPLAY, BETPLAY]);
    assert.match(resultado.errores[0].motivo, /365Scores 404/);

    assert.equal(consola.error.length, 1);
    assert.ok(consola.error[0].includes(`competition_id ${LIGA_404} fallo`), consola.error[0]);
    assert.equal(consola.warn.length, 3);
    assert.match(
      consola.log[0],
      /^\[standings\] Inicio: 3 de 3 ligas activas con partidos \(-2\/\+7 dias\) en 2 lotes \(fecha \d{4}-\d{2}-\d{2}\)$/,
    );
    assert.match(
      consola.log.at(-1)!,
      /^\[standings\] Fin: 3 ligas, 15 fotos nuevas, 0 sin cambios, 0 sin tabla, 0 en juego, 4 errores en \d+\.\d s$/,
    );
  });

  it("una liga sin tabla va a sin_tabla y no a errores", async () => {
    mockearFetch([LIGA_SIN_MAPA, PREMIER], { ...RESPONDERES, [LIGA_SIN_MAPA]: () => SIN_DATOS });
    const consola = capturarConsola();
    let resultado;
    try {
      resultado = await sincronizarTodasStandings(sinPausa);
    } finally {
      consola.restaurar();
    }
    assert.equal(resultado.sin_tabla, 1);
    assert.deepEqual(resultado.errores, []);
    assert.equal(resultado.fotos_nuevas, 6);
  });

  it("loguea el progreso cada 10 lotes, no en cada uno", async () => {
    // 21 ligas, 2 por lote → 11 lotes: solo el 10 deja linea de progreso
    const ligas = Array.from({ length: 21 }, (_, i) => 9001 + i);
    mockearFetch(ligas, Object.fromEntries(ligas.map((id) => [id, () => SIN_DATOS])));
    const consola = capturarConsola();
    try {
      await sincronizarTodasStandings(sinPausa);
    } finally {
      consola.restaurar();
    }
    const lotes = consola.log.filter((l) => l.includes("Lote"));
    assert.deepEqual(lotes, ["[standings] Lote 10/11 terminado (20/21 ligas)"]);
  });
});

describe("sincronizarTodasStandings: solo ligas con partidos en la ventana de dias", () => {
  afterEach(() => { globalThis.fetch = fetchOriginal; reiniciar(); });

  it("salta las activas sin partidos entre -DIAS_STANDINGS_ATRAS y +DIAS_STANDINGS e ignora ids no activos", async () => {
    // BETPLAY activa sin partidos; 999 con partidos pero sin equivalencia activa
    mockearFetch([PREMIER, BETPLAY], RESPONDERES, [999, PREMIER]);
    const consola = capturarConsola();
    let resultado;
    try {
      resultado = await sincronizarTodasStandings(sinPausa);
    } finally {
      consola.restaurar();
    }

    assert.equal(resultado.ligas, 1);
    assert.deepEqual([...new Set(peticiones365.map((p) => p.competitionId))], [PREMIER]);
    assert.match(consola.log[0], /Inicio: 1 de 2 ligas activas con partidos/);

    // Pagina hasta una pagina vacia; ventana de ~2 dias atras a ~7 adelante
    assert.equal(filtrosPartidos.length, 2);
    const [, desde, hasta] = filtrosPartidos[0].match(/^\(fecha_hora\.gte\.(.+),fecha_hora\.lte\.(.+)\)$/)!;
    const dias = (iso: string) => (Date.parse(iso) - Date.now()) / 86_400_000;
    assert.ok(Math.abs(dias(desde) + 2) < 0.01, desde);
    assert.ok(Math.abs(dias(hasta) - 7) < 0.01, hasta);
  });
});

describe("POST /api/sync-standings", () => {
  let app: FastifyInstance;
  before(async () => { app = crearServidor(); await app.ready(); });
  after(() => app.close());
  afterEach(() => { globalThis.fetch = fetchOriginal; reiniciar(); });

  it("401 sin el SYNC_TOKEN", async () => {
    const sinToken = await app.inject({ method: "POST", url: "/api/sync-standings" });
    assert.equal(sinToken.statusCode, 401);
    const otroToken = await app.inject({ method: "POST", url: "/api/sync-standings", headers: { authorization: "Bearer otro" } });
    assert.equal(otroToken.statusCode, 401);
    assert.equal(JSON.parse(otroToken.body).error.codigo, "NO_AUTORIZADO");
  });

  it("200 con { ligas, fotos_nuevas, sin_cambios, sin_tabla, errores, duracion_s } aunque la liga falle", async () => {
    mockearFetch([LIGA_404]);
    const consola = capturarConsola();
    let resp;
    try {
      resp = await app.inject({ method: "POST", url: "/api/sync-standings", headers: { authorization: "Bearer test-sync-token" } });
    } finally {
      consola.restaurar();
    }
    assert.equal(resp.statusCode, 200);
    const body = JSON.parse(resp.body);
    assert.deepEqual(
      Object.keys(body).sort(),
      ["duracion_s", "en_juego", "errores", "fotos_nuevas", "ligas", "sin_cambios", "sin_tabla"],
    );
    assert.equal(typeof body.duracion_s, "number");
    assert.deepEqual(
      { ...body, errores: body.errores.length, duracion_s: undefined },
      { ligas: 1, fotos_nuevas: 0, sin_cambios: 0, sin_tabla: 0, en_juego: 0, errores: 1, duracion_s: undefined },
    );
    assert.equal(body.errores[0].competition_id, LIGA_404);
  });

  it("409 SYNC_EN_CURSO si otra corrida sigue en curso; al terminar se puede volver a llamar", { timeout: 5_000 }, async () => {
    mockearFetch([LIGA_404]);
    const fetchMock = globalThis.fetch;
    let soltar!: () => void;
    const bloqueo = new Promise<void>((r) => { soltar = r; });
    let avisarInicio!: () => void;
    const empezo = new Promise<void>((r) => { avisarInicio = r; });
    // La primera corrida queda parada en su primera llamada (equivalencias) hasta soltar
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      avisarInicio();
      await bloqueo;
      return fetchMock(...args);
    }) as typeof globalThis.fetch;

    const peticion = { method: "POST" as const, url: "/api/sync-standings", headers: { authorization: "Bearer test-sync-token" } };
    const consola = capturarConsola();
    try {
      // inject es perezoso: .then() lo dispara
      const primera = app.inject(peticion).then((r) => r);
      await empezo;

      const segunda = await app.inject(peticion);
      assert.equal(segunda.statusCode, 409);
      assert.equal(JSON.parse(segunda.body).error.codigo, "SYNC_EN_CURSO");

      soltar();
      assert.equal((await primera).statusCode, 200);

      globalThis.fetch = fetchMock;
      assert.equal((await app.inject(peticion)).statusCode, 200);
    } finally {
      soltar();
      consola.restaurar();
    }
  });
});
