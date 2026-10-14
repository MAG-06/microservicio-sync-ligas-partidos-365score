/** Tests de filtro por fecha en zona Bogota */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inicioDelDiaBogota, finDelDiaBogota, fechaEnZonaBogota } from "../src/utilidades/fecha.js";

describe("filtro por fecha zona Bogota", () => {
  // Test 1 — inicio del dia es medianoche Bogota
  it("inicio del dia es 00:00 en Bogota", () => {
    const inicio = inicioDelDiaBogota("2025-02-15");
    assert.equal(inicio.hour, 0);
    assert.equal(inicio.minute, 0);
    assert.equal(inicio.zoneName, "America/Bogota");
  });

  // Test 2 — fin del dia es 23:59 Bogota
  it("fin del dia es 23:59:59 en Bogota", () => {
    const fin = finDelDiaBogota("2025-02-15");
    assert.equal(fin.hour, 23);
    assert.equal(fin.minute, 59);
    assert.equal(fin.zoneName, "America/Bogota");
  });

  // Test 3 — partido a las 20:00 COT cae en ese dia
  it("partido a las 20:00 COT esta dentro del rango del dia", () => {
    const inicio = inicioDelDiaBogota("2025-02-15");
    const fin = finDelDiaBogota("2025-02-15");
    const partido = fechaEnZonaBogota("2025-02-15T20:00:00-05:00");
    assert.ok(partido >= inicio);
    assert.ok(partido <= fin);
  });

  // Test 4 — partido a las 01:00 UTC del dia siguiente (20:00 COT dia anterior) esta fuera
  it("partido del dia siguiente UTC pero mismo dia COT esta dentro del rango", () => {
    // 2025-02-16 01:00 UTC = 2025-02-15 20:00 COT
    const inicio = inicioDelDiaBogota("2025-02-15");
    const fin = finDelDiaBogota("2025-02-15");
    const partido = fechaEnZonaBogota("2025-02-16T01:00:00Z");
    assert.ok(partido >= inicio);
    assert.ok(partido <= fin);
  });

  // Test 5 — partido de otro dia esta fuera del rango
  it("partido de otro dia queda fuera del rango", () => {
    const inicio = inicioDelDiaBogota("2025-02-15");
    const fin = finDelDiaBogota("2025-02-15");
    const partido = fechaEnZonaBogota("2025-02-16T16:00:00-05:00");
    assert.ok(partido > fin);
  });
});
