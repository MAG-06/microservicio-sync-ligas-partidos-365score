/** Vista-modelo: fotos diarias de standings (total, local y visitante) desde 365Scores */

import type { z } from "zod";
import {
  CONCURRENCIA_MAX,
  DIAS_STANDINGS,
  DIAS_STANDINGS_ATRAS,
  FASES_REGULARES,
  LOTES_POR_LOG_STANDINGS,
  TEMPORADA_ANTERIOR,
  TIPOS_STANDINGS,
  SALTOS_BUSQUEDA_TEMPORADA_ANTERIOR,
} from "../config.js";
import { esquemaStandings365, type esquemaFilaStanding365 } from "../esquemas/validacion.js";
import { pedirStandings, type ConsultaStandings365 } from "../modelos/api-365.js";
import {
  obtenerCompetitionIdsActivas,
  obtenerCompetitionIdsConPartidos,
  listarFotosStandings,
  obtenerFilasDeFotos,
  upsertFotosStandings,
} from "../modelos/supabase.js";
import type {
  ErrorSync,
  FilaStanding,
  FotoStandingDB,
  MetaFotoStandingDB,
  RespuestaSyncStandings,
} from "../modelos/tipos.js";
import { describirFallo } from "../utilidades/errores.js";
import { ahoraIsoBogota, ahoraMasDiasIsoBogota, hoyBogota } from "../utilidades/fecha.js";
import { pausaAleatoria } from "../utilidades/pausa.js";
import { ErrorRespuesta365Invalida } from "./sync.vm.js";

type Standings365 = z.infer<typeof esquemaStandings365>;
type TablaStanding365 = Standings365["standings"][number];
type Pausa = () => Promise<void>;

const TIPO_TOTAL = TIPOS_STANDINGS[0];

/** Una consulta que no se guarda porque 365 devolvio otra temporada/fase: va a `errores` y la liga sigue */
class ErrorConsultaStandings extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrorConsultaStandings";
  }
}

/** 365 no tiene una tabla que se pueda guardar para esa consulta: cuenta en sin_tabla, no es error (`aviso` va al log) */
class SinTablaStandings extends Error {
  constructor(public readonly aviso: string | null) {
    super(aviso ?? "sin tabla");
    this.name = "SinTablaStandings";
  }
}

/** Temporada/fase a fotografiar; stageNum null = se pide sin stageNum y se guarda el que devuelva 365 */
interface Objetivo {
  seasonNum: number;
  stageNum: number | null;
}

interface ResultadoStandingsCompeticion {
  fotos_nuevas: number;
  sin_cambios: number;
  sin_tabla: number;
  /** 1 si la fase vigente tenia un partido en vivo y no se escribio (0 si no) */
  en_juego: number;
  /** Consultas descartadas y avisos de config; la liga se sincronizo igual */
  avisos: string[];
  /** Por que se descarto una tabla (grupos que no cuadran, varias tablas…); cuenta en sin_tabla y va solo al log */
  descartadas: string[];
}

function sumar(tabla: TablaStanding365, campo: "for" | "against" | "gamesWon" | "gamesLost"): number {
  return tabla.rows.reduce((total, r) => total + r[campo], 0);
}

function describirTabla(tabla: TablaStanding365, type: number): string {
  return `seasonNum ${tabla.seasonNum} stageNum ${tabla.stageNum} type ${type}`;
}

export function recortarFilas(rows: z.infer<typeof esquemaFilaStanding365>[]): FilaStanding[] {
  return rows.map((r) => ({
    equipo_id: r.competitor.id,
    nombre: r.competitor.name,
    posicion: r.position,
    partidos: r.gamePlayed,
    ganados: r.gamesWon,
    empatados: r.gamesEven,
    perdidos: r.gamesLost,
    gf: r.for,
    gc: r.against,
    puntos: r.points,
    grupo: r.groupNum ?? null,
  }));
}

const CAMPOS_FILA: (keyof FilaStanding)[] = [
  "equipo_id", "nombre", "posicion", "partidos", "ganados", "empatados", "perdidos", "gf", "gc", "puntos", "grupo",
];

