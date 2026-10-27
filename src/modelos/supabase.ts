/** Acceso a Supabase via PostgREST (sin SDK) */

import {
  TIMEOUT_API_MS,
  TABLA_EQUIVALENCIAS,
  TABLA_PARTIDOS,
  TABLA_EQUIPOS,
  TABLA_STANDINGS,
  FILAS_POR_PAGINA_SUPABASE,
} from "../config.js";
import type {
  EquivalenciaLigaDB,
  PartidoProgramadoDB,
  Equipo365DB,
  FotoStandingDB,
  MetaFotoStandingDB,
} from "./tipos.js";

export class ErrorSupabase extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrorSupabase";
  }
}

function obtenerCredenciales(): { base: string; llave: string } {
  const base = (process.env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const llave = (process.env.SUPABASE_KEY ?? "").trim();
  if (!base || !llave) throw new ErrorSupabase("Faltan SUPABASE_URL o SUPABASE_KEY");
  return { base, llave };
}

function encabezados(llave: string, extras: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: llave,
    Authorization: `Bearer ${llave}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    Prefer: "return=minimal",
    ...extras,
  };
}

async function peticionSupabase(
  url: string,
  llave: string,
  opciones: RequestInit = {},
): Promise<Response> {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_API_MS);

  try {
    const resp = await fetch(url, {
      ...opciones,
      headers: { ...encabezados(llave), ...(opciones.headers as Record<string, string> ?? {}) },
      signal: controlador.signal,
    });
    return resp;
  } catch (error) {
    throw new ErrorSupabase(`Supabase: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(temporizador);
  }
}

// --- Equivalencias de liga ---

