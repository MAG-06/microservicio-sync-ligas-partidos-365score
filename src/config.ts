/** Configuracion centralizada del microservicio sync-ligas-partidos-365score */

// --- API de 365Scores ---

export const BASE_API_365 = "https://webws.365scores.com";

export const PARAMETROS_COMUNES: Record<string, string> = {
  appTypeId: "5",
  langId: "29",
  timezoneName: "America/Bogota",
  userCountryId: "109",
};

export const ENCABEZADOS_365: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "es-CO,es;q=0.9",
  Origin: "https://www.365scores.com",
  Referer: "https://www.365scores.com/",
};

export const TIMEOUT_API_MS = 20_000;
export const INTENTOS_API = 3;
export const PAUSA_MIN_MS = 1_000;
export const PAUSA_MAX_MS = 2_000;
export const CONCURRENCIA_MAX = 2;

// --- Servidor ---

export const PUERTO_POR_DEFECTO = 8003;
export const HOST_POR_DEFECTO = "127.0.0.1";
export const CORS_ORIGEN = "*";

// --- Zona horaria ---

export const ZONA_BOGOTA = "America/Bogota";

// --- Supabase (tablas) ---

export const TABLA_EQUIVALENCIAS = "equivalencias_liga";
export const TABLA_PARTIDOS = "partidos_programados_365";
export const TABLA_EQUIPOS = "equipos_365";
export const TABLA_STANDINGS = "standings_365";

/** Filas por pagina al listar via PostgREST (el max-rows por defecto de Supabase) */
export const FILAS_POR_PAGINA_SUPABASE = 1000;

// --- Reglas de negocio ---

export const HORAS_SINCRONIZACION_STALE = 3;
export const DIAS_TOLERANCIA_FECHA = 3;

// --- Standings (POST /api/sync-standings) ---
// ⚠️ FASES_REGULARES y TEMPORADA_ANTERIOR hay que actualizarlos cuando cambia la temporada de una liga
// (Liga BetPlay 620 y Torneo BetPlay 5080 en enero; Premier 7 en agosto). Los numeros salen de /web/standings/:
// el seasonNum de competitions[0].currentSeasonNum y el stageNum de cada fase de competitions[0].seasons[].stages[]
// (solo trae las fases de la temporada actual; las de una pasada, de standings[0].stageNum al pedirla).

/** `type` de /web/standings/: 1 tabla total, 2 solo local, 3 solo visitante */
export const TIPOS_STANDINGS = [1, 2, 3] as const;

/** Solo se fotografian las ligas activas con algun partido en partidos_programados_365 en los proximos N dias... */
export const DIAS_STANDINGS = 7;
/** ...o en los ultimos N dias (el sync corre a las 2 a. m.: asi entra la tabla final tras la ultima fecha, aunque falle una corrida) */
export const DIAS_STANDINGS_ATRAS = 2;

/**
 * Ligas con varias fases: competition_id → seasonNum → stageNum de liga regular que se guardan
 * (sin playoffs, Reclasificacion ni Promedios). Las ligas que no estan aqui se tratan como de una fase:
 * se piden sin stageNum y se guarda el que devuelva 365.
 * Si la temporada actual de una liga de aqui no esta en su mapa, se guarda solo la fase actual y se avisa en `errores`.
 */
export const FASES_REGULARES: Record<number, Record<number, number[]>> = {
  // Liga BetPlay: 2026 = Apertura 3 y Clausura 7; 2025 = Apertura 3 y Finalizacion 6
  620: { 130: [3, 7], 127: [3, 6] },
  // Torneo BetPlay (Primera B): 2026 = Apertura 2 y Finalizacion 5; 2025 = Apertura 2 y Finalizacion 5
  // (sin stageNum, 2025 devuelve la Tabla Anual, que no trae local/visitante)
  5080: { 53: [2, 5], 50: [2, 5] },
};

/**
 * seasonNum de la temporada anterior por competition_id (los seasonNum no son consecutivos:
 * en BetPlay la anterior a 130 es 127). Si una liga no esta aqui se busca hacia atras.
 */
export const TEMPORADA_ANTERIOR: Record<number, number> = {
  7: 131, // Premier League 2025/26
  620: 127, // Liga BetPlay 2025
  5080: 50, // Torneo BetPlay 2025 (51 y 52 vienen vacias)
};

/** Liga sin TEMPORADA_ANTERIOR: cuantas temporadas hacia atras probar (seasonNum - 1 ... - N) */
export const SALTOS_BUSQUEDA_TEMPORADA_ANTERIOR = 3;

/** El progreso se loguea cada N lotes (en Render sirve de latido en una corrida de 10–16 min) */
export const LOTES_POR_LOG_STANDINGS = 10;

// --- Sufijos comunes para normalizar nombres de equipos ---

export const SUFIJOS_EQUIPO = [
  "fc", "cf", "club", "sc", "ac", "cd", "ud", "sd", "united",
];
