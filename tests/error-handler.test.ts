/** Tests del manejador central de errores: JSON mal formado, cuerpo vacio, error interno, log de 4xx */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { crearServidor } from "../src/servidor.js";
import type { FastifyInstance } from "fastify";

process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_KEY = "test-key";
process.env.SYNC_TOKEN = "test-sync-token";

const AUTH = { authorization: "Bearer test-sync-token" };

/** Ejecuta `fn` capturando console.warn; devuelve lo que se logueo */
async function capturarWarn(fn: () => Promise<unknown>): Promise<string[]> {
  const original = console.warn;
  const lineas: string[] = [];
  console.warn = (...args: unknown[]) => { lineas.push(args.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lineas;
}

describe("manejador de errores: JSON mal formado", () => {
  let app: FastifyInstance;
  before(async () => { app = crearServidor(); await app.ready(); });
  after(() => app.close());

  it("POST con JSON mal formado devuelve 400 VALIDACION", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: "{malo",
    });
    assert.equal(resp.statusCode, 400);
    const body = JSON.parse(resp.body);
    assert.equal(body.error.codigo, "VALIDACION");
    assert.equal(body.error.mensaje, "El cuerpo de la petición no es un JSON válido");
  });

  it("loguea con console.warn metodo, URL, status y mensaje, sin cuerpo ni headers", async () => {
    const lineas = await capturarWarn(() => app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: "{malo",
    }));
    assert.deepEqual(lineas, ["POST /api/sync 400: El cuerpo de la petición no es un JSON válido"]);
  });
});

describe("manejador de errores: cualquier 4xx de Fastify", () => {
  let app: FastifyInstance;
  before(async () => { app = crearServidor(); await app.ready(); });
  after(() => app.close());

  it("POST con Content-Type no soportado (415 de Fastify) devuelve 400 VALIDACION", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { ...AUTH, "content-type": "text/xml" },
      payload: "<sync/>",
    });
    assert.equal(resp.statusCode, 400);
    const body = JSON.parse(resp.body);
    assert.equal(body.error.codigo, "VALIDACION");
    assert.equal(body.error.mensaje, "El cuerpo de la petición no es un JSON válido");
  });

  it("loguea el statusCode original de Fastify (415) con console.warn, sin cuerpo ni token", async () => {
    const lineas = await capturarWarn(() => app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { ...AUTH, "content-type": "text/xml" },
      payload: "<sync/>",
    }));
    assert.equal(lineas.length, 1);
    assert.match(lineas[0], /^POST \/api\/sync 415: /);
    assert.ok(!lineas[0].includes("<sync/>"), "No debe loguear el cuerpo");
    assert.ok(!lineas[0].includes("test-sync-token"), "No debe loguear headers");
  });

  it("los 4xx que no son de Fastify (401, VALIDACION de Zod) no pasan por console.warn", async () => {
    const lineas = await capturarWarn(async () => {
      await app.inject({ method: "POST", url: "/api/sync" });
      await app.inject({ method: "GET", url: "/buscar-partido" });
    });
    assert.deepEqual(lineas, []);
  });
});

describe("manejador de errores: ruta no encontrada", () => {
  let app: FastifyInstance;
  before(async () => { app = crearServidor(); await app.ready(); });
  after(() => app.close());

  it("GET a ruta inexistente devuelve 404 RUTA_NO_ENCONTRADA", async () => {
    const resp = await app.inject({ method: "GET", url: "/ruta-que-no-existe" });
    assert.equal(resp.statusCode, 404);
    const body = JSON.parse(resp.body);
    assert.equal(body.error.codigo, "RUTA_NO_ENCONTRADA");
    assert.equal(body.error.mensaje, "Ruta no encontrada");
  });
});

describe("manejador de errores: cuerpo vacio con content-type JSON", () => {
  let app: FastifyInstance;
  before(async () => { app = crearServidor(); await app.ready(); });
  after(() => app.close());

  it("POST con cuerpo vacio y content-type JSON no falla", async () => {
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("equivalencias_liga")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;

    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/sync",
        headers: { ...AUTH, "content-type": "application/json" },
        payload: "",
      });
      assert.notEqual(resp.statusCode, 500, "No debe devolver 500 por cuerpo vacio");
      assert.notEqual(resp.statusCode, 400, "No debe devolver 400 por cuerpo vacio");
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });
});

describe("manejador de errores: error interno generico", () => {
  let app: FastifyInstance;
  let logSpy: string[] = [];
  const originalError = console.error;

  before(async () => {
    app = crearServidor();
    app.get("/test-error-interno", async () => {
      throw new TypeError("algo salio muy mal internamente");
    });
    await app.ready();
  });
  after(() => { console.error = originalError; app.close(); });

  it("error inesperado loguea metodo y url sin filtrar mensaje al cliente", async () => {
    logSpy = [];
    console.error = (...args: unknown[]) => { logSpy.push(args.map(String).join(" ")); };

    try {
      const resp = await app.inject({ method: "GET", url: "/test-error-interno" });
      assert.equal(resp.statusCode, 500);
      const body = JSON.parse(resp.body);
      assert.equal(body.error.codigo, "ERROR_INTERNO");
      assert.equal(body.error.mensaje, "Error interno del servidor");
      assert.ok(!body.error.mensaje.includes("algo salio"), "No debe filtrar mensaje interno");

      assert.ok(logSpy.length > 0, "Debe loguear el error");
      const logLine = logSpy.join(" ");
      assert.ok(logLine.includes("GET"), "Log debe incluir metodo");
      assert.ok(logLine.includes("/test-error-interno"), "Log debe incluir url");
    } finally {
      console.error = originalError;
    }
  });
});
