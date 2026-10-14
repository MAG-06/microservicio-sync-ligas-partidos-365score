/** Vista-modelo: busqueda de partido por casa + liga + fecha + equipos */

import { DateTime } from "luxon";
import { DIAS_TOLERANCIA_FECHA, HORAS_SINCRONIZACION_STALE, ZONA_BOGOTA } from "../config.js";
import {
  obtenerEquivalencia,
  buscarPartidosPorCompeticionYFecha,
  obtenerEquiposPorIds,
  agregarAlias,
  obtenerEquiposPorCompeticion,
} from "../modelos/supabase.js";
import type { RespuestaBuscarPartido, PartidoProgramadoDB } from "../modelos/tipos.js";
import { inicioDelDiaBogota, finDelDiaBogota } from "../utilidades/fecha.js";
import { nombresCoinciden } from "../utilidades/nombres.js";
import { equivalenciaActiva } from "./equivalencias.vm.js";
import { sincronizarCompeticion } from "./sync.vm.js";

export class ErrorLigaNoMapeada extends Error {
  constructor(casa: string, ligaCasaId: string) {
    super(`Liga no mapeada: casa=${casa}, liga_casa_id=${ligaCasaId}`);
    this.name = "ErrorLigaNoMapeada";
  }
}

export class ErrorPartidoNoEncontrado extends Error {
  constructor() {
    super("Partido no encontrado");
    this.name = "ErrorPartidoNoEncontrado";
  }
}

export class ErrorPartidoAmbiguo extends Error {
  public readonly candidatos: RespuestaBuscarPartido[];
  constructor(candidatos: RespuestaBuscarPartido[]) {
    super("Múltiples candidatos ambiguos");
    this.name = "ErrorPartidoAmbiguo";
    this.candidatos = candidatos;
  }
}

interface CandidatoParcial {
  partido: RespuestaBuscarPartido;
  equipoSinMatch: "local" | "visitante";
  equipoId: number;
  nombreBuscado: string;
}

export async function buscarPartido(
  casa: string,
  ligaCasaId: string,
  fecha: string,
  localBuscado: string,
  visitanteBuscado: string,
  inicio?: string,
): Promise<RespuestaBuscarPartido> {
  const equivalencia = await obtenerEquivalencia(casa, ligaCasaId);
  if (!equivalencia || !equivalenciaActiva(equivalencia)) {
    throw new ErrorLigaNoMapeada(casa, ligaCasaId);
  }

  const competitionId = equivalencia.competition_id_365;

  if (necesitaSincronizacion(equivalencia.ultima_sincronizacion)) {
    await sincronizarCompeticion(competitionId);
  }

  const inicioRango = inicioDelDiaBogota(fecha).toUTC().toISO()!;
  const finRango = finDelDiaBogota(fecha).toUTC().toISO()!;

  const partidos = await buscarPartidosPorCompeticionYFecha(competitionId, inicioRango, finRango);
  const aliasMap = await obtenerAliasPorEquipo(partidos);

  const { completos, parciales } = clasificarCandidatos(
    partidos, localBuscado, visitanteBuscado, aliasMap,
  );

  if (completos.length === 1) return completos[0];
  if (completos.length > 1) throw new ErrorPartidoAmbiguo(completos);

  if (parciales.length === 1) {
    const p = parciales[0];
    await intentarGuardarAlias(p, inicio, competitionId);
    return p.partido;
  }
  if (parciales.length > 1) {
    throw new ErrorPartidoAmbiguo(parciales.map((c) => c.partido));
  }

  return buscarConToleranciaDeFecha(competitionId, fecha, localBuscado, visitanteBuscado, inicio);
}

/**
 * Segunda pasada cuando el dia exacto no da nada: la casa y 365Scores pueden tener el
 * partido en dias distintos (reprogramaciones). Solo acepta coincidencias completas,
 * porque un parcial fuera del dia seria otro partido del mismo equipo, y no aprende alias.
 */
async function buscarConToleranciaDeFecha(
  competitionId: number,
  fecha: string,
  localBuscado: string,
  visitanteBuscado: string,
  inicio: string | undefined,
): Promise<RespuestaBuscarPartido> {
  const inicioRango = inicioDelDiaBogota(fecha).minus({ days: DIAS_TOLERANCIA_FECHA }).toUTC().toISO()!;
  const finRango = finDelDiaBogota(fecha).plus({ days: DIAS_TOLERANCIA_FECHA }).toUTC().toISO()!;

  const partidos = await buscarPartidosPorCompeticionYFecha(competitionId, inicioRango, finRango);
  const aliasMap = await obtenerAliasPorEquipo(partidos);

  const { completos } = clasificarCandidatos(partidos, localBuscado, visitanteBuscado, aliasMap);
  if (completos.length === 0) throw new ErrorPartidoNoEncontrado();

  return elegirMasCercano(completos, horaDeReferencia(fecha, inicio));
}

