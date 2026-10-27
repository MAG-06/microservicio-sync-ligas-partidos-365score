/** Interfaces de dominio del microservicio */

// --- Registros de Supabase ---

export interface EquivalenciaLigaDB {
  id: number;
  casa: string;
  liga_casa_id: string;
  competition_id_365: number;
  activa: boolean;
  ultima_sincronizacion: string | null;
}

export interface PartidoProgramadoDB {
  game_id: number;
  competition_id: number;
  fecha_hora: string;
  estado: string;
  ronda: number | null;
  local_id: number;
  local_nombre: string;
  visitante_id: number;
  visitante_nombre: string;
  actualizado_en: string;
}

export interface Equipo365DB {
  id: number;
  nombre: string;
  alias: string[];
}

/** Fila recortada de un standing de 365 (lo que se guarda en standings_365.rows) */
export interface FilaStanding {
  equipo_id: number;
  nombre: string;
  posicion: number;
  partidos: number;
  ganados: number;
  empatados: number;
  perdidos: number;
  gf: number;
  gc: number;
  puntos: number;
  /** groupNum de 365 (conferencia/grupo; `posicion` es dentro de el); null si la tabla no tiene grupos */
  grupo: number | null;
}

export interface FotoStandingDB {
  competition_id: number;
  season_num: number;
  stage_num: number;
  /** 1 total, 2 local, 3 visitante */
  type: number;
  /** YYYY-MM-DD en Bogota */
  fecha: string;
  rows: FilaStanding[];
  /** Si esa temporada/fase era la actual de 365 al tomar la foto */
  vigente_al_capturar: boolean;
  actualizado_en: string;
}

/** Una foto guardada sin sus filas (para decidir que pedir y contra que comparar) */
export type MetaFotoStandingDB = Pick<
  FotoStandingDB,
  "season_num" | "stage_num" | "type" | "fecha" | "vigente_al_capturar"
> & { id: number };

// --- Respuestas de los endpoints ---

export interface ErrorSync {
  competition_id: number;
  motivo: string;
}

export interface RespuestaSync {
  /** Competiciones intentadas (incluye las que fallaron) */
  ligas: number;
  /** Partidos guardados de las competiciones que se sincronizaron bien */
  partidos: number;
  /** Una entrada por competicion que fallo; las demas se sincronizan igual */
  errores: ErrorSync[];
}

export interface RespuestaSyncStandings {
  /** Competiciones intentadas: activas con partidos en la ventana de dias (incluye las que fallaron) */
  ligas: number;
  /** Fotos escritas (filas o vigencia distintas a la ultima foto de su clave) */
  fotos_nuevas: number;
  /** Tablas pedidas a 365 que no generaron foto (iguales a la ultima o sin partidos jugados) */
  sin_cambios: number;
  /** Consultas a 365 sin tabla (liga/fase sin standings) o sin split local/visitante para ese type; no son error */
  sin_tabla: number;
  /** Fases vigentes que no se escribieron porque tenian un partido en vivo (entran en la siguiente corrida) */
  en_juego: number;
  /** Segundos que tardo el sync completo */
  duracion_s: number;
  /** Ligas que fallaron, consultas descartadas (fase cambiada…) y avisos de config; puede haber varias por liga */
  errores: ErrorSync[];
}

export interface RespuestaBuscarPartido {
  game_id: number;
  competition_id: number;
  fecha_hora: string;
  local: string;
  visitante: string;
  fecha_difiere: boolean;
  /** fecha_hora de 365Scores menos la hora de referencia (inicio, o mediodia de fecha); solo si fecha_difiere */
  diferencia_minutos?: number;
}

export interface EquivalenciaCasa {
  /** Siempre string, tal cual la columna (conserva ceros a la izquierda) */
  liga_casa_id: string;
  competition_id_365: number;
}

export interface RespuestaEquivalencias {
  casa: string;
  total: number;
  equivalencias: EquivalenciaCasa[];
}
