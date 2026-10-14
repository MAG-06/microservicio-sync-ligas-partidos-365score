/** Ruta GET /buscar-partido — busca un partido por casa, liga, fecha y equipos */

import type { FastifyInstance } from "fastify";
import { esquemaQueryBuscar } from "../esquemas/validacion.js";
import { buscarPartido } from "../vistas-modelo/buscar-partido.vm.js";
import { exigirApiToken } from "./autorizacion.js";

export async function rutasBuscar(app: FastifyInstance): Promise<void> {
  app.get("/buscar-partido", async (peticion) => {
    exigirApiToken(peticion);

    const { casa, liga_casa_id, fecha, local, visitante, inicio } = esquemaQueryBuscar.parse(peticion.query);
    return await buscarPartido(casa, liga_casa_id, fecha, local, visitante, inicio);
  });
}