/** Compara por equipo_id campo a campo (el jsonb de Postgres no conserva el orden de las claves) */
export function filasIguales(a: FilaStanding[], b: FilaStanding[]): boolean {
  if (a.length !== b.length) return false;
  const porEquipo = new Map(b.map((f) => [f.equipo_id, f]));
  return a.every((fa) => {
    const fb = porEquipo.get(fa.equipo_id);
    return fb !== undefined && CAMPOS_FILA.every((c) => fa[c] === fb[c]);
  });
}

/**
 * Equipos de local/visitante que no cuadran con la total, como "faltan N, sobran M"; null si cuadran.
 * Sobra un equipo que no esta en la total. Falta un equipo de la total que no esta en la local o en la visitante,
 * salvo que todos sus partidos esten en la otra (un equipo que todavia no jugo de local puede no aparecer)
 */
export function equiposQueNoCuadran(
  total: FilaStanding[],
  local: FilaStanding[],
  visitante: FilaStanding[],
): string | null {
  const idsTotal = new Set(total.map((f) => f.equipo_id));
  const sobran = new Set([...local, ...visitante].map((f) => f.equipo_id).filter((id) => !idsTotal.has(id))).size;
  const partidosEn = (filas: FilaStanding[], id: number) => filas.find((f) => f.equipo_id === id)?.partidos;
  const faltan = total.filter((f) => {
    const enLocal = partidosEn(local, f.equipo_id);
    const enVisitante = partidosEn(visitante, f.equipo_id);
    if (enLocal !== undefined && enVisitante !== undefined) return false;
    return (enLocal ?? 0) + (enVisitante ?? 0) !== f.partidos;
  }).length;
  return faltan === 0 && sobran === 0 ? null : `faltan ${faltan}, sobran ${sobran}`;
}

/** Resumen en una linea de por que una foto es nueva respecto a la ultima de su clave (para el log) */
export function describirCambios(
  foto: Pick<FotoStandingDB, "rows" | "vigente_al_capturar">,
  ultima?: { rows?: FilaStanding[]; vigente_al_capturar: boolean },
): string {
  if (!ultima?.rows) return `primera foto (${foto.rows.length} equipos)`;

  const previas = new Map(ultima.rows.map((f) => [f.equipo_id, f]));
  const ids = new Set(foto.rows.map((f) => f.equipo_id));
  const campos = new Set<keyof FilaStanding>();
  let cambiados = 0;
  let entran = 0;
  for (const fila of foto.rows) {
    const previa = previas.get(fila.equipo_id);
    if (!previa) { entran++; continue; }
    const distintos = CAMPOS_FILA.filter((c) => fila[c] !== previa[c]);
    if (distintos.length > 0) cambiados++;
    distintos.forEach((c) => campos.add(c));
  }
  const salen = ultima.rows.filter((f) => !ids.has(f.equipo_id)).length;

  const partes: string[] = [];
  if (cambiados > 0) partes.push(`${cambiados} equipos cambiaron (${CAMPOS_FILA.filter((c) => campos.has(c)).join(", ")})`);
  if (entran > 0) partes.push(`${entran} equipos entran`);
  if (salen > 0) partes.push(`${salen} equipos salen`);
  if (ultima.vigente_al_capturar !== foto.vigente_al_capturar) {
    partes.push(`vigente_al_capturar ${ultima.vigente_al_capturar} -> ${foto.vigente_al_capturar}`);
  }
  return partes.join("; ") || "sin diferencias";
}

function claveFoto(seasonNum: number, stageNum: number, type: number): string {
  return `${seasonNum}|${stageNum}|${type}`;
}

function coincide(tabla: TablaStanding365, objetivo: Objetivo): boolean {
  return (
    tabla.seasonNum === objetivo.seasonNum && (objetivo.stageNum === null || tabla.stageNum === objetivo.stageNum)
  );
}

function describirObjetivo(objetivo: Objetivo, type: number): string {
  const fase = objetivo.stageNum === null ? "" : ` stageNum ${objetivo.stageNum}`;
  return `seasonNum ${objetivo.seasonNum}${fase} type ${type}`;
}

