/** Ruta POST /api/sync — sincroniza partidos de todas las ligas activas */

import type { FastifyInstance } from "fastify";
import { ErrorApp } from "../utilidades/errores.js";
import { sincronizarTodas } from "../vistas-modelo/sync.vm.js";

export async function rutasSync(app: FastifyInstance): Promise<void> {
  app.post("/api/sync", async (peticion) => {
    const token = process.env.SYNC_TOKEN ?? "";
    const auth = peticion.headers.authorization ?? "";

    if (!token || auth !== `Bearer ${token}`) {
      throw new ErrorApp("NO_AUTORIZADO", 401, "No autorizado");
    }

    return await sincronizarTodas();
  });
}
