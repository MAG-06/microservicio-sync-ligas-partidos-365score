/** Ruta GET /salud — health check */

import type { FastifyInstance } from "fastify";

export async function rutasSalud(app: FastifyInstance): Promise<void> {
  app.get("/salud", async (_peticion, respuesta) => {
    return respuesta.status(200).send({ estado: "ok" });
  });
}