/** Pide tablas de una competicion: pausa entre llamadas, valida con Zod y reutiliza las tablas ya validadas */
class ConsultorStandings {
  private llamadas = 0;
  /** `problema` != null: la tabla no se guarda (cuenta en sin_tabla con ese aviso) */
  private tablas: { type: number; tabla: TablaStanding365; problema: string | null }[] = [];

  constructor(
    private readonly competitionId: number,
    private readonly pausa: Pausa,
  ) {}

  async pedir(consulta: ConsultaStandings365): Promise<Standings365> {
    if (this.llamadas > 0) await this.pausa();
    this.llamadas++;
    const crudo = await pedirStandings(this.competitionId, consulta);
    const validacion = esquemaStandings365.safeParse(crudo);
    if (!validacion.success) throw new ErrorRespuesta365Invalida(this.competitionId, validacion.error);
    return validacion.data;
  }

  /** Guarda una tabla ya pedida para reutilizarla; devuelve el aviso si no se puede guardar */
  recordar(type: number, tabla: TablaStanding365): string | null {
    const motivo = this.problema(tabla, type);
    const problema = motivo && `${motivo} en ${describirTabla(tabla, type)}: no se guarda`;
    this.tablas.push({ type, tabla, problema });
    return problema;
  }

  /**
   * Con grupos/conferencias 365 manda todos los grupos en la misma tabla (`position` es dentro del grupo).
   * Se guarda solo si se puede comprobar que esta completa: la total cierra (goles a favor = en contra y
   * ganados = perdidos en toda la liga) y local/visitante no traen equipos que no esten en esa total.
   */
  private problema(tabla: TablaStanding365, type: number): string | null {
    const ids = tabla.rows.map((r) => r.competitor.id);
    if (new Set(ids).size !== ids.length) return "equipos repetidos";
    if (!tabla.rows.some((r) => r.groupNum != null)) return null;

    if (type === TIPO_TOTAL) {
      const cierra = sumar(tabla, "for") === sumar(tabla, "against") && sumar(tabla, "gamesWon") === sumar(tabla, "gamesLost");
      return cierra ? null : "tabla por grupos incompleta (goles a favor/en contra o ganados/perdidos no cuadran)";
    }
    const total = this.tablas.find(
      (t) => t.type === TIPO_TOTAL && t.problema === null &&
        t.tabla.seasonNum === tabla.seasonNum && t.tabla.stageNum === tabla.stageNum,
    );
    if (!total) return "tabla por grupos sin tabla total verificada";
    const idsTotal = new Set(total.tabla.rows.map((r) => r.competitor.id));
    return ids.every((id) => idsTotal.has(id)) ? null : "tabla por grupos con equipos que no estan en la total";
  }

  /**
   * Tabla de un objetivo. Lanza SinTablaStandings si 365 no tiene una tabla guardable para ese objetivo y type
   * (sin standings, varias tablas separadas, una tabla sin split local/visitante que ante type=2/3 devuelve la
   * total, o grupos que no cuadran) y ErrorConsultaStandings si devuelve otra temporada/fase (un stageNum
   * inexistente devuelve otra fase sin error).
   */
  async tabla(objetivo: Objetivo, type: number): Promise<TablaStanding365> {
    const yaPedida = this.tablas.find((t) => t.type === type && coincide(t.tabla, objetivo));
    if (yaPedida) {
      if (yaPedida.problema) throw new SinTablaStandings(yaPedida.problema);
      return yaPedida.tabla;
    }

    const { standings } = await this.pedir({
      seasonNum: objetivo.seasonNum,
      stageNum: objetivo.stageNum ?? undefined,
      type,
    });
    if (standings.length > 1) {
      throw new SinTablaStandings(
        `365 devolvio ${standings.length} tablas separadas al pedir ${describirObjetivo(objetivo, type)}: no se guarda`,
      );
    }
    const tabla = standings[0];
    if (!tabla) throw new SinTablaStandings(null);
    if (!coincide(tabla, objetivo)) {
      throw new ErrorConsultaStandings(
        `365 devolvio seasonNum ${tabla.seasonNum} stageNum ${tabla.stageNum} al pedir ` +
          `${describirObjetivo(objetivo, type)}: no se guarda`,
      );
    }
    if (type !== TIPO_TOTAL && !tabla.filterTypes?.some((f) => f.type === type)) throw new SinTablaStandings(null);
    const problema = this.recordar(type, tabla);
    if (problema) throw new SinTablaStandings(problema);
    return tabla;
  }
}

