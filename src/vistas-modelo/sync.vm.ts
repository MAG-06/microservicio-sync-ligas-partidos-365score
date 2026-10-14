/** Vista-modelo: sincronizacion de partidos programados desde 365Scores */

import { CONCURRENCIA_MAX } from "../config.js";
import { esquemaRespuesta365 } from "../esquemas/validacion.js";
import { pedirPartidosActuales } from "../modelos/api-365.js";
import {
  obtenerLigasActivas,
  upsertPartidos,
  upsertEquipos,
  actualizarSincronizacionPorCompetition,
} from "../modelos/supabase.js";
import type { PartidoProgramadoDB, RespuestaSync } from "../modelos/tipos.js";
import { ahoraIsoBogota } from "../utilidades/fecha.js";
import { pausaAleatoria } from "../utilidades/pausa.js";
import { mapearEstado } from "./estado.js";

export async function sincronizarTodas(): Promise<RespuestaSync> {
  const equivalencias = await obtenerLigasActivas();
  const competitionIds = [...new Set(equivalencias.map((e) => e.competition_id_365))];

  let totalPartidos = 0;

  for (let i = 0; i < competitionIds.length; i += CONCURRENCIA_MAX) {
    const lote = competitionIds.slice(i, i + CONCURRENCIA_MAX);
    const resultados = await Promise.all(lote.map((id) => sincronizarCompeticion(id)));
    totalPartidos += resultados.reduce((s, r) => s + r, 0);

    if (i + CONCURRENCIA_MAX < competitionIds.length) {
      await pausaAleatoria();
    }
  }

  return { ligas: competitionIds.length, partidos: totalPartidos };
}

export async function sincronizarCompeticion(competitionId: number): Promise<number> {
  const crudo = await pedirPartidosActuales(competitionId);
  const parseado = esquemaRespuesta365.parse(crudo);
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
