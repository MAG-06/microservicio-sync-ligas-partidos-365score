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

// --- Respuestas de los endpoints ---

export interface RespuestaSync {
  ligas: number;
  partidos: number;
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