/** seasonNum de la temporada anterior: mapa de config, la ultima ya guardada o busqueda hacia atras; null si no hay */
async function resolverTemporadaAnterior(
  competitionId: number,
  temporadaActual: number,
  guardadas: MetaFotoStandingDB[],
  consultor: ConsultorStandings,
): Promise<number | null> {
  const mapeada = TEMPORADA_ANTERIOR[competitionId];
  if (mapeada !== undefined) return mapeada;

  const anteriores = guardadas.map((f) => f.season_num).filter((s) => s < temporadaActual);
  if (anteriores.length > 0) return Math.max(...anteriores);

  // Los seasonNum no son consecutivos (hay temporadas vacias en medio)
  for (let salto = 1; salto <= SALTOS_BUSQUEDA_TEMPORADA_ANTERIOR; salto++) {
    const seasonNum = temporadaActual - salto;
    const { standings } = await consultor.pedir({ seasonNum, type: TIPO_TOTAL });
    const tabla = standings[0];
    if (standings.length === 1 && tabla.seasonNum === seasonNum && tabla.rows.length > 0) {
      consultor.recordar(TIPO_TOTAL, tabla);
      return seasonNum;
    }
  }
  console.log(`[standings] competition_id ${competitionId}: sin temporada anterior`);
  return null;
}

/**
 * Fotografia la temporada actual (sus fases regulares) y la anterior en los 3 types.
 * Lo que ya no es actual solo se pide si no tiene foto o si su ultima foto quedo vigente (se pide una vez para cerrarla).
 * Solo escribe las fotos cuyas filas o vigencia cambiaron respecto a la ultima de su clave.
 */
