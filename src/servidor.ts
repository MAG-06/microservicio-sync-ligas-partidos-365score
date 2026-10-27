/** Configuracion del servidor Fastify */

import Fastify from "fastify";
import { ZodError } from "zod";
import { CORS_ORIGEN } from "./config.js";
import { ErrorApp } from "./utilidades/errores.js";
import {
  ErrorLigaNoMapeada,
  ErrorPartidoNoEncontrado,
  ErrorPartidoAmbiguo,
} from "./vistas-modelo/buscar-partido.vm.js";
import { ErrorRespuesta365Invalida } from "./vistas-modelo/sync.vm.js";
import { ErrorAPI365 } from "./modelos/api-365.js";
import { ErrorSupabase } from "./modelos/supabase.js";
import { rutasSync } from "./vistas/rutas-sync.js";
import { rutasStandings } from "./vistas/rutas-standings.js";
import { rutasBuscar } from "./vistas/rutas-buscar.js";
import { rutasEquivalencias } from "./vistas/rutas-equivalencias.js";
import { rutasSalud } from "./vistas/rutas-salud.js";

export function crearServidor() {
  const corsOrigen = process.env.CORS_ORIGEN ?? CORS_ORIGEN;

  const app = Fastify({
    logger: false,
    bodyLimit: 10_000,
  });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const texto = (body as string).trim();
    if (texto === "") return done(null, undefined);
    try {
      done(null, JSON.parse(texto));
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      e.statusCode = 400;
      e.message = "El cuerpo de la petición no es un JSON válido";
      done(e, undefined);
    }
  });

  app.addHook("onSend", async (_peticion, respuesta) => {
    respuesta.header("Access-Control-Allow-Origin", corsOrigen);
    respuesta.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    respuesta.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  });

  app.options("/*", async (_peticion, respuesta) => {
    return respuesta.status(204).send();
  });

  app.setErrorHandler<Error>((error, peticion, respuesta) => {
    if (error instanceof ZodError) {
      return respuesta.status(400).send({
        error: { codigo: "VALIDACION", mensaje: "Parámetros inválidos", detalles: error.issues },
      });
    }
    // Cualquier 4xx propio de Fastify (JSON inválido, tipo de contenido, tamaño…) se uniforma como VALIDACION.
    const statusCode = (error as unknown as Record<string, unknown>).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      // Solo metodo, URL, status y mensaje: nunca cuerpo ni headers (pueden traer el token).
      console.warn(`${peticion.method} ${peticion.url} ${statusCode}: ${error.message}`);
      return respuesta.status(400).send({
        error: { codigo: "VALIDACION", mensaje: "El cuerpo de la petición no es un JSON válido" },
      });
    }
    if (error instanceof ErrorApp) {
      const cuerpo: Record<string, unknown> = { codigo: error.codigo, mensaje: error.mensaje };
      if (error.extras) Object.assign(cuerpo, error.extras);
      return respuesta.status(error.httpStatus).send({ error: cuerpo });
    }
    if (error instanceof ErrorLigaNoMapeada) {
      return respuesta.status(404).send({
        error: { codigo: "LIGA_NO_MAPEADA", mensaje: error.message },
      });
    }
    if (error instanceof ErrorPartidoNoEncontrado) {
      return respuesta.status(404).send({
        error: { codigo: "PARTIDO_NO_ENCONTRADO", mensaje: "Partido no encontrado" },
      });
    }
    if (error instanceof ErrorPartidoAmbiguo) {
      return respuesta.status(409).send({
        error: { codigo: "PARTIDO_AMBIGUO", mensaje: "Múltiples candidatos ambiguos", candidatos: error.candidatos },
      });
    }
    if (
      error instanceof ErrorAPI365 ||
      error instanceof ErrorSupabase ||
      error instanceof ErrorRespuesta365Invalida
    ) {
      console.error(`${peticion.method} ${peticion.url}`, error);
      return respuesta.status(502).send({
        error: { codigo: "STATS_NO_DISPONIBLE", mensaje: "Servicio de estadísticas no disponible" },
      });
    }
    console.error(`${peticion.method} ${peticion.url}`, error);
    return respuesta.status(500).send({
      error: { codigo: "ERROR_INTERNO", mensaje: "Error interno del servidor" },
    });
  });

  app.setNotFoundHandler((_peticion, respuesta) => {
    return respuesta.status(404).send({
      error: { codigo: "RUTA_NO_ENCONTRADA", mensaje: "Ruta no encontrada" },
    });
  });

  app.register(rutasSync);
  app.register(rutasStandings);
  app.register(rutasBuscar);
  app.register(rutasEquivalencias);
  app.register(rutasSalud);

  return app;
}
