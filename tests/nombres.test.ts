/** Tests de normalizacion de nombres de equipos */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizarNombre } from "../src/utilidades/nombres.js";

describe("normalizarNombre", () => {
  // Test 1 — minusculas y sin tildes
  it("convierte a minusculas sin tildes", () => {
    assert.equal(normalizarNombre("Atlético Nacional"), "atletico nacional");
  });

  // Test 2 — elimina tildes
  it("elimina tildes y diacriticos", () => {
    assert.equal(normalizarNombre("América de Cali"), "america de cali");
  });

  // Test 3 — elimina signos
  it("elimina signos de puntuacion", () => {
    assert.equal(normalizarNombre("Dep. La Coruña"), "dep la coruna");
  });

  // Test 4 — elimina sufijo FC
  it("elimina sufijo FC", () => {
    assert.equal(normalizarNombre("Millonarios FC"), "millonarios");
  });

  // Test 5 — elimina sufijo Club
  it("elimina sufijo Club", () => {
    assert.equal(normalizarNombre("Club Deportivo Pasto"), "deportivo pasto");
  });

  // Test 6 — elimina multiples sufijos
  it("elimina multiples sufijos pero conserva palabras significativas", () => {
    assert.equal(normalizarNombre("Real Sporting CF"), "real sporting");
  });

  // Test 7 — nombre sin sufijos queda igual
  it("preserva nombres sin sufijos", () => {
    assert.equal(normalizarNombre("Envigado"), "envigado");
  });

  // Test 8 — espacios multiples
  it("colapsa espacios multiples", () => {
    assert.equal(normalizarNombre("  Junior   de  Barranquilla  "), "junior de barranquilla");
  });
});