export async function sincronizarStandingsCompeticion(
  competitionId: number,
  fecha: string,
  pausa: Pausa = pausaAleatoria,
): Promise<ResultadoStandingsCompeticion> {
  const avisos: string[] = [];
  const descartadas: string[] = [];
  let sinTabla = 0;
  const consultor = new ConsultorStandings(competitionId, pausa);

  // Sin seasonNum ni stageNum: 365 dice cual es la temporada/fase actual (y la tabla total se reutiliza)
  const actual = await consultor.pedir({ type: TIPO_TOTAL });
  const competicion = actual.competitions?.[0];
  const tablaActual = actual.standings[0];
  // Liga sin tabla (copa, fase de eliminacion…): no es error
  if (!tablaActual || competicion?.hasStandings === false) {
    return { fotos_nuevas: 0, sin_cambios: 0, sin_tabla: 1, en_juego: 0, avisos, descartadas };
  }
  // Varias tablas separadas: no se sabe si juntas son la liga completa
  if (actual.standings.length > 1) {
    descartadas.push(`365 devolvio ${actual.standings.length} tablas separadas para la fase actual: no se guarda`);
    return { fotos_nuevas: 0, sin_cambios: 0, sin_tabla: 1, en_juego: 0, avisos, descartadas };
  }
  if (!competicion) throw new ErrorConsultaStandings("365 no devolvio competitions[0] (temporada actual)");
  const { currentSeasonNum } = competicion;
  // Fase actual = la de la tabla que 365 muestra ahora. currentStageNum puede ser una fase sin tabla (Cuartos de una
  // copa) y entonces 365 cae a otra: pedir local/visitante con currentStageNum devolveria esa otra fase
  const faseActual = tablaActual.stageNum;
  // Si no se puede guardar (grupos que no cuadran) queda marcada y se reporta al pedirla abajo
  consultor.recordar(TIPO_TOTAL, tablaActual);

  // Mas reciente primero: la primera de cada clave es la ultima foto
  const guardadas = await listarFotosStandings(competitionId);
  const ultimas = new Map<string, MetaFotoStandingDB>();
  for (const f of guardadas) {
    const clave = claveFoto(f.season_num, f.stage_num, f.type);
    if (!ultimas.has(clave)) ultimas.set(clave, f);
  }

  const objetivos: Objetivo[] = [];
  const agregar = (o: Objetivo) => {
    if (!objetivos.some((x) => x.seasonNum === o.seasonNum && x.stageNum === o.stageNum)) objetivos.push(o);
  };

  const fasesLiga = FASES_REGULARES[competitionId];
  if (!fasesLiga) {
    // Con seasonNum y sin stageNum 365 elige otra fase (la ultima, a veces sin partidos o sin local/visitante) o no
    // devuelve nada: la fase actual se pide explicita
    agregar({ seasonNum: currentSeasonNum, stageNum: faseActual });
  } else if (fasesLiga[currentSeasonNum]) {
    // Las fases con numero mayor a la actual todavia no empiezan (365 numera las fases en orden)
    fasesLiga[currentSeasonNum]
      .filter((f) => f <= faseActual)
      .forEach((f) => agregar({ seasonNum: currentSeasonNum, stageNum: f }));
  } else {
    avisos.push(
      `temporada ${currentSeasonNum} no esta en FASES_REGULARES: se guarda solo la fase actual (stageNum ${faseActual})`,
    );
    agregar({ seasonNum: currentSeasonNum, stageNum: faseActual });
  }

  const anterior = await resolverTemporadaAnterior(competitionId, currentSeasonNum, guardadas, consultor);
  if (anterior !== null) {
    if (!fasesLiga) agregar({ seasonNum: anterior, stageNum: null });
    else if (fasesLiga[anterior]) fasesLiga[anterior].forEach((f) => agregar({ seasonNum: anterior, stageNum: f }));
    else avisos.push(`temporada anterior ${anterior} no esta en FASES_REGULARES: no se guarda`);
  }

  // Tablas cuya ultima foto quedo vigente pero ya no son las actuales (cambio de fase o temporada): se cierran
  for (const f of ultimas.values()) {
    const esActual = f.season_num === currentSeasonNum && f.stage_num === faseActual;
    if (f.vigente_al_capturar && !esActual) agregar({ seasonNum: f.season_num, stageNum: f.stage_num });
  }

  const esVigente = (o: Objetivo): boolean =>
    o.seasonNum === currentSeasonNum && (o.stageNum ?? faseActual) === faseActual;

  // Partido en vivo: la total ya lo cuenta y la local/visitante no. No se escribe ninguna de las 3 tablas de la
  // fase vigente (quedan las de la ultima foto); la tabla final entra en la siguiente corrida
  const partidosEnVivo = new Set(tablaActual.rows.flatMap((r) => (r.liveGameId != null ? [r.liveGameId] : [])));
  const enJuego = partidosEnVivo.size > 0 ? 1 : 0;
  if (enJuego) {
    console.log(
      `[standings] competition_id ${competitionId} seasonNum ${currentSeasonNum} stageNum ${faseActual} ` +
        `en juego: ${partidosEnVivo.size} partidos en vivo, no se escribe la fase vigente`,
    );
  }

  /**
   * Se decide por fase, no por type: las 3 tablas se piden juntas para validarlas juntas (cuadre de partidos,
   * equipos, local y visitante juntas). Una fase que ya no es la actual queda cerrada por la foto de su total: si
   * existe y no quedo vigente no se vuelve a pedir, aunque su local/visitante se hayan descartado (365 no cambia
   * una fase cerrada, y volver a pedirla daria el mismo resultado)
   */
  const hayQuePedirFase = (o: Objetivo): boolean => {
    if (esVigente(o)) return !enJuego;
    const ultimaTotal = guardadas.find(
      (f) => f.season_num === o.seasonNum && f.type === TIPO_TOTAL && (o.stageNum === null || f.stage_num === o.stageNum),
    );
    return !ultimaTotal || ultimaTotal.vigente_al_capturar;
  };

  const ahora = ahoraIsoBogota();
  const candidatas: { foto: FotoStandingDB; ultima?: MetaFotoStandingDB }[] = [];
  /** Tablas pedidas que no se pueden guardar, como `season|stage|type` (stage `*` si se pidio sin stageNum) */
  const fallidas = new Set<string>();
  for (const objetivoInicial of objetivos) {
    if (!hayQuePedirFase(objetivoInicial)) continue;
    let objetivo = objetivoInicial;
    for (const type of TIPOS_STANDINGS) {
      let tabla: TablaStanding365;
      try {
        tabla = await consultor.tabla(objetivo, type);
      } catch (error) {
        if (!(error instanceof SinTablaStandings) && !(error instanceof ErrorConsultaStandings)) throw error;
        fallidas.add(`${objetivo.seasonNum}|${objetivo.stageNum ?? "*"}|${type}`);
        if (error instanceof SinTablaStandings) {
          sinTabla++;
          if (error.aviso) descartadas.push(error.aviso);
        } else if (esVigente(objetivo)) {
          // La fase vigente es la que 365 muestra: si local/visitante vuelven de otra fase, no hay split para ella
          sinTabla++;
          descartadas.push(error.message);
        } else {
          avisos.push(error.message);
        }
        continue;
      }
      // Sin stageNum (temporada anterior de una liga sin mapa) 365 elige la fase con la total; local y visitante
      // se piden con esa misma fase
      if (objetivo.stageNum === null) objetivo = { seasonNum: objetivo.seasonNum, stageNum: tabla.stageNum };

      const clave = claveFoto(tabla.seasonNum, tabla.stageNum, type);
      if (candidatas.some((c) => claveFoto(c.foto.season_num, c.foto.stage_num, c.foto.type) === clave)) continue;
      candidatas.push({
        foto: {
          competition_id: competitionId,
          season_num: tabla.seasonNum,
          stage_num: tabla.stageNum,
          type,
          fecha,
          rows: recortarFilas(tabla.rows),
          vigente_al_capturar: tabla.seasonNum === currentSeasonNum && tabla.stageNum === faseActual,
          actualizado_en: ahora,
        },
        ultima: ultimas.get(clave),
      });
    }
  }

  // Local y visitante se guardan juntas o ninguna: si una se pidio y no se puede guardar, o no tiene partidos
  // mientras la otra si (cada partido suma 1 en las dos), la otra tampoco
  const [, TIPO_LOCAL, TIPO_VISITANTE] = TIPOS_STANDINGS;
  const nombreTipo = (t: number) => (t === TIPO_LOCAL ? "local" : "visitante");
  const tienePartidos = (foto: FotoStandingDB) => foto.rows.some((f) => f.partidos > 0);
  const sinPareja = new Set<FotoStandingDB>();
  for (const { foto } of candidatas) {
    if (foto.type === TIPO_TOTAL || !tienePartidos(foto)) continue;
    const otro = foto.type === TIPO_LOCAL ? TIPO_VISITANTE : TIPO_LOCAL;
    const falla = (stage: number | string) => fallidas.has(`${foto.season_num}|${stage}|${otro}`);
    const pareja = candidatas.find(
      (c) => c.foto.season_num === foto.season_num && c.foto.stage_num === foto.stage_num && c.foto.type === otro,
    );
    const parejaSinPartidos = pareja !== undefined && !tienePartidos(pareja.foto);
    if (!falla(foto.stage_num) && !falla("*") && !parejaSinPartidos) continue;
    sinPareja.add(foto);
    sinTabla++;
    descartadas.push(
      `local y visitante van juntas: ${parejaSinPartidos ? "no tiene partidos" : "falta"} la ${nombreTipo(otro)} ` +
        `en seasonNum ${foto.season_num} stageNum ${foto.stage_num}: no se guarda la ${nombreTipo(foto.type)}`,
    );
  }

  // Cada partido suma 2 en la total (un equipo de cada lado) y 1 en la local y 1 en la visitante, asi que en una
  // fase con las 3 tablas la total debe ser local + visitante. Hasta una jornada de diferencia (equipos / 2
  // partidos) es el retraso de 365 al actualizar local/visitante tras un partido: se guarda igual y se avisa.
  // Mas que eso no es retraso (total acumulada de varias fases, equipos que faltan): local y visitante no se guardan
  const descartarLocalVisitante = new Set<string>();
  for (const total of candidatas.filter((c) => c.foto.type === TIPO_TOTAL)) {
    const { season_num, stage_num } = total.foto;
    const deLaFase = candidatas.filter(
      (c) => !sinPareja.has(c.foto) && c.foto.season_num === season_num && c.foto.stage_num === stage_num,
    );
    if (deLaFase.length !== TIPOS_STANDINGS.length) continue;
    const fase = `seasonNum ${season_num} stageNum ${stage_num}`;

    // Equipos que faltan o sobran no son retraso (el retraso nunca saca un equipo): no se guardan aunque la
    // diferencia de partidos sea de menos de una jornada
    const [filasTotal, filasLocal, filasVisitante] = TIPOS_STANDINGS.map((t) => deLaFase.find((c) => c.foto.type === t)!.foto.rows);
    const equipos = equiposQueNoCuadran(filasTotal, filasLocal, filasVisitante);
    if (equipos) {
      descartarLocalVisitante.add(`${season_num}|${stage_num}`);
      sinTabla += TIPOS_STANDINGS.length - 1;
      descartadas.push(`local y visitante no tienen los mismos equipos que la total (${equipos}) en ${fase}: no se guardan`);
      continue;
    }

    const [partidosTotal, partidosLocal, partidosVisitante] = [filasTotal, filasLocal, filasVisitante].map((filas) =>
      filas.reduce((suma, f) => suma + f.partidos, 0),
    );
    const sumaLocalVisitante = partidosLocal + partidosVisitante;
    if (partidosTotal === sumaLocalVisitante) continue;

    const numeros = `total ${partidosTotal} partidos, local + visitante ${sumaLocalVisitante}`;
    const diferenciaEnPartidos = Math.abs(partidosTotal - sumaLocalVisitante) / 2;
    const unaJornada = total.foto.rows.length / 2;
    if (diferenciaEnPartidos <= unaJornada) {
      console.warn(`[standings] competition_id ${competitionId} ${fase} no cuadra: ${numeros} (se guarda igual)`);
      continue;
    }
    descartarLocalVisitante.add(`${season_num}|${stage_num}`);
    sinTabla += TIPOS_STANDINGS.length - 1;
    descartadas.push(`local y visitante no cuadran con la total (${numeros}, mas de una jornada) en ${fase}: no se guardan`);
  }
  const guardables = candidatas.filter(
    (c) =>
      !sinPareja.has(c.foto) &&
      (c.foto.type === TIPO_TOTAL || !descartarLocalVisitante.has(`${c.foto.season_num}|${c.foto.stage_num}`)),
  );

  const idsUltimas = guardables.flatMap((c) => (c.ultima ? [c.ultima.id] : []));
  const filasUltimas = new Map((await obtenerFilasDeFotos(idsUltimas)).map((f) => [f.id, f.rows]));

  const nuevas = guardables.filter(({ foto, ultima }) => {
    // Sin partidos jugados (pretemporada) no se escribe nada
    if (!foto.rows.some((f) => f.partidos > 0)) return false;
    if (!ultima || ultima.vigente_al_capturar !== foto.vigente_al_capturar) return true;
    const previas = filasUltimas.get(ultima.id);
    return previas === undefined || !filasIguales(foto.rows, previas);
  });

  await upsertFotosStandings(nuevas.map((c) => c.foto));

  for (const { foto, ultima } of nuevas) {
    const previa = ultima && { rows: filasUltimas.get(ultima.id), vigente_al_capturar: ultima.vigente_al_capturar };
    console.log(
      `[standings] competition_id ${competitionId} seasonNum ${foto.season_num} stageNum ${foto.stage_num} ` +
        `type ${foto.type} foto nueva: ${describirCambios(foto, previa)}`,
    );
  }

  return {
    fotos_nuevas: nuevas.length,
    sin_cambios: guardables.length - nuevas.length,
    sin_tabla: sinTabla,
    en_juego: enJuego,
    avisos,
    descartadas,
  };
}

