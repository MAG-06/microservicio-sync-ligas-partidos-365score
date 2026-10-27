/** Auth de las rutas: SYNC_TOKEN para las de sincronizacion, API_TOKEN para las de consulta (/buscar-partido, /equivalencias) */

import type { FastifyRequest } from "fastify";
import { ErrorApp } from "../utilidades/errores.js";

/** Exige `Authorization: Bearer <SYNC_TOKEN>`; sin SYNC_TOKEN definido siempre es 401 */
export function exigirSyncToken(peticion: FastifyRequest): void {
  const token = process.env.SYNC_TOKEN ?? "";
  const auth = peticion.headers.authorization ?? "";

  if (!token || auth !== `Bearer ${token}`) {
    throw new ErrorApp("NO_AUTORIZADO", 401, "No autorizado");
  }
}

/** Si API_TOKEN esta definido exige `Authorization: Bearer <API_TOKEN>`; si no, la ruta es publica */
export function exigirApiToken(peticion: FastifyRequest): void {
  const apiToken = process.env.API_TOKEN;
  if (apiToken) {
    const auth = peticion.headers.authorization ?? "";
    if (auth !== `Bearer ${apiToken}`) {
      throw new ErrorApp("NO_AUTORIZADO", 401, "No autorizado");
    }
  }
}
