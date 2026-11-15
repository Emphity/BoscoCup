/**
 * Reglas de tiempo del torneo (fútbol masculino y femenino).
 *
 * - Puertas abren a las 8:00; los partidos de fase de grupos arrancan a las 9:30.
 * - Cada partido dura 35 minutos: 15' de primer tiempo, 5' de descanso y 15'
 *   de segundo tiempo.
 * - En playoff, si terminan empatados, se define por penales.
 *
 * La espera a que se presente un equipo la manejan los organizadores a mano,
 * así que no se suma al turno.
 */
/** Día del torneo: todos los partidos se juegan el domingo 22 de noviembre de 2026. */
export const DIA_TORNEO = { anio: 2026, mes: 11, dia: 22 } as const;

export const FUTBOL = {
  horaInicio: { horas: 9, minutos: 30 },
  minutosPorTiempo: 15,
  minutosDescanso: 5
} as const;

/** Minutos que ocupa un partido en la cancha. */
export const FUTBOL_MINUTOS_POR_TURNO = FUTBOL.minutosPorTiempo * 2 + FUTBOL.minutosDescanso;
