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

/** Filas por pagina al listar via PostgREST (el max-rows por defecto de Supabase) */
export const FILAS_POR_PAGINA_SUPABASE = 1000;

// --- Reglas de negocio ---

export const HORAS_SINCRONIZACION_STALE = 3;
export const DIAS_TOLERANCIA_FECHA = 3;

// --- Sufijos comunes para normalizar nombres de equipos ---

export const SUFIJOS_EQUIPO = [
  "fc", "cf", "club", "sc", "ac", "cd", "ud", "sd", "united",
];
