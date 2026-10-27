/** Ruta POST /api/sync-standings — guarda la foto del dia de los standings de todas las ligas activas */

import type { FastifyInstance } from "fastify";
import { ErrorApp } from "../utilidades/errores.js";
import { sincronizarTodasStandings } from "../vistas-modelo/standings.vm.js";
import { exigirSyncToken } from "./autorizacion.js";

/** Una corrida a la vez (workflow + corrida manual): Render corre una sola instancia, asi que basta un flag en memoria */
let enCurso = false;

export async function rutasStandings(app: FastifyInstance): Promise<void> {
  app.post("/api/sync-standings", async (peticion) => {
    exigirSyncToken(peticion);
    if (enCurso) throw new ErrorApp("SYNC_EN_CURSO", 409, "Ya hay un sync de standings en curso");

    enCurso = true;
    try {
      return await sincronizarTodasStandings();
    } finally {
      enCurso = false;
    }
  });
}
