/** Cliente HTTP para la API de 365Scores */

import {
  BASE_API_365,
  PARAMETROS_COMUNES,
  ENCABEZADOS_365,
  TIMEOUT_API_MS,
  INTENTOS_API,
} from "../config.js";

const CODIGOS_REINTENTABLES = new Set([429, 500, 502, 503, 504]);

export class ErrorAPI365 extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ErrorAPI365";
  }
}

export async function pedirJson365<T>(ruta: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(ruta, BASE_API_365);
  for (const [k, v] of Object.entries({ ...PARAMETROS_COMUNES, ...params })) {
    url.searchParams.set(k, v);
  }

  let ultimoError: Error | null = null;

  for (let intento = 1; intento <= INTENTOS_API; intento++) {
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_API_MS);

    try {
      const resp = await fetch(url.toString(), {
        headers: ENCABEZADOS_365,
        signal: controlador.signal,
      });

      if (!resp.ok) {
        if (!CODIGOS_REINTENTABLES.has(resp.status)) {
          throw new ErrorAPI365(`365Scores ${resp.status}: ${resp.statusText}`, resp.status);
        }
        ultimoError = new ErrorAPI365(`365Scores ${resp.status}`, resp.status);
        if (intento < INTENTOS_API) {
          await new Promise((r) => setTimeout(r, 2_000 * intento));
          continue;
        }
        throw ultimoError;
      }

      return (await resp.json()) as T;
    } catch (error) {
      if (error instanceof ErrorAPI365) throw error;
      ultimoError = error instanceof Error ? error : new Error(String(error));
      if (intento < INTENTOS_API) {
        await new Promise((r) => setTimeout(r, 2_000 * intento));
        continue;
      }
    } finally {
      clearTimeout(temporizador);
    }
  }

  throw new ErrorAPI365(`365Scores fallo despues de ${INTENTOS_API} intentos: ${ultimoError?.message}`);
}

export async function pedirPartidosActuales(competitionId: number): Promise<unknown> {
  return pedirJson365("/web/games/current/", {
    competitions: String(competitionId),
    topBookmaker: "4",
  });
}
