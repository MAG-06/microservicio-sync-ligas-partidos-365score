/** Utilidades de fecha con zona horaria America/Bogota */

import { DateTime } from "luxon";
import { ZONA_BOGOTA } from "../config.js";

export function ahoraIsoBogota(): string {
  return DateTime.now().setZone(ZONA_BOGOTA).toISO()!;
}

export function inicioDelDiaBogota(fecha: string): DateTime {
  return DateTime.fromISO(fecha, { zone: ZONA_BOGOTA }).startOf("day");
}

export function finDelDiaBogota(fecha: string): DateTime {
  return DateTime.fromISO(fecha, { zone: ZONA_BOGOTA }).endOf("day");
}

export function fechaEnZonaBogota(iso: string): DateTime {
  return DateTime.fromISO(iso).setZone(ZONA_BOGOTA);
}
