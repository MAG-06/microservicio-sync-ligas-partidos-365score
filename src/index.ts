/** Punto de entrada del microservicio sync-ligas-partidos-365score */

import "dotenv/config";
import { crearServidor } from "./servidor.js";
import { HOST_POR_DEFECTO, PUERTO_POR_DEFECTO } from "./config.js";

const servidor = crearServidor();
const puerto = Number(process.env.PUERTO) || PUERTO_POR_DEFECTO;
const host = process.env.HOST ?? HOST_POR_DEFECTO;

servidor.listen({ port: puerto, host }, (error, direccion) => {
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(`Servidor listo en ${direccion} (Ctrl+C para parar)`);
});
