/** Tests de match de nombres con alias y prefijos */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nombresCoinciden, palabrasCoinciden, palabrasNormalizadas } from "../src/utilidades/nombres.js";

describe("palabrasCoinciden", () => {
  // Test 1 — mismas palabras
  it("coincide con palabras identicas", () => {
    assert.ok(palabrasCoinciden(["atletico", "nacional"], ["atletico", "nacional"]));
  });

  // Test 2 — prefijo de 3+ letras
  it("coincide por prefijo de 3 letras", () => {
    assert.ok(palabrasCoinciden(["atl", "nacional"], ["atletico", "nacional"]));
  });

  // Test 3 — prefijo de 2 letras no coincide
  it("no coincide por prefijo de menos de 3 letras", () => {
    assert.ok(!palabrasCoinciden(["at", "nacional"], ["atletico", "nacional"]));
  });

  // Test 4 — subconjunto de palabras del nombre largo
  it("coincide cuando el corto es subconjunto del largo", () => {
    assert.ok(palabrasCoinciden(["santa", "fe"], ["independiente", "santa", "fe"]));
  });

  // Test 5 — palabra exacta corta (2 letras) coincide por igualdad
  it("palabra de 2 letras coincide por igualdad exacta", () => {
    assert.ok(palabrasCoinciden(["santa", "fe"], ["santa", "fe"]));
  });

  // Test 6 — sin coincidencia
  it("no coincide con palabras totalmente distintas", () => {
    assert.ok(!palabrasCoinciden(["tolima"], ["nacional"]));
  });
});

describe("nombresCoinciden", () => {
  // Test 7 — coincidencia exacta normalizada
  it("coincide por nombre exacto normalizado", () => {
    assert.ok(nombresCoinciden("Atlético Nacional", "Atlético Nacional", []));
  });

  // Test 8 — coincide sin tildes
  it("coincide ignorando tildes", () => {
    assert.ok(nombresCoinciden("Atletico Nacional", "Atlético Nacional", []));
  });

  // Test 9 — coincide sin sufijo FC
  it("coincide ignorando sufijo FC", () => {
    assert.ok(nombresCoinciden("Millonarios", "Millonarios FC", []));
  });

  // Test 10 — coincide por alias
  it("coincide por alias del equipo", () => {
    assert.ok(nombresCoinciden("Nacional", "Atlético Nacional", ["Nacional", "Verdolaga"]));
  });

  // Test 11 — coincide por alias con tildes
  it("coincide por alias ignorando tildes", () => {
    assert.ok(nombresCoinciden("America", "América de Cali", ["America"]));
  });

  // Test 12 — no coincide con nombre distinto
  it("no coincide con nombre diferente", () => {
    assert.ok(!nombresCoinciden("Deportivo Cali", "América de Cali", []));
  });

  // Test 13 — no coincide con alias distinto
  it("no coincide con alias diferente", () => {
    assert.ok(!nombresCoinciden("Tolima", "Atlético Nacional", ["Verdolaga", "Nacional"]));
  });

  // Test 14 — "Santa Fe" vs "Independiente Santa Fe" por palabras
  it("coincide Santa Fe con Independiente Santa Fe por palabras", () => {
    assert.ok(nombresCoinciden("Santa Fe", "Independiente Santa Fe", []));
  });

  // Test 15 — "Atl. Nacional" por prefijo
  it("coincide Atl. Nacional con Atletico Nacional por prefijo", () => {
    assert.ok(nombresCoinciden("Atl. Nacional", "Atlético Nacional", []));
  });

  // Test 16 — "Dep. Cali" por prefijo
  it("coincide Dep. Cali con Deportivo Cali por prefijo", () => {
    assert.ok(nombresCoinciden("Dep. Cali", "Deportivo Cali", []));
  });

  // Test 17 — prefijo de 2 letras no coincide
  it("no coincide con prefijo de menos de 3 letras", () => {
    assert.ok(!nombresCoinciden("At Nacional", "Atlético Nacional", []));
  });

  // Test 18 — caso ambiguo: un nombre parcial que podria coincidir con multiples
  it("no coincide si una palabra no tiene par en el otro nombre", () => {
    assert.ok(!nombresCoinciden("Deportes Tolima", "Deportivo Cali", []));
  });
});
