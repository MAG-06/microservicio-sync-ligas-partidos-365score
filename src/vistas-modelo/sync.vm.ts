/** Vista-modelo: sincronizacion de partidos programados desde 365Scores */

import type { ZodError } from "zod";
import { CONCURRENCIA_MAX } from "../config.js";
import { esquemaRespuesta365 } from "../esquemas/validacion.js";
import { pedirPartidosActuales } from "../modelos/api-365.js";
import {
  obtenerLigasActivas,
  upsertPartidos,
  upsertEquipos,
  actualizarSincronizacionPorCompetition,
} from "../modelos/supabase.js";
import type { ErrorSync, PartidoProgramadoDB, RespuestaSync } from "../modelos/tipos.js";
import { describirFallo, resumirIssuesZod } from "../utilidades/errores.js";
import { ahoraIsoBogota } from "../utilidades/fecha.js";
import { pausaAleatoria } from "../utilidades/pausa.js";
import { mapearEstado } from "./estado.js";

/** La respuesta de 365Scores no tiene la forma esperada (no es un error de validacion del cliente) */
export class ErrorRespuesta365Invalida extends Error {
  constructor(
    public readonly competitionId: number,
    causa: ZodError,
  ) {
    super(`Respuesta de 365Scores con formato inesperado: ${resumirIssuesZod(causa)}`, { cause: causa });
    this.name = "ErrorRespuesta365Invalida";
  }
}

/** Sincroniza todas las ligas activas; una competicion que falla se reporta en `errores` sin cortar las demas */
export async function sincronizarTodas(): Promise<RespuestaSync> {
  const inicio = Date.now();
  const equivalencias = await obtenerLigasActivas();
  const competitionIds = [...new Set(equivalencias.map((e) => e.competition_id_365))];
  const totalLotes = Math.ceil(competitionIds.length / CONCURRENCIA_MAX);
  console.log(`[sync] Inicio: ${competitionIds.length} ligas en ${totalLotes} lotes`);

  let totalPartidos = 0;
  const errores: ErrorSync[] = [];

  for (let i = 0; i < competitionIds.length; i += CONCURRENCIA_MAX) {
    const lote = competitionIds.slice(i, i + CONCURRENCIA_MAX);
    const resultados = await Promise.allSettled(lote.map((id) => sincronizarCompeticion(id)));

    resultados.forEach((resultado, j) => {
      if (resultado.status === "fulfilled") {
        totalPartidos += resultado.value;
        return;
      }
      const motivo = describirFallo(resultado.reason);
      console.error(`[sync] competition_id ${lote[j]} fallo: ${motivo}`);
      errores.push({ competition_id: lote[j], motivo });
    });

    const procesadas = i + lote.length;
    console.log(
      `[sync] Lote ${i / CONCURRENCIA_MAX + 1}/${totalLotes} terminado (${procesadas}/${competitionIds.length} ligas)`,
    );

    if (procesadas < competitionIds.length) {
      await pausaAleatoria();
    }
  }

  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(
    `[sync] Fin: ${competitionIds.length} ligas, ${totalPartidos} partidos, ${errores.length} errores en ${segundos} s`,
  );

  return { ligas: competitionIds.length, partidos: totalPartidos, errores };
}

export async function sincronizarCompeticion(competitionId: number): Promise<number> {
  const crudo = await pedirPartidosActuales(competitionId);
  const validacion = esquemaRespuesta365.safeParse(crudo);
  if (!validacion.success) throw new ErrorRespuesta365Invalida(competitionId, validacion.error);
  const parseado = validacion.data;
  const ahora = ahoraIsoBogota();

  const partidos: PartidoProgramadoDB[] = parseado.games.map((g) => ({
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

  const equiposUnicos = new Map<number, string>();
  for (const g of parseado.games) {
    equiposUnicos.set(g.homeCompetitor.id, g.homeCompetitor.name);
    equiposUnicos.set(g.awayCompetitor.id, g.awayCompetitor.name);
  }
  const equipos = [...equiposUnicos.entries()].map(([id, nombre]) => ({ id, nombre }));

  await upsertPartidos(partidos);
  await upsertEquipos(equipos);
  await actualizarSincronizacionPorCompetition(competitionId, ahora);

  return partidos.length;
}
