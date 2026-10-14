/** Tests de mapeo de estado desde statusGroup */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapearEstado } from "../src/vistas-modelo/estado.js";

describe("mapearEstado", () => {
  // Test 1 — statusGroup 2 es programado
  it("statusGroup 2 devuelve programado", () => {
    assert.equal(mapearEstado(2, "Scheduled"), "programado");
  });

  // Test 2 — statusGroup 4 es finalizado
  it("statusGroup 4 devuelve finalizado", () => {
    assert.equal(mapearEstado(4, "Ended"), "finalizado");
  });

  // Test 3 — otro statusGroup usa statusText en minusculas
  it("statusGroup 3 devuelve statusText en minusculas", () => {
    assert.equal(mapearEstado(3, "Half Time"), "half time");
  });

  // Test 4 — statusGroup 1 (en juego)
  it("statusGroup 1 devuelve statusText en minusculas", () => {
    assert.equal(mapearEstado(1, "In Progress"), "in progress");
  });

  // Test 5 — statusGroup desconocido
  it("statusGroup desconocido devuelve statusText en minusculas", () => {
    assert.equal(mapearEstado(99, "Postponed"), "postponed");
  });
});