/**
 * Fotografia las ligas activas con partidos entre hace DIAS_STANDINGS_ATRAS y dentro de DIAS_STANDINGS dias;
 * una liga que falla se reporta en `errores` sin cortar las demas
 */
export async function sincronizarTodasStandings(pausa: Pausa = pausaAleatoria): Promise<RespuestaSyncStandings> {
  const inicio = Date.now();
  const fecha = hoyBogota();
  const activas = await obtenerCompetitionIdsActivas();
  const conPartidos = await obtenerCompetitionIdsConPartidos(
    ahoraMasDiasIsoBogota(-DIAS_STANDINGS_ATRAS),
    ahoraMasDiasIsoBogota(DIAS_STANDINGS),
  );
  const competitionIds = activas.filter((id) => conPartidos.has(id));
  const totalLotes = Math.ceil(competitionIds.length / CONCURRENCIA_MAX);
  console.log(
    `[standings] Inicio: ${competitionIds.length} de ${activas.length} ligas activas con partidos ` +
      `(-${DIAS_STANDINGS_ATRAS}/+${DIAS_STANDINGS} dias) en ${totalLotes} lotes (fecha ${fecha})`,
  );

  let fotosNuevas = 0;
  let sinCambios = 0;
  let sinTabla = 0;
  let enJuego = 0;
  const errores: ErrorSync[] = [];

  for (let i = 0; i < competitionIds.length; i += CONCURRENCIA_MAX) {
    const lote = competitionIds.slice(i, i + CONCURRENCIA_MAX);
    const resultados = await Promise.allSettled(
      lote.map((id) => sincronizarStandingsCompeticion(id, fecha, pausa)),
    );

    resultados.forEach((resultado, j) => {
      if (resultado.status === "fulfilled") {
        fotosNuevas += resultado.value.fotos_nuevas;
        sinCambios += resultado.value.sin_cambios;
        sinTabla += resultado.value.sin_tabla;
        enJuego += resultado.value.en_juego;
        for (const aviso of resultado.value.descartadas) {
          console.warn(`[standings] competition_id ${lote[j]} sin tabla: ${aviso}`);
        }
        for (const motivo of resultado.value.avisos) {
          console.warn(`[standings] competition_id ${lote[j]}: ${motivo}`);
          errores.push({ competition_id: lote[j], motivo });
        }
        return;
      }
      const motivo = describirFallo(resultado.reason);
      console.error(`[standings] competition_id ${lote[j]} fallo: ${motivo}`);
      errores.push({ competition_id: lote[j], motivo });
    });

    const procesadas = i + lote.length;
    const numeroLote = i / CONCURRENCIA_MAX + 1;
    if (numeroLote % LOTES_POR_LOG_STANDINGS === 0) {
      console.log(
        `[standings] Lote ${numeroLote}/${totalLotes} terminado (${procesadas}/${competitionIds.length} ligas)`,
      );
    }

    if (procesadas < competitionIds.length) {
      await pausa();
    }
  }

  const duracion = Number(((Date.now() - inicio) / 1000).toFixed(1));
  console.log(
    `[standings] Fin: ${competitionIds.length} ligas, ${fotosNuevas} fotos nuevas, ${sinCambios} sin cambios, ` +
      `${sinTabla} sin tabla, ${enJuego} en juego, ${errores.length} errores en ${duracion.toFixed(1)} s`,
  );

  return {
    ligas: competitionIds.length,
    en_juego: enJuego,
    fotos_nuevas: fotosNuevas,
    sin_cambios: sinCambios,
    sin_tabla: sinTabla,
    errores,
    duracion_s: duracion,
  };
}
