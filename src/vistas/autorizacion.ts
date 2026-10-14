/** Auth de las rutas de consulta (/buscar-partido, /equivalencias) */

import type { FastifyRequest } from "fastify";
import { ErrorApp } from "../utilidades/errores.js";

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
