import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { categoriaLabel } from "@/lib/labels";
import { computeZonesForCategoria, teamFrom, type ZonasCategoria } from "@/lib/standings";
import {
  avanzarLlave,
  borrarLlave,
  CLASIFICAN_CUARTOS,
  EQUIPOS_CUADRO_PROYECTADO,
  estaDefinido,
  ganadorDe,
  generarLlave,
  MAX_EQUIPOS_LLAVE
} from "@/lib/bracket";
import { programarCruces } from "@/lib/programar-cruces";
import { DIA_TORNEO } from "@/lib/reglas";
import { BracketView } from "@/components/BracketView";
import { IconPencil } from "@/components/icons";
import type { CanchaRow, Categoria, PartidoRow } from "@/lib/db-types";
import type { BracketMatch, Team } from "@/types";

function aHoraInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function horaDelTorneo(hora: string): string {
  const [h, m] = hora.split(":").map(Number);
  return new Date(DIA_TORNEO.anio, DIA_TORNEO.mes - 1, DIA_TORNEO.dia, h, m).toISOString();
}

export function AdminCruces() {
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [categoriaId, setCategoriaId] = useState("");
  const [zonas, setZonas] = useState<ZonasCategoria | null>(null);
  const [cruces, setCruces] = useState<PartidoRow[]>([]);
  const [canchas, setCanchas] = useState<CanchaRow[]>([]);
  /** "todos" o cuántos entran de cada grupo. */
  const [entran, setEntran] = useState<string>("todos");
  const [mensaje, setMensaje] = useState<{ ok: boolean; texto: string } | null>(null);
  const [cargando, setCargando] = useState(false);
  const [edicion, setEdicion] = useState<{ id: string; cancha: string; hora: string } | null>(null);

  const categoria = categorias.find((c) => c.id === categoriaId);

  useEffect(() => {
    if (!supabase) return;
    supabase
      .from("categorias")
      .select("*")
      .order("deporte")
      .then(({ data }) => {
        const list = (data as Categoria[]) ?? [];
        setCategorias(list);
        if (list.length > 0) setCategoriaId(list[0].id);
      });
    supabase
      .from("canchas")
      .select("*")
      .order("nombre")
      .then(({ data }) => setCanchas((data as CanchaRow[]) ?? []));
  }, []);

  useEffect(() => {
    if (!categoria) return;
    const c = categoria.cantidad_clasifican_por_grupo;
    setEntran(c === CLASIFICAN_CUARTOS ? "cuartos" : c >= 99 ? "todos" : String(c));
    setEdicion(null);
    setMensaje(null);
    // Al entrar, el cuadro se pone al día solo con los partidos ya terminados.
    (async () => {
      const r = await avanzarLlave(categoria.id);
      if (r.cambios > 0) {
        await programarCruces(categoria.id);
        setMensaje({ ok: true, texto: r.mensaje });
      }
      cargar(categoria);
    })();
  }, [categoriaId, categorias.length]);

  async function cargar(cat: Categoria) {
    const z = await computeZonesForCategoria(cat);
    setZonas(z);
    setCruces(z.partidos.filter((p) => p.ronda_eliminatoria));
  }

  async function correr(accion: () => Promise<{ ok: boolean; mensaje: string }>, programar = true) {
    if (!categoria) return;
    setCargando(true);
    setMensaje(null);
    const r = await accion();
    let texto = r.mensaje;
    if (r.ok && programar) {
      const p = await programarCruces(categoria.id);
      if (p.error) texto += ` No se pudo poner horario: ${p.error}`;
      else if (p.programados) texto += ` ${p.programados} partido(s) quedaron con cancha y horario.`;
    }
    setMensaje({ ok: r.ok, texto });
    setCargando(false);
    // La categoría puede haber cambiado (cuántos entran): se recarga todo.
    if (supabase) {
      const { data } = await supabase.from("categorias").select("*").order("deporte");
      setCategorias((data as Categoria[]) ?? []);
    }
    cargar(categoria);
  }

  const onArmar = () =>
    correr(() => generarLlave(categoriaId, entran === "todos" ? null : entran === "cuartos" ? "cuartos" : Number(entran)));
  const onActualizar = () => correr(() => avanzarLlave(categoriaId));
  const onBorrar = () => {
    if (!window.confirm("¿Borrar el cuadro de playoffs de esta categoría? Se puede volver a armar desde la tabla.")) return;
    correr(() => borrarLlave(categoriaId), false);
  };
  const onResortear = async () => {
    if (!supabase || !categoria) return;
    if (!window.confirm("¿Volver a sortear cancha y horario de los partidos de playoff que todavía no empezaron?")) return;
    const ids = cruces.filter((p) => p.estado === "programado").map((p) => p.id);
    if (ids.length) await supabase.from("partidos").update({ cancha_id: null, fecha_hora_programada: null }).in("id", ids);
    correr(async () => ({ ok: true, mensaje: "Canchas y horarios sorteados de nuevo." }));
  };

  async function guardarEdicion() {
    if (!supabase || !edicion || !categoria) return;
    const { id, cancha, hora } = edicion;
    setEdicion(null);
    const fecha = hora ? horaDelTorneo(hora) : null;
    const { error } = await supabase.from("partidos").update({ cancha_id: cancha || null, fecha_hora_programada: fecha }).eq("id", id);
    if (error) return setMensaje({ ok: false, texto: `No se pudo guardar: ${error.message}` });
    if (cancha && fecha) {
      const { data: choques } = await supabase.from("partidos").select("id").eq("cancha_id", cancha).eq("fecha_hora_programada", fecha).neq("id", id);
      if ((choques ?? []).length > 0) {
        setMensaje({ ok: false, texto: `Guardado, pero ojo: ya hay otro partido en ${canchas.find((c) => c.id === cancha)?.nombre} a las ${hora}.` });
      } else setMensaje({ ok: true, texto: "Cancha y horario guardados." });
    }
    cargar(categoria);
  }

  // ---- datos para el cuadro ----
  const equipos = new Map((zonas?.equipos ?? []).map((e) => [e.id, teamFrom(e)]));
  const canchaNombre = new Map(canchas.map((c) => [c.id, c.nombre]));
  const porId = new Map(cruces.map((p) => [p.id, p]));
  const matches: BracketMatch[] = cruces
    .filter((p) => equipos.has(p.equipo_local_id))
    .map((p) => ({
      id: p.id,
      round: p.ronda_eliminatoria as string,
      pos: p.llave_pos ?? null,
      home: equipos.get(p.equipo_local_id) as Team,
      away: p.equipo_visitante_id ? equipos.get(p.equipo_visitante_id) ?? null : null,
      homeScore: p.resultado_local,
      awayScore: p.resultado_visitante,
      penalesHome: p.penales_local,
      penalesAway: p.penales_visitante,
      winnerId: p.estado === "finalizado" && estaDefinido(p) ? ganadorDe(p) : null,
      pending: p.estado !== "finalizado",
      scheduledTime: p.fecha_hora_programada ? aHoraInput(p.fecha_hora_programada) : undefined,
      court: p.cancha_id ? canchaNombre.get(p.cancha_id) : undefined
    }));

  const canchasDeporte = canchas.filter(
    (c) => c.estado !== "fuera_de_servicio" && (!c.deportes_compatibles?.length || !categoria || c.deportes_compatibles.includes(categoria.deporte))
  );

  const editar = (m: BracketMatch) => {
    const p = m.id ? porId.get(m.id) : null;
    if (!p || p.estado !== "programado") return null;
    if (edicion?.id === p.id) {
      return (
        <div className="bk-edit" onClick={(e) => e.stopPropagation()}>
          <select className="input input-sm" value={edicion.cancha} onChange={(e) => setEdicion({ ...edicion, cancha: e.target.value })} aria-label="Cancha">
            <option value="">Sin cancha</option>
            {canchasDeporte.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </select>
          <input className="input input-sm" type="time" value={edicion.hora} onChange={(e) => setEdicion({ ...edicion, hora: e.target.value })} aria-label="Hora" />
          <div className="bk-edit-actions">
            <button className="btn btn-primary btn-sm" onClick={guardarEdicion}>
              Guardar
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setEdicion(null)}>
              Cancelar
            </button>
          </div>
        </div>
      );
    }
    return (
      <button
        className="bk-edit-btn"
        onClick={() => setEdicion({ id: p.id, cancha: p.cancha_id ?? "", hora: aHoraInput(p.fecha_hora_programada) })}
        title="Cambiar cancha y hora"
      >
        <IconPencil /> Cambiar cancha / hora
      </button>
    );
  };

  const hayCuadro = cruces.length > 0;
  const tamanioZona = Math.max(0, ...(zonas?.zones.map((z) => z.rows.length) ?? [0]));
  const totalEquipos = zonas?.zones.reduce((acc, z) => acc + z.rows.length, 0) ?? 0;
  const entranTotal =
    entran === "todos"
      ? totalEquipos
      : entran === "cuartos"
        ? Math.min(totalEquipos, EQUIPOS_CUADRO_PROYECTADO)
        : (zonas?.zones ?? []).reduce((acc, z) => acc + Math.min(z.rows.length, Number(entran)), 0);
  const cantGrupos = zonas?.zones.length ?? 0;

  return (
    <div>
      <h2 className="page-title">Cruces</h2>
      <p className="form-hint">
        La fase de grupos ordena el cuadro: 1ºA, 1ºB, 2ºA, 2ºB… Con cualquier cantidad de equipos (par o impar) el cuadro se
        completa con pases directos para los mejor ubicados. Cada partido queda con cancha (al azar) y horario, y lo podés cambiar.
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

      {zonas && !hayCuadro && (
        <div className="panel">
          <h3 style={{ margin: "0 0 14px", fontSize: 14 }}>Tabla actual</h3>
          {zonas.zones.every((z) => z.rows.length === 0) ? (
            <p className="form-hint" style={{ margin: 0 }}>
              Todavía no hay equipos en la tabla.
            </p>
          ) : (
            zonas.zones.filter((z) => z.rows.length > 0).map((zone) => (
              <div key={zone.id} style={{ marginBottom: 14 }}>
                {zone.nombre && <div className="bracket-round">{zone.nombre}</div>}
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Equipo</th>
                        <th>PJ</th>
                        <th>DG</th>
                        <th>Pts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {zone.rows.map((row, i) => (
                        <tr key={row.team.id}>
                          <td className="tnum">{i + 1}º</td>
                          <td>
                            <span className="color-dot" style={{ background: row.team.shieldColor }} />
                            {row.team.name}
                          </td>
                          <td>{row.played}</td>
                          <td>{row.goalDiff}</td>
                          <td>{row.points}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {zone.rows.some((r) => r.empatado) && (
                  <p className="form-hint form-hint-warn" style={{ margin: "6px 0 0" }}>
                    Empate total entre {zone.rows.filter((r) => r.empatado).map((r) => r.team.name).join(" y ")}: define el orden en el cuadro.
                  </p>
                )}
              </div>
            ))
          )}

          <div className="form-row" style={{ marginTop: 14 }}>
            <label className="field" style={{ maxWidth: 260 }}>
              <span>Entran a playoffs</span>
              <select className="input" value={entran} onChange={(e) => setEntran(e.target.value)}>
                <option value="todos">Todos los equipos</option>
                {totalEquipos > EQUIPOS_CUADRO_PROYECTADO && (
                  <option value="cuartos">
                    {cantGrupos === 3
                      ? "Cuartos: 1º y 2º de cada grupo + 2 mejores 3º"
                      : cantGrupos === 2
                        ? "Cuartos: los 4 primeros de cada grupo"
                        : "Cuartos: los 8 mejores"}
                  </option>
                )}
                {Array.from({ length: Math.max(0, tamanioZona - 1) }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    Los primeros {n} {(zonas.zones.length ?? 0) > 1 ? "de cada grupo" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary" onClick={onArmar} disabled={cargando || entranTotal < 2 || entranTotal > MAX_EQUIPOS_LLAVE}>
              {cargando ? "Armando…" : `Armar cuadro (${entranTotal} equipos)`}
            </button>
          </div>
          {entranTotal > MAX_EQUIPOS_LLAVE && (
            <p className="form-hint form-hint-warn">El cuadro admite hasta {MAX_EQUIPOS_LLAVE} equipos.</p>
          )}
        </div>
      )}

      {mensaje && <p className={mensaje.ok ? "form-success" : "form-error"}>{mensaje.texto}</p>}

      <div className="panel">
        <div className="bk-admin-head">
          <h3 style={{ margin: 0, fontSize: 14 }}>Cuadro de playoffs</h3>
          {hayCuadro && (
            <div className="row-actions">
              <button className="btn btn-primary btn-sm" onClick={onActualizar} disabled={cargando}>
                Actualizar cuadro
              </button>
              <button className="btn btn-ghost btn-sm" onClick={onResortear} disabled={cargando}>
                Sortear canchas de nuevo
              </button>
              <button className="btn btn-danger btn-sm" onClick={onBorrar} disabled={cargando}>
                Borrar cuadro
              </button>
            </div>
          )}
        </div>
        {hayCuadro && (
          <p className="form-hint" style={{ marginTop: 6 }}>
            Cuando termina un partido, el ganador pasa solo a la ronda siguiente al entrar acá (o con “Actualizar cuadro”). Los
            partidos que todavía no empezaron se pueden mover de cancha u hora.
          </p>
        )}
        <BracketView matches={matches} renderExtra={editar} />
      </div>
    </div>
  );
}
