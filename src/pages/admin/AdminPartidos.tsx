import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { categoriaLabel } from "@/lib/labels";
import { DIA_TORNEO, FUTBOL, FUTBOL_MINUTOS_POR_TURNO } from "@/lib/reglas";
import { IconPencil } from "@/components/icons";
import type { CanchaRow, Categoria, EquipoRow, PartidoRow, Profile } from "@/lib/db-types";


const ROUND_ORDER = ["Octavos", "Cuartos", "Semifinal", "3er puesto", "Final"];

/** ISO -> valor de <input type="time"> en hora local ("09:30"). */
function aHoraInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "09:30" -> ISO de esa hora el día del torneo (todos los partidos se juegan ese día). */
function horaDelTorneo(hora: string): string {
  const [h, m] = hora.split(":").map(Number);
  return new Date(DIA_TORNEO.anio, DIA_TORNEO.mes - 1, DIA_TORNEO.dia, h, m).toISOString();
}

/** Todos los partidos son el mismo día, así que alcanza con la hora. */
function horarioCorto(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

/** Cualquier partido que todavía no empezó (grupos o cruces) se reprograma desde su fila. */
function esProgramable(p: PartidoRow): boolean {
  return p.estado === "programado" || p.estado === "postergado" || p.estado === "suspendido";
}

/**
 * Todos contra todos por el método del círculo: devuelve las fechas en orden,
 * cada una con sus cruces, alternando localía para que quede pareja.
 */
function todosContraTodos(ids: string[]): [string, string][][] {
  const t: (string | null)[] = [...ids];
  if (t.length % 2) t.push(null);
  const n = t.length;
  const fechas: [string, string][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const cruces: [string, string][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = t[i];
      const b = t[n - 1 - i];
      if (a && b) cruces.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    fechas.push(cruces);
    t.splice(1, 0, t.pop() as string | null);
  }
  return fechas;
}

const clavePar = (a: string, b: string) => [a, b].sort().join("|");

interface PartidoConNombres extends PartidoRow {
  local_nombre: string;
  visitante_nombre: string;
  cancha_nombre: string;
  veedor_id: string | null;
}

export function AdminPartidos() {
  const [searchParams] = useSearchParams();
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [categoriaId, setCategoriaId] = useState("");
  const [equipos, setEquipos] = useState<EquipoRow[]>([]);
  const [canchas, setCanchas] = useState<CanchaRow[]>([]);
  const [veedores, setVeedores] = useState<Profile[]>([]);
  const [partidos, setPartidos] = useState<PartidoConNombres[]>([]);

  const [localId, setLocalId] = useState("");
  const [visitanteId, setVisitanteId] = useState("");
  const [canchaId, setCanchaId] = useState("");
  const [horario, setHorario] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  /** Fila que se está editando con el lápiz (cancha y hora sin guardar todavía). */
  const [edicion, setEdicion] = useState<{ id: string; cancha: string; hora: string } | null>(null);
  /** Grupos de la categoría, para asignarle una cancha fija a cada uno. */
  const [grupos, setGrupos] = useState<{ id: string; nombre: string }[]>([]);
  /**
   * Canchas de fútbol que ya usa el masculino (una por grupo). El femenino
   * arranca en la cancha siguiente: con 2 grupos masculinos, juega en la 3ª.
   */
  const [canchasAntes, setCanchasAntes] = useState(0);

  useEffect(() => {
    const cat = categorias.find((c) => c.id === categoriaId);
    const masculino = categorias.find((c) => c.deporte === "futbol" && c.rama === "Masculino");
    if (!supabase || !cat || cat.deporte !== "futbol" || cat.rama !== "Femenino" || !masculino) {
      setCanchasAntes(0);
      return;
    }
    supabase
      .from("grupos")
      .select("id", { count: "exact", head: true })
      .eq("categoria_id", masculino.id)
      .then(({ count }) => setCanchasAntes(Math.max(1, count ?? 0)));
  }, [categoriaId, categorias]);

  useEffect(() => {
    if (!supabase) return;
    supabase
      .from("categorias")
      .select("*")
      .order("deporte")
      .then(({ data }) => {
        const list = (data as Categoria[]) ?? [];
        setCategorias(list);
        const pedida = searchParams.get("categoria");
        if (pedida && list.some((c) => c.id === pedida)) setCategoriaId(pedida);
        else if (list.length > 0) setCategoriaId(list[0].id);
      });
    supabase
      .from("canchas")
      .select("*")
      .order("nombre")
      .then(({ data }) => setCanchas((data as CanchaRow[]) ?? []));
    supabase
      .from("profiles")
      .select("*")
      .eq("rol", "veedor")
      .eq("activo", true)
      .order("nombre")
      .then(({ data }) => setVeedores((data as Profile[]) ?? []));
  }, []);

  useEffect(() => {
    if (!supabase || !categoriaId) return;
    supabase
      .from("equipos")
      .select("*")
      .eq("categoria_id", categoriaId)
      .order("nombre")
      .then(({ data }) => setEquipos((data as EquipoRow[]) ?? []));
    supabase
      .from("grupos")
      .select("id, nombre")
      .eq("categoria_id", categoriaId)
      .order("nombre")
      .then(({ data }) => setGrupos((data as { id: string; nombre: string }[]) ?? []));
    loadPartidos(categoriaId);
  }, [categoriaId]);

  async function loadPartidos(catId: string) {
    if (!supabase || !catId) return;
    const { data: partidosData } = await supabase
      .from("partidos")
      .select("*")
      .eq("categoria_id", catId)
      .order("fecha_hora_programada");
    const rows = (partidosData as PartidoRow[]) ?? [];
    if (rows.length === 0) return setPartidos([]);

    const { data: equiposData } = await supabase.from("equipos").select("id, nombre");
    const { data: canchasData } = await supabase.from("canchas").select("id, nombre");
    const { data: asignaciones } = await supabase.from("asignaciones_veedor").select("partido_id, veedor_id");

    const equipoNombre = new Map((equiposData ?? []).map((e: { id: string; nombre: string }) => [e.id, e.nombre]));
    const canchaNombre = new Map((canchasData ?? []).map((c: { id: string; nombre: string }) => [c.id, c.nombre]));
    const asignacionPorPartido = new Map((asignaciones ?? []).map((a: { partido_id: string; veedor_id: string }) => [a.partido_id, a.veedor_id]));

    // Fase de grupos primero (por horario), después los cruces en orden de ronda.
    rows.sort((a, b) => {
      const ra = a.ronda_eliminatoria ? ROUND_ORDER.indexOf(a.ronda_eliminatoria) + 1 : 0;
      const rb = b.ronda_eliminatoria ? ROUND_ORDER.indexOf(b.ronda_eliminatoria) + 1 : 0;
      return ra - rb || (a.fecha_hora_programada ?? "~").localeCompare(b.fecha_hora_programada ?? "~");
    });
    setPartidos(
      rows.map((p) => ({
        ...p,
        local_nombre: equipoNombre.get(p.equipo_local_id) ?? "—",
        visitante_nombre: p.equipo_visitante_id ? equipoNombre.get(p.equipo_visitante_id) ?? "—" : "A definir",
        cancha_nombre: p.cancha_id ? canchaNombre.get(p.cancha_id) ?? "—" : "Sin asignar",
        veedor_id: asignacionPorPartido.get(p.id) ?? null
      }))
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!supabase) return setError("Supabase no está configurado.");
    if (localId === visitanteId) return setError("Local y visitante no pueden ser el mismo equipo.");

    // Si los dos equipos están en el mismo grupo, el partido suma en la tabla de ese grupo.
    const { data: gruposData } = await supabase.from("grupos").select("id").eq("categoria_id", categoriaId);
    const grupoIds = ((gruposData as { id: string }[]) ?? []).map((g) => g.id);
    let grupoId: string | null = null;
    if (grupoIds.length > 0) {
      const { data: geData } = await supabase
        .from("grupo_equipos")
        .select("grupo_id, equipo_id")
        .in("grupo_id", grupoIds)
        .in("equipo_id", [localId, visitanteId]);
      const ge = (geData as { grupo_id: string; equipo_id: string }[]) ?? [];
      const grupoLocal = ge.find((x) => x.equipo_id === localId)?.grupo_id;
      const grupoVisitante = ge.find((x) => x.equipo_id === visitanteId)?.grupo_id;
      if (grupoLocal && grupoLocal === grupoVisitante) grupoId = grupoLocal;
    }

    const { error: err } = await supabase.from("partidos").insert({
      categoria_id: categoriaId,
      grupo_id: grupoId,
      equipo_local_id: localId,
      equipo_visitante_id: visitanteId || null,
      cancha_id: canchaId || null,
      fecha_hora_programada: horario ? horaDelTorneo(horario) : null
    });
    if (err) return setError(err.message);
    setHorario("");
    loadPartidos(categoriaId);
  }

  async function onDelete(p: PartidoConNombres) {
    if (!supabase) return;
    if (!window.confirm(`¿Eliminar ${p.local_nombre} vs. ${p.visitante_nombre}? Se borran también sus eventos cargados.`)) return;
    setError(null);
    const { error: err } = await supabase.from("partidos").delete().eq("id", p.id);
    if (err) return setError(`No se pudo eliminar: ${err.message}`);
    loadPartidos(categoriaId);
  }

  /**
   * Arma automáticamente el fixture de la fase de grupos: todos contra todos
   * dentro de cada grupo (o de la categoría entera si no hay grupos). No
   * duplica partidos que ya existan; quedan sin cancha ni horario para
   * completarlos fila por fila.
   */
  async function onGenerarFixture() {
    if (!supabase || !categoriaId) return;
    setError(null);
    setAviso(null);

    const [{ data: gruposData }, { data: equiposData }, { data: existentes }] = await Promise.all([
      supabase.from("grupos").select("id, nombre").eq("categoria_id", categoriaId).order("nombre"),
      supabase.from("equipos").select("id").eq("categoria_id", categoriaId),
      supabase.from("partidos").select("equipo_local_id, equipo_visitante_id").eq("categoria_id", categoriaId).is("ronda_eliminatoria", null)
    ]);
    const grupos = (gruposData as { id: string; nombre: string }[]) ?? [];
    const todos = ((equiposData as { id: string }[]) ?? []).map((e) => e.id);

    let zonas: { grupoId: string | null; equipos: string[] }[];
    if (grupos.length > 0) {
      const { data: geData } = await supabase
        .from("grupo_equipos")
        .select("grupo_id, equipo_id")
        .in(
          "grupo_id",
          grupos.map((g) => g.id)
        );
      const ge = (geData as { grupo_id: string; equipo_id: string }[]) ?? [];
      zonas = grupos.map((g) => ({ grupoId: g.id, equipos: ge.filter((x) => x.grupo_id === g.id).map((x) => x.equipo_id) }));
      const sinGrupo = todos.filter((id) => !ge.some((x) => x.equipo_id === id));
      if (sinGrupo.length > 0) {
        return setError(`Hay ${sinGrupo.length} equipo(s) sin grupo asignado. Asignalos en Equipos antes de armar el fixture.`);
      }
    } else {
      zonas = [{ grupoId: null, equipos: todos }];
    }

    const yaJugados = new Set(
      ((existentes as { equipo_local_id: string; equipo_visitante_id: string | null }[]) ?? [])
        .filter((p) => p.equipo_visitante_id)
        .map((p) => clavePar(p.equipo_local_id, p.equipo_visitante_id as string))
    );

    const nuevos: { categoria_id: string; grupo_id: string | null; equipo_local_id: string; equipo_visitante_id: string }[] = [];
    for (const zona of zonas) {
      if (zona.equipos.length < 2) continue;
      for (const fecha of todosContraTodos(zona.equipos)) {
        for (const [local, visitante] of fecha) {
          if (yaJugados.has(clavePar(local, visitante))) continue;
          nuevos.push({ categoria_id: categoriaId, grupo_id: zona.grupoId, equipo_local_id: local, equipo_visitante_id: visitante });
        }
      }
    }

    if (nuevos.length === 0) {
      return setAviso(todos.length < 2 ? "Cargá al menos 2 equipos para armar el fixture." : "El fixture de grupos ya está completo.");
    }
    const conHorario = deporte === "futbol";
    const detalle = conHorario
      ? `, con cancha y horario el domingo ${DIA_TORNEO.dia} desde las 9:30 (turnos de ${FUTBOL_MINUTOS_POR_TURNO}'). Después podés cambiar cualquiera con el lápiz.`
      : ". Después les asignás cancha y horario con el lápiz.";
    if (!window.confirm(`Se van a crear ${nuevos.length} partidos de fase de grupos (todos contra todos)${detalle} ¿Seguimos?`)) {
      return;
    }
    const { error: err } = await supabase.from("partidos").insert(nuevos);
    if (err) return setError(`No se pudo armar el fixture: ${err.message}`);
    if (conHorario) {
      const r = await programarSinHorario();
      if (r.error) setError(`Los partidos se crearon, pero no se pudo programar el horario: ${r.error}`);
      else setAviso(`Listo: ${nuevos.length} partidos creados con cancha y horario.${r.sinLugar ? ` ${r.sinLugar} quedaron sin lugar.` : ""}`);
    } else {
      setAviso(`Listo: ${nuevos.length} partidos creados. Completá cancha y horario con el lápiz de cada fila.`);
    }
    loadPartidos(categoriaId);
  }

  /**
   * Fútbol: reparte los partidos de grupos de la categoría que todavía no tienen
   * horario en turnos de 35' (15' + 5' de descanso + 15') desde las 9:30 del día
   * del torneo.
   *
   * Cada grupo juega todos sus partidos en su propia cancha (grupo A → cancha 1,
   * grupo B → cancha 2, o lo que se elija en el panel), así los grupos van a la
   * par: el turno 1 del grupo A arranca a la misma hora que el turno 1 del B.
   * Dentro de cada cancha se ordenan para que nadie juegue dos seguidos si se
   * puede evitar y que todos los equipos avancen parejo. No pisa partidos ya
   * programados (de cualquier categoría) y respeta la cancha si ya estaba puesta.
   */
  async function programarSinHorario(): Promise<{ programados: number; sinLugar: number; error?: string }> {
    if (!supabase) return { programados: 0, sinLugar: 0, error: "Supabase no está configurado." };
    if (canchasCompatibles.length === 0) return { programados: 0, sinLugar: 0, error: "No hay canchas de fútbol cargadas." };

    const { data: pendData, error: errPend } = await supabase
      .from("partidos")
      .select("id, grupo_id, cancha_id, equipo_local_id, equipo_visitante_id")
      .eq("categoria_id", categoriaId)
      .is("ronda_eliminatoria", null)
      .is("fecha_hora_programada", null)
      .in("estado", ["programado", "postergado", "suspendido"])
      .not("equipo_visitante_id", "is", null)
      .order("created_at");
    if (errPend) return { programados: 0, sinLugar: 0, error: errPend.message };
    type Pendiente = Pick<PartidoRow, "id" | "grupo_id" | "cancha_id" | "equipo_local_id" | "equipo_visitante_id">;
    const pendientes = (pendData as Pendiente[]) ?? [];
    if (pendientes.length === 0) return { programados: 0, sinLugar: 0 };

    const { anio, mes, dia } = DIA_TORNEO;
    const inicio = new Date(anio, mes - 1, dia, FUTBOL.horaInicio.horas, FUTBOL.horaInicio.minutos).getTime();
    const turnoMs = FUTBOL_MINUTOS_POR_TURNO * 60 * 1000;
    const finDia = new Date(anio, mes - 1, dia, 23, 59).getTime();

    // Lo que ya está programado ese día ocupa canchas y equipos.
    const { data: ocupadosData } = await supabase
      .from("partidos")
      .select("cancha_id, equipo_local_id, equipo_visitante_id, fecha_hora_programada")
      .gte("fecha_hora_programada", new Date(inicio).toISOString())
      .lte("fecha_hora_programada", new Date(finDia).toISOString());
    const ocupados = ((ocupadosData as Pick<PartidoRow, "cancha_id" | "equipo_local_id" | "equipo_visitante_id" | "fecha_hora_programada">[]) ?? []).map(
      (o) => ({ ...o, turno: Math.floor((new Date(o.fecha_hora_programada as string).getTime() - inicio) / turnoMs) })
    );
    const canchaOcupada = new Set(ocupados.filter((o) => o.cancha_id).map((o) => `${o.cancha_id}|${o.turno}`));
    const equipoOcupado = new Set(
      ocupados.flatMap((o) => [o.equipo_local_id, o.equipo_visitante_id].filter(Boolean).map((id) => `${id}|${o.turno}`))
    );

    // Cada grupo con su lista de partidos pendientes.
    const porGrupo = new Map<string, Pendiente[]>();
    for (const p of pendientes) {
      const k = p.grupo_id ?? "";
      porGrupo.set(k, [...(porGrupo.get(k) ?? []), p]);
    }

    let programados = 0;
    let sinLugar = 0;
    for (const [grupoId, lista] of porGrupo) {
      const canchaDelGrupo = grupoId ? canchaGrupo(grupoId) : "";
      const jugados = new Map<string, number>();
      const ultimoTurno = new Map<string, number>();
      const restantes = [...lista];

      while (restantes.length > 0) {
        // Primer turno con lugar; entre los partidos que entran, el que deja
        // descansar a todos y sea de los equipos que menos jugaron.
        let elegido: { idx: number; turno: number; cancha: string } | null = null;
        for (let turno = 0; inicio + turno * turnoMs <= finDia && !elegido; turno++) {
          let mejor: { idx: number; cancha: string; puntaje: number } | null = null;
          for (let idx = 0; idx < restantes.length; idx++) {
            const p = restantes[idx];
            const equiposP = [p.equipo_local_id, p.equipo_visitante_id as string];
            if (equiposP.some((e) => equipoOcupado.has(`${e}|${turno}`))) continue;
            const opciones = p.cancha_id ? [p.cancha_id] : canchaDelGrupo ? [canchaDelGrupo] : canchasCompatibles.map((c) => c.id);
            const cancha = opciones.find((c) => !canchaOcupada.has(`${c}|${turno}`));
            if (!cancha) continue;
            const seguidos = equiposP.filter((e) => ultimoTurno.get(e) === turno - 1).length;
            const puntaje = seguidos * 1000 + equiposP.reduce((acc, e) => acc + (jugados.get(e) ?? 0), 0);
            if (!mejor || puntaje < mejor.puntaje) mejor = { idx, cancha, puntaje };
          }
          if (mejor) elegido = { idx: mejor.idx, turno, cancha: mejor.cancha };
        }
        if (!elegido) {
          sinLugar += restantes.length;
          break;
        }
        const [p] = restantes.splice(elegido.idx, 1);
        canchaOcupada.add(`${elegido.cancha}|${elegido.turno}`);
        for (const e of [p.equipo_local_id, p.equipo_visitante_id as string]) {
          equipoOcupado.add(`${e}|${elegido.turno}`);
          jugados.set(e, (jugados.get(e) ?? 0) + 1);
          ultimoTurno.set(e, elegido.turno);
        }
        const { error: err } = await supabase
          .from("partidos")
          .update({ cancha_id: elegido.cancha, fecha_hora_programada: new Date(inicio + elegido.turno * turnoMs).toISOString() })
          .eq("id", p.id);
        if (err) return { programados, sinLugar, error: err.message };
        programados++;
      }
    }
    return { programados, sinLugar };
  }

  /** Botón para completar los partidos de grupos que hayan quedado sin horario. */
  async function onCompletarHorarios() {
    setError(null);
    setAviso(null);
    const r = await programarSinHorario();
    if (r.error) setError(`No se pudo programar: ${r.error}`);
    else if (r.programados === 0 && r.sinLugar === 0) setAviso("Todos los partidos de grupos ya tienen horario.");
    else setAviso(`Listo: ${r.programados} partidos con cancha y horario.${r.sinLugar ? ` ${r.sinLugar} quedaron sin lugar.` : ""}`);
    loadPartidos(categoriaId);
  }

  /** Guarda cancha y/o horario de un partido y avisa si choca con otro en la misma cancha. */
  async function onProgramarCruce(p: PartidoConNombres, cambios: { cancha_id?: string | null; fecha_hora_programada?: string | null }) {
    if (!supabase) return;
    setError(null);
    setAviso(null);
    const { error: err } = await supabase.from("partidos").update(cambios).eq("id", p.id);
    if (err) return setError(`No se pudo guardar: ${err.message}`);

    const cancha = cambios.cancha_id !== undefined ? cambios.cancha_id : p.cancha_id;
    const fecha = cambios.fecha_hora_programada !== undefined ? cambios.fecha_hora_programada : p.fecha_hora_programada;
    if (cancha && fecha) {
      const { data: choques } = await supabase
        .from("partidos")
        .select("id")
        .eq("cancha_id", cancha)
        .eq("fecha_hora_programada", fecha)
        .neq("id", p.id);
      if ((choques ?? []).length > 0) {
        const nombre = canchas.find((c) => c.id === cancha)?.nombre ?? "esa cancha";
        setAviso(`Ojo: ya hay otro partido en ${nombre} a las ${horarioCorto(fecha)}.`);
      }
    }
    loadPartidos(categoriaId);
  }

  /** Guarda lo que se cambió con el lápiz: cancha y hora (siempre el día del torneo). */
  async function onGuardarEdicion(p: PartidoConNombres) {
    if (!edicion) return;
    const { cancha, hora } = edicion;
    setEdicion(null);
    const fecha = hora ? horaDelTorneo(hora) : null;
    const fechaActual = p.fecha_hora_programada ? new Date(p.fecha_hora_programada).toISOString() : null;
    if ((cancha || null) === p.cancha_id && fecha === fechaActual) return;
    await onProgramarCruce(p, { cancha_id: cancha || null, fecha_hora_programada: fecha });
  }

  async function onAsignarVeedor(partidoId: string, veedorId: string) {
    if (!supabase) return;
    if (!veedorId) {
      await supabase.from("asignaciones_veedor").delete().eq("partido_id", partidoId);
    } else {
      await supabase.from("asignaciones_veedor").upsert({ partido_id: partidoId, veedor_id: veedorId }, { onConflict: "partido_id" });
    }
    loadPartidos(categoriaId);
  }

  const deporte = categorias.find((c) => c.id === categoriaId)?.deporte;
  const canchasCompatibles = canchas.filter(
    (c) => c.estado !== "fuera_de_servicio" && (!deporte || !c.deportes_compatibles?.length || c.deportes_compatibles.includes(deporte))
  );

  /**
   * Cancha fija de cada grupo, en orden por nombre. Masculino: grupo A → 1ª
   * cancha, grupo B → 2ª. Femenino: la cancha que sigue a las del masculino.
   */
  function canchaGrupo(grupoId: string): string {
    const i = grupos.findIndex((g) => g.id === grupoId);
    if (i < 0 || canchasCompatibles.length === 0) return "";
    return canchasCompatibles[(canchasAntes + i) % canchasCompatibles.length].id;
  }

  return (
    <div>
      <h2 className="page-title">Partidos</h2>
      <p className="form-hint">
        El fixture de la fase de grupos se arma solo (todos contra todos dentro de cada grupo). Los cruces se
        generan desde la sección Cruces. A cualquier partido que todavía no empezó le podés cambiar la cancha y
        el horario directamente en su fila.
      </p>

      <label className="field" style={{ maxWidth: 320, marginBottom: 20 }}>
        <span>Categoría</span>
        <select className="input" value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}>
          {categorias.map((c) => (
            <option key={c.id} value={c.id}>
              {categoriaLabel(c)}
            </option>
          ))}
        </select>
      </label>

      <section className="panel fixture-panel">
        <div>
          <h3 className="panel-title">Fixture de fase de grupos</h3>
          <p className="form-hint" style={{ margin: 0 }}>
            Crea todos los partidos que falten entre los equipos de cada grupo. No duplica los que ya existen.
          </p>
        </div>
        <button className="btn btn-accent" type="button" onClick={onGenerarFixture} disabled={!categoriaId}>
          Armar fixture
        </button>
      </section>

      {deporte === "futbol" && (
        <section className="panel fixture-panel">
          <div>
            <h3 className="panel-title">Horarios de fútbol</h3>
            <p className="form-hint" style={{ margin: 0 }}>
              Todo se juega el domingo {DIA_TORNEO.dia}/{DIA_TORNEO.mes}. Puertas 8:00 · primeros partidos 9:30. Cada partido dura {FUTBOL_MINUTOS_POR_TURNO}': 2 tiempos de{" "}
              {FUTBOL.minutosPorTiempo}' con {FUTBOL.minutosDescanso}' de descanso. Cada grupo juega todos sus partidos en su
              cancha y los grupos van a la par (sin partidos entre grupos). En playoff, si empatan, van a penales (tanda de 5). La final se juega a 2 tiempos de {FUTBOL.minutosPorTiempoFinal}'.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
            {grupos.length > 0 && (
              <span className="form-hint" style={{ margin: 0 }}>
                {grupos
                  .map((g) => `${g.nombre} → ${canchasCompatibles.find((c) => c.id === canchaGrupo(g.id))?.nombre ?? "sin cancha"}`)
                  .join(" · ")}
              </span>
            )}
            <button className="btn btn-ghost" type="button" onClick={onCompletarHorarios}>
              Completar horarios faltantes
            </button>
          </div>
        </section>
      )}

      <details className="panel manual-match">
        <summary>Agregar un partido a mano (desempates, amistosos)</summary>
      <form className="form-row" onSubmit={onSubmit}>
        <label className="field">
          <span>Local</span>
          <select className="input" value={localId} onChange={(e) => setLocalId(e.target.value)} required>
            <option value="">Elegir…</option>
            {equipos.map((eq) => (
              <option key={eq.id} value={eq.id}>
                {eq.nombre}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Visitante</span>
          <select className="input" value={visitanteId} onChange={(e) => setVisitanteId(e.target.value)} required>
            <option value="">Elegir…</option>
            {equipos.map((eq) => (
              <option key={eq.id} value={eq.id}>
                {eq.nombre}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Cancha</span>
          <select className="input" value={canchaId} onChange={(e) => setCanchaId(e.target.value)}>
            <option value="">Sin asignar</option>
            {canchas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Hora (domingo {DIA_TORNEO.dia})</span>
          <input className="input" type="time" value={horario} onChange={(e) => setHorario(e.target.value)} />
        </label>
        <button className="btn btn-primary" type="submit">
          Programar partido
        </button>
      </form>
      </details>
      {error && <p className="form-error">{error}</p>}
      {aviso && <p className="form-hint form-hint-warn">{aviso}</p>}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Partido</th>
              <th>Cancha</th>
              <th>Hora</th>
              <th>Estado</th>
              <th>Veedor</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {partidos.map((p) => {
              const editable = esProgramable(p);
              const faltaProgramar = editable && (!p.cancha_id || !p.fecha_hora_programada);
              const enEdicion = editable && edicion?.id === p.id ? edicion : null;
              return (
              <tr key={p.id} className={faltaProgramar ? "row-pending" : ""}>
                <td>
                  {p.local_nombre} vs. {p.visitante_nombre}
                  {p.ronda_eliminatoria && <span className="round-tag">{p.ronda_eliminatoria}</span>}
                  {faltaProgramar && <span className="row-note">Falta {!p.cancha_id && !p.fecha_hora_programada ? "cancha y horario" : !p.cancha_id ? "cancha" : "horario"}</span>}
                </td>
                <td>
                  {enEdicion ? (
                    <select
                      className="input input-sm"
                      value={enEdicion.cancha}
                      onChange={(e) => setEdicion({ ...enEdicion, cancha: e.target.value })}
                      aria-label={`Cancha de ${p.local_nombre} vs. ${p.visitante_nombre}`}
                    >
                      <option value="">Sin asignar</option>
                      {canchasCompatibles.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.nombre}
                        </option>
                      ))}
                    </select>
                  ) : (
                    p.cancha_nombre || "—"
                  )}
                </td>
                <td className="tnum">
                  {enEdicion ? (
                    <span className="edit-inline">
                      <input
                        className="input input-sm"
                        type="time"
                        value={enEdicion.hora}
                        onChange={(e) => setEdicion({ ...enEdicion, hora: e.target.value })}
                        onKeyDown={(e) => e.key === "Enter" && onGuardarEdicion(p)}
                        aria-label={`Hora de ${p.local_nombre} vs. ${p.visitante_nombre}`}
                      />
                      <button className="btn btn-primary btn-sm" onClick={() => onGuardarEdicion(p)}>
                        Guardar
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEdicion(null)}>
                        Cancelar
                      </button>
                    </span>
                  ) : (
                    <span className="edit-inline">
                      {horarioCorto(p.fecha_hora_programada)}
                      {editable && (
                        <button
                          className="pencil-btn"
                          onClick={() => setEdicion({ id: p.id, cancha: p.cancha_id ?? "", hora: aHoraInput(p.fecha_hora_programada) })}
                          aria-label={`Cambiar cancha y hora de ${p.local_nombre} vs. ${p.visitante_nombre}`}
                          title="Cambiar cancha y hora"
                        >
                          <IconPencil />
                        </button>
                      )}
                    </span>
                  )}
                </td>
                <td>
                  <span className="badge-estado">{p.estado}</span>
                </td>
                <td>
                  <select className="input input-sm" value={p.veedor_id ?? ""} onChange={(e) => onAsignarVeedor(p.id, e.target.value)}>
                    <option value="">Sin asignar</option>
                    {veedores.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.nombre}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="row-actions">
                  <button className="btn btn-danger btn-sm" onClick={() => onDelete(p)}>
                    Eliminar
                  </button>
                </td>
              </tr>
              );
            })}
            {partidos.length === 0 && (
              <tr>
                <td colSpan={6} className="empty-row">
                  Todavía no hay partidos programados en esta categoría.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