async function obtenerLigasActivas(): Promise<EquivalenciaLigaDB[]> {
  const { base, llave } = obtenerCredenciales();
  const params = new URLSearchParams({
    select: "*",
    activa: "eq.true",
  });
  const resp = await peticionSupabase(`${base}/rest/v1/${TABLA_EQUIVALENCIAS}?${params}`, llave, {
    method: "GET",
  });
  if (!resp.ok) throw new ErrorSupabase(`Supabase equivalencias: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as EquivalenciaLigaDB[];
}

/** competition_id_365 distintas con equivalencia activa (las que sincronizan /api/sync y /api/sync-standings) */
export async function obtenerCompetitionIdsActivas(): Promise<number[]> {
  const equivalencias = await obtenerLigasActivas();
  return [...new Set(equivalencias.map((e) => e.competition_id_365))];
}

export async function obtenerEquivalencia(casa: string, ligaCasaId: string): Promise<EquivalenciaLigaDB | null> {
  const { base, llave } = obtenerCredenciales();
  const params = new URLSearchParams({
    select: "*",
    casa: `eq.${casa}`,
    liga_casa_id: `eq.${ligaCasaId}`,
    limit: "1",
  });
  const resp = await peticionSupabase(`${base}/rest/v1/${TABLA_EQUIVALENCIAS}?${params}`, llave, {
    method: "GET",
  });
  if (!resp.ok) throw new ErrorSupabase(`Supabase equivalencia: ${resp.status} ${await resp.text()}`);
  const filas = (await resp.json()) as EquivalenciaLigaDB[];
  return filas.length > 0 ? filas[0] : null;
}

export type FilaEquivalenciaCasa = Pick<EquivalenciaLigaDB, "liga_casa_id" | "competition_id_365" | "activa">;

/**
 * Todas las equivalencias de una casa, activas o no (el filtro de activa lo aplica la vista-modelo).
 * Pagina hasta recibir una pagina vacia, asi no se corta en el max-rows de PostgREST
 * aunque el servidor lo tenga configurado por debajo de FILAS_POR_PAGINA_SUPABASE.
 */
export async function obtenerEquivalenciasPorCasa(casa: string): Promise<FilaEquivalenciaCasa[]> {
  const { base, llave } = obtenerCredenciales();
  const filas: FilaEquivalenciaCasa[] = [];
  for (;;) {
    const params = new URLSearchParams({
      select: "liga_casa_id,competition_id_365,activa",
      casa: `eq.${casa}`,
      order: "id.asc",
      limit: String(FILAS_POR_PAGINA_SUPABASE),
      offset: String(filas.length),
    });
    const resp = await peticionSupabase(`${base}/rest/v1/${TABLA_EQUIVALENCIAS}?${params}`, llave, {
      method: "GET",
    });
    if (!resp.ok) throw new ErrorSupabase(`Supabase equivalencias por casa: ${resp.status} ${await resp.text()}`);
    const pagina = (await resp.json()) as FilaEquivalenciaCasa[];
    if (pagina.length === 0) return filas;
    filas.push(...pagina);
  }
}

export async function actualizarSincronizacionPorCompetition(competitionId: number, fecha: string): Promise<void> {
  const { base, llave } = obtenerCredenciales();
  const params = new URLSearchParams({
    competition_id_365: `eq.${competitionId}`,
    activa: "eq.true",
  });
  const resp = await peticionSupabase(`${base}/rest/v1/${TABLA_EQUIVALENCIAS}?${params}`, llave, {
    method: "PATCH",
    body: JSON.stringify({ ultima_sincronizacion: fecha }),
  });
  if (!resp.ok) throw new ErrorSupabase(`Supabase actualizar sync por competition: ${resp.status} ${await resp.text()}`);
}

// --- Partidos programados ---

export async function upsertPartidos(partidos: PartidoProgramadoDB[]): Promise<void> {
  if (partidos.length === 0) return;
  const { base, llave } = obtenerCredenciales();
  const resp = await peticionSupabase(`${base}/rest/v1/${TABLA_PARTIDOS}`, llave, {
    method: "POST",
    body: JSON.stringify(partidos),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
  if (!resp.ok) throw new ErrorSupabase(`Supabase upsert partidos: ${resp.status} ${await resp.text()}`);
}

/** competition_id con algun partido entre `desde` y `hasta` (ISO); solo lee competition_id y fecha_hora */
export async function obtenerCompetitionIdsConPartidos(desde: string, hasta: string): Promise<Set<number>> {
  const { base, llave } = obtenerCredenciales();
  const ids = new Set<number>();
  for (let offset = 0; ; offset += FILAS_POR_PAGINA_SUPABASE) {
    const params = new URLSearchParams({
      select: "competition_id",
      and: `(fecha_hora.gte.${desde},fecha_hora.lte.${hasta})`,
      order: "game_id.asc",
      limit: String(FILAS_POR_PAGINA_SUPABASE),
      offset: String(offset),
    });
    const resp = await peticionSupabase(`${base}/rest/v1/${TABLA_PARTIDOS}?${params}`, llave, {
      method: "GET",
    });
    if (!resp.ok) throw new ErrorSupabase(`Supabase competiciones con partidos: ${resp.status} ${await resp.text()}`);
    const pagina = (await resp.json()) as { competition_id: number }[];
    if (pagina.length === 0) return ids;
    for (const p of pagina) ids.add(p.competition_id);
  }
}

export async function buscarPartidosPorCompeticionYFecha(
  competitionId: number,
  fechaInicio: string,
  fechaFin: string,
): Promise<PartidoProgramadoDB[]> {
  const { base, llave } = obtenerCredenciales();
  const params = new URLSearchParams({ select: "*" });
  params.set("competition_id", `eq.${competitionId}`);
  params.set("and", `(fecha_hora.gte.${fechaInicio},fecha_hora.lte.${fechaFin})`);
  const resp = await peticionSupabase(`${base}/rest/v1/${TABLA_PARTIDOS}?${params}`, llave, {
    method: "GET",
  });
  if (!resp.ok) throw new ErrorSupabase(`Supabase buscar partidos: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as PartidoProgramadoDB[];
}

// --- Equipos ---

export async function upsertEquipos(equipos: { id: number; nombre: string }[]): Promise<void> {
  if (equipos.length === 0) return;
  const { base, llave } = obtenerCredenciales();
  const cuerpos = equipos.map((e) => ({
    id: e.id,
    nombre: e.nombre,
  }));
  const resp = await peticionSupabase(`${base}/rest/v1/${TABLA_EQUIPOS}?on_conflict=id`, llave, {
    method: "POST",
    body: JSON.stringify(cuerpos),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
  if (!resp.ok) throw new ErrorSupabase(`Supabase upsert equipos: ${resp.status} ${await resp.text()}`);
}

export async function obtenerEquiposPorIds(ids: number[]): Promise<Equipo365DB[]> {
  if (ids.length === 0) return [];
  const { base, llave } = obtenerCredenciales();
  const params = new URLSearchParams({
    select: "id,nombre,alias",
    id: `in.(${ids.join(",")})`,
  });
  const resp = await peticionSupabase(`${base}/rest/v1/${TABLA_EQUIPOS}?${params}`, llave, {
    method: "GET",
  });
  if (!resp.ok) throw new ErrorSupabase(`Supabase equipos: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as Equipo365DB[];
}

export async function agregarAlias(equipoId: number, nuevoAlias: string): Promise<void> {
  const { base, llave } = obtenerCredenciales();
  const params = new URLSearchParams({
    select: "alias",
    id: `eq.${equipoId}`,
    limit: "1",
  });
  const resp = await peticionSupabase(`${base}/rest/v1/${TABLA_EQUIPOS}?${params}`, llave, {
    method: "GET",
    headers: { Prefer: "return=representation" },
  });
  if (!resp.ok) throw new ErrorSupabase(`Supabase leer alias: ${resp.status} ${await resp.text()}`);
  const filas = (await resp.json()) as { alias: string[] }[];
  if (filas.length === 0) return;

  const actuales = filas[0].alias ?? [];
  const normNuevo = nuevoAlias.trim().toLowerCase();
  if (actuales.some((a) => a.trim().toLowerCase() === normNuevo)) return;

  const nuevos = [...actuales, nuevoAlias.trim()];
  const paramsPatch = new URLSearchParams({ id: `eq.${equipoId}` });
  const respPatch = await peticionSupabase(`${base}/rest/v1/${TABLA_EQUIPOS}?${paramsPatch}`, llave, {
    method: "PATCH",
    body: JSON.stringify({ alias: nuevos }),
  });
  if (!respPatch.ok) throw new ErrorSupabase(`Supabase agregar alias: ${respPatch.status} ${await respPatch.text()}`);
}

// --- Standings (fotos por dia) ---

/** Todas las fotos de una competicion sin sus filas, de la mas reciente a la mas vieja (pagina hasta una pagina vacia) */
export async function listarFotosStandings(competitionId: number): Promise<MetaFotoStandingDB[]> {
  const { base, llave } = obtenerCredenciales();
  const fotos: MetaFotoStandingDB[] = [];
  for (;;) {
    const params = new URLSearchParams({
      select: "id,season_num,stage_num,type,fecha,vigente_al_capturar",
      competition_id: `eq.${competitionId}`,
      order: "fecha.desc,id.desc",
      limit: String(FILAS_POR_PAGINA_SUPABASE),
      offset: String(fotos.length),
    });
    const resp = await peticionSupabase(`${base}/rest/v1/${TABLA_STANDINGS}?${params}`, llave, {
      method: "GET",
    });
    if (!resp.ok) throw new ErrorSupabase(`Supabase listar standings: ${resp.status} ${await resp.text()}`);
    const pagina = (await resp.json()) as MetaFotoStandingDB[];
    if (pagina.length === 0) return fotos;
    fotos.push(...pagina);
  }
}

export async function obtenerFilasDeFotos(ids: number[]): Promise<(Pick<FotoStandingDB, "rows"> & { id: number })[]> {
  if (ids.length === 0) return [];
  const { base, llave } = obtenerCredenciales();
  const params = new URLSearchParams({
    select: "id,rows",
    id: `in.(${ids.join(",")})`,
  });
  const resp = await peticionSupabase(`${base}/rest/v1/${TABLA_STANDINGS}?${params}`, llave, {
    method: "GET",
  });
  if (!resp.ok) throw new ErrorSupabase(`Supabase filas standings: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as (Pick<FotoStandingDB, "rows"> & { id: number })[];
}

/**
 * Upsert por la clave unica: si ya hay foto ese dia (sync corrido dos veces) se reemplaza.
 * La PK es id: sin on_conflict PostgREST no hace merge sobre la clave unica y la segunda escritura del dia da 409.
 */
export async function upsertFotosStandings(fotos: FotoStandingDB[]): Promise<void> {
  if (fotos.length === 0) return;
  const { base, llave } = obtenerCredenciales();
  const url = `${base}/rest/v1/${TABLA_STANDINGS}?on_conflict=competition_id,season_num,stage_num,type,fecha`;
  const resp = await peticionSupabase(url, llave, {
    method: "POST",
    body: JSON.stringify(fotos),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
  if (!resp.ok) throw new ErrorSupabase(`Supabase upsert standings: ${resp.status} ${await resp.text()}`);
}

// --- Ligas ---

export async function obtenerEquiposPorCompeticion(competitionId: number): Promise<Equipo365DB[]> {
  const { base, llave } = obtenerCredenciales();
  const params = new URLSearchParams({
    select: "local_id,visitante_id",
    competition_id: `eq.${competitionId}`,
  });
  const resp = await peticionSupabase(`${base}/rest/v1/${TABLA_PARTIDOS}?${params}`, llave, {
    method: "GET",
  });
  if (!resp.ok) throw new ErrorSupabase(`Supabase equipos competicion: ${resp.status} ${await resp.text()}`);
  const filas = (await resp.json()) as { local_id: number; visitante_id: number }[];
  const ids = [...new Set(filas.flatMap((f) => [f.local_id, f.visitante_id]))];
  if (ids.length === 0) return [];
  return obtenerEquiposPorIds(ids);
}

