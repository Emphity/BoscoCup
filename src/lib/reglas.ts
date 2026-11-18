/**
 * Reglas de tiempo del torneo (fútbol masculino y femenino).
 *
 * - Puertas abren a las 8:00; los partidos de fase de grupos arrancan a las 9:30.
 * - Cada partido dura 35 minutos: 15' de primer tiempo, 5' de descanso y 15'
 *   de segundo tiempo.
 * - En playoff, si terminan empatados, se define por penales (tanda de 5).
 * - La final se juega a 2 tiempos de 20' (turno de 45').
 * - Máximo 3 cambios por equipo en cada partido.
 *
 * La espera a que se presente un equipo la manejan los organizadores a mano,
 * así que no se suma al turno.
 */
/** Día del torneo: todos los partidos se juegan el domingo 22 de noviembre de 2026. */
export const DIA_TORNEO = { anio: 2026, mes: 11, dia: 22 } as const;

export const FUTBOL = {
  horaInicio: { horas: 9, minutos: 30 },
  minutosPorTiempo: 15,
  /** La final es la única ronda con tiempos más largos. */
  minutosPorTiempoFinal: 20,
  minutosDescanso: 5,
  maxCambios: 3
} as const;

/** Minutos que ocupa un partido en la cancha. */
export const FUTBOL_MINUTOS_POR_TURNO = FUTBOL.minutosPorTiempo * 2 + FUTBOL.minutosDescanso;

/** Minutos de cada tiempo según la ronda (la final va a 20'). */
export function minutosPorTiempo(ronda: string | null | undefined): number {
  return ronda === "Final" ? FUTBOL.minutosPorTiempoFinal : FUTBOL.minutosPorTiempo;
}

/** Minutos que ocupa en la cancha un partido de esa ronda. */
export function minutosDeTurno(ronda: string | null | undefined): number {
  return minutosPorTiempo(ronda) * 2 + FUTBOL.minutosDescanso;
}

/** Plantel: mínimo 7 y máximo 10 jugadores por equipo (fútbol). */
export const PLANTEL_FUTBOL = { minimo: 7, maximo: 10 } as const;

/**
 * Tarjetas acumulativas. El reglamento no fija el número: acá se define.
 * - Roja directa o doble amarilla: no juega el partido siguiente.
 * - Cada AMARILLAS_PARA_SUSPENSION amarillas acumuladas (en partidos distintos):
 *   no juega el partido siguiente, y el contador vuelve a cero.
 */
export const AMARILLAS_PARA_SUSPENSION = 2;

/** Vóley: al mejor de 3 sets de 20 puntos, con 2 de diferencia. */
export const VOLEY = {
  puntosPorSet: 20,
  diferenciaMinima: 2,
  setsParaGanar: 2
} as const;

/** true si el set ya se puede cerrar según el reglamento. */
export function setTerminado(a: number, b: number): boolean {
  return Math.max(a, b) >= VOLEY.puntosPorSet && Math.abs(a - b) >= VOLEY.diferenciaMinima;
}
