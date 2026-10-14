/** Ruta GET /equivalencias — ligas de una casa con equivalencia activa en 365Scores */

import type { FastifyInstance } from "fastify";
import { esquemaQueryEquivalencias } from "../esquemas/validacion.js";
import { listarEquivalencias } from "../vistas-modelo/equivalencias.vm.js";
import { exigirApiToken } from "./autorizacion.js";

export async function rutasEquivalencias(app: FastifyInstance): Promise<void> {
  app.get("/equivalencias", async (peticion) => {
    exigirApiToken(peticion);

    const { casa } = esquemaQueryEquivalencias.parse(peticion.query);
    return await listarEquivalencias(casa);
  });
}