function elegirMasCercano(
  candidatos: RespuestaBuscarPartido[],
  referencia: DateTime,
): RespuestaBuscarPartido {
  const medidos = candidatos.map((c) => {
    const minutos = DateTime.fromISO(c.fecha_hora).diff(referencia, "minutes").minutes;
    return {
      candidato: { ...c, fecha_difiere: true, diferencia_minutos: Math.round(minutos) },
      distancia: Math.abs(minutos),
    };
  });

  const minima = Math.min(...medidos.map((m) => m.distancia));
  const masCercanos = medidos.filter((m) => m.distancia === minima).map((m) => m.candidato);

  if (masCercanos.length > 1) throw new ErrorPartidoAmbiguo(masCercanos);
  return masCercanos[0];
}

function horaDeReferencia(fecha: string, inicio: string | undefined): DateTime {
  return inicio ? DateTime.fromISO(inicio) : inicioDelDiaBogota(fecha).set({ hour: 12 });
}

async function obtenerAliasPorEquipo(partidos: PartidoProgramadoDB[]): Promise<Map<number, string[]>> {
  const idsEquipos = [...new Set(partidos.flatMap((p) => [p.local_id, p.visitante_id]))];
  const equipos = await obtenerEquiposPorIds(idsEquipos);
  return new Map(equipos.map((e) => [e.id, e.alias ?? []]));
}

export function clasificarCandidatos(
  partidos: PartidoProgramadoDB[],
  localBuscado: string,
  visitanteBuscado: string,
  aliasMap: Map<number, string[]>,
): { completos: RespuestaBuscarPartido[]; parciales: CandidatoParcial[] } {
  const completos: RespuestaBuscarPartido[] = [];
  const parciales: CandidatoParcial[] = [];

  for (const p of partidos) {
    const aliasLocal = aliasMap.get(p.local_id) ?? [];
    const aliasVisitante = aliasMap.get(p.visitante_id) ?? [];

    const localCoincide = nombresCoinciden(localBuscado, p.local_nombre, aliasLocal);
    const visitanteCoincide = nombresCoinciden(visitanteBuscado, p.visitante_nombre, aliasVisitante);

    const resultado: RespuestaBuscarPartido = {
      game_id: p.game_id,
      competition_id: p.competition_id,
      fecha_hora: p.fecha_hora,
      local: p.local_nombre,
      visitante: p.visitante_nombre,
      fecha_difiere: false,
    };

    if (localCoincide && visitanteCoincide) {
      completos.push(resultado);
    } else if (localCoincide && !visitanteCoincide) {
      parciales.push({
        partido: resultado,
        equipoSinMatch: "visitante",
        equipoId: p.visitante_id,
        nombreBuscado: visitanteBuscado,
      });
    } else if (!localCoincide && visitanteCoincide) {
      parciales.push({
        partido: resultado,
        equipoSinMatch: "local",
        equipoId: p.local_id,
        nombreBuscado: localBuscado,
      });
    }
  }

  return { completos, parciales };
}

async function intentarGuardarAlias(
  parcial: CandidatoParcial,
  inicio: string | undefined,
  competitionId: number,
): Promise<void> {
  if (!inicio) {
    console.log(
      `[auto-alias] No guardado: "${parcial.nombreBuscado}" para equipo ${parcial.equipoId} (sin parametro inicio)`,
    );
    return;
  }

  const dtInicio = DateTime.fromISO(inicio);
  const dtPartido = DateTime.fromISO(parcial.partido.fecha_hora);
  const diffMinutos = Math.abs(dtInicio.diff(dtPartido, "minutes").minutes);

  if (diffMinutos > 30) {
    console.log(
      `[auto-alias] No guardado: "${parcial.nombreBuscado}" para equipo ${parcial.equipoId} ` +
      `(diferencia de hora: ${Math.round(diffMinutos)} min, maximo 30)`,
    );
    return;
  }

  const todosEquipos = await obtenerEquiposPorCompeticion(competitionId);
  const aliasEnUso = todosEquipos.some((e) => {
    if (e.id === parcial.equipoId) return false;
    return nombresCoinciden(parcial.nombreBuscado, e.nombre, e.alias ?? []);
  });

  if (aliasEnUso) {
    console.log(
      `[auto-alias] No guardado: "${parcial.nombreBuscado}" para equipo ${parcial.equipoId} ` +
      `(alias coincide con otro equipo de la competicion)`,
    );
    return;
  }

  await agregarAlias(parcial.equipoId, parcial.nombreBuscado);
}

function necesitaSincronizacion(ultimaSincronizacion: string | null): boolean {
  if (!ultimaSincronizacion) return true;
  const ultima = DateTime.fromISO(ultimaSincronizacion);
  const ahora = DateTime.now().setZone(ZONA_BOGOTA);
  return ahora.diff(ultima, "hours").hours > HORAS_SINCRONIZACION_STALE;
}
