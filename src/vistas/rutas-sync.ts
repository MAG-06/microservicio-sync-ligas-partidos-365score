/** Ruta POST /api/sync — sincroniza partidos de todas las ligas activas */

import type { FastifyInstance } from "fastify";
import { sincronizarTodas } from "../vistas-modelo/sync.vm.js";
import { exigirSyncToken } from "./autorizacion.js";

export async function rutasSync(app: FastifyInstance): Promise<void> {
  app.post("/api/sync", async (peticion) => {
    exigirSyncToken(peticion);

    return await sincronizarTodas();
  });
}
