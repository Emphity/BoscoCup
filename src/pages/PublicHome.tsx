import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { Branch, HistorialMatch, LiveMatch, Sport, Team, ZoneStandings } from "@/types";
import { getMockAllLiveMatches, getMockData } from "@/lib/mock-data";
import { fetchAllLiveMatches, fetchPublicData, type PublicData } from "@/lib/public-data";
import { TABLAS_ESTATICAS, invalidarTabla, invalidarTodo, type TablaEstatica } from "@/lib/static-cache";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { DynamicIsland } from "@/components/DynamicIsland";
import { Segmented } from "@/components/Segmented";
import { BracketView } from "@/components/BracketView";
import { TeamSheet, type TeamRef } from "@/components/TeamSheet";
import {
  IconAccess,
  IconBracket,
  IconClipboard,
  IconFollow,
  IconFutbol,
  IconHome,
  IconMoon,
  IconSun,
  IconTable,
  IconVoley,
  IconWhistle,
  Shield
} from "@/components/icons";

const SPORTS: { id: Sport; label: string; icon: typeof IconFutbol }[] = [
  { id: "futbol", label: "Fútbol", icon: IconFutbol },
  { id: "voley", label: "Vóley mixto", icon: IconVoley }
];

const PESTANAS = [
  { id: "inicio", label: "Inicio", icon: IconHome },
  { id: "tabla", label: "Tabla", icon: IconTable },
  { id: "cruces", label: "Cruces", icon: IconBracket },
  { id: "historial", label: "Historial", icon: IconFollow }
] as const;

const EMPTY: PublicData = { zones: [], bracket: [], historial: [] };

type Pestana = (typeof PESTANAS)[number]["id"];

function temaInicial(): "light" | "dark" | null {
  try {
    const t = localStorage.getItem("bosco-theme");
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

export function PublicHome() {
  const [sport, setSport] = useState<Sport>("futbol");
  const [branch, setBranch] = useState<Branch>("masculino");
  const [theme, setTheme] = useState<"light" | "dark" | null>(temaInicial);
  const [data, setData] = useState<PublicData>(EMPTY);
  const [liveMatches, setLiveMatches] = useState<LiveMatch[]>([]);
  const [pestana, setPestana] = useState<Pestana>("inicio");
  const [equipo, setEquipo] = useState<TeamRef | null>(null);

  const [accesoAbierto, setAccesoAbierto] = useState(false);

  // Solo fútbol tiene ramas; vóley se juega mixto.
  const hasBranches = sport === "futbol";
  const ramaActual: Branch = hasBranches ? branch : "mixto";

  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.setAttribute("data-theme", theme);
    else root.removeAttribute("data-theme");
  }, [theme]);

  useEffect(() => {
    let active = true;

    if (!isSupabaseConfigured) {
      setData(getMockData(sport, ramaActual));
      setLiveMatches(getMockAllLiveMatches());
      return () => { active = false; };
    }
    const client = supabase;
    if (!client) return () => { active = false; };

    // Cada pedido lleva un número; si llega una respuesta vieja después de una
    // nueva, se descarta en vez de pisar datos más frescos.
    let seqPublico = 0;
    let seqVivo = 0;
    let categoriaId: string | undefined;
    let idsEnVivo = new Set<string>();

    async function cargarPublico() {
      const seq = ++seqPublico;
      const d = await fetchPublicData(sport, ramaActual);
      if (!active || seq !== seqPublico) return;
      categoriaId = d.categoriaId;
      setData(d);
    }

    async function cargarVivo() {
      const seq = ++seqVivo;
      const live = await fetchAllLiveMatches();
      if (!active || seq !== seqVivo) return;
      idsEnVivo = new Set(live.map((m) => m.id));
      setLiveMatches(live);
    }

    // Los eventos realtime se juntan: durante un partido llegan varios seguidos
    // y todos los espectadores los reciben a la vez. Se espera un poco (con una
    // demora al azar para no pegarle a la base todos juntos) y se refresca solo
    // lo que pudo haber cambiado.
    let pendientePublico = false;
    let pendienteVivo = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function programar(publico: boolean, vivo: boolean) {
      pendientePublico ||= publico;
      pendienteVivo ||= vivo;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (pendientePublico) void cargarPublico();
        if (pendienteVivo) void cargarVivo();
        pendientePublico = pendienteVivo = false;
      }, 300 + Math.random() * 400);
    }

    void cargarPublico();
    void cargarVivo();

    type Fila = Record<string, unknown> | undefined;
    const filaDe = (payload: { new: unknown; old: unknown }) => ({
      nueva: (payload.new && Object.keys(payload.new as object).length ? payload.new : undefined) as Fila,
      vieja: (payload.old && Object.keys(payload.old as object).length ? payload.old : undefined) as Fila
    });

    function onPartido(payload: { new: unknown; old: unknown }) {
      const { nueva, vieja } = filaDe(payload);
      const id = (nueva?.id ?? vieja?.id) as string | undefined;
      const estado = nueva?.estado as string | undefined;
      const cat = (nueva?.categoria_id ?? vieja?.categoria_id) as string | undefined;
      // Tabla/cruces: solo si el partido es de la categoría que se está viendo
      // (en un DELETE puede no venir la categoría: por las dudas, se refresca).
      const publico = !cat || !categoriaId || cat === categoriaId;
      // Carrusel en vivo: si el partido está o estaba en juego.
      const vivo = !id || idsEnVivo.has(id) || estado === "en_juego" || estado === "entretiempo";
      programar(publico, vivo);
    }

    function onEvento(payload: { new: unknown; old: unknown }) {
      const { nueva, vieja } = filaDe(payload);
      const partidoId = (nueva?.partido_id ?? vieja?.partido_id) as string | undefined;
      // Un gol o una tarjeta de un partido en juego solo cambia el carrusel: la
      // tabla se calcula con partidos finalizados. Si el evento es de otro
      // partido (una corrección posterior), se refresca todo.
      if (partidoId && idsEnVivo.has(partidoId)) programar(false, true);
      else programar(true, true);
    }

    function onEstatica(tabla: TablaEstatica) {
      invalidarTabla(tabla);
      programar(true, true);
    }

    // Con el celular bloqueado o la pestaña en segundo plano se pueden perder
    // eventos realtime: al volver se descarta la caché y se recarga todo.
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      invalidarTodo();
      programar(true, true);
    }
    document.addEventListener("visibilitychange", onVisible);

    let channel = client
      .channel(`public-${sport}-${ramaActual}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "partidos" }, onPartido)
      .on("postgres_changes", { event: "*", schema: "public", table: "eventos_partido" }, onEvento);
    for (const tabla of TABLAS_ESTATICAS) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table: tabla }, () => onEstatica(tabla));
    }
    channel.subscribe();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      client.removeChannel(channel);
    };
  }, [sport, ramaActual]);

  function toggleTheme() {
    const actual = theme ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = actual === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("bosco-theme", next);
    } catch {
      /* sin almacenamiento: el tema dura lo que dure la pestaña */
    }
  }

  function irA(destino: Pestana) {
    setPestana(destino);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const abrirEquipo = (team: Team) => setEquipo({ team, sport, branch: ramaActual });
  const abrirDesdeVivo = (team: Team, m: LiveMatch) => setEquipo({ team, sport: m.sport, branch: m.branch });
  const tabIndex = PESTANAS.findIndex((p) => p.id === pestana);
  const sportColor = `var(--color-${sport})`;

  return (
    <div className="pub" style={{ "--sport": sportColor } as CSSProperties}>
      <DynamicIsland matches={liveMatches} onTeam={abrirDesdeVivo} />

      <header className="pub-head">
        <div className="brand">
          <img className="brand-logo only-light" src="/logo-bosco-cup.png" alt="" width={38} height={64} />
          <img className="brand-logo only-dark" src="/logo-bosco-cup-dark.png" alt="" width={38} height={64} />
          <div>
            <h1 className="pub-title">
              Bosco<span>Cup</span>
            </h1>
            <p className="brand-sub">Fútbol · Vóley</p>
          </div>
        </div>
        <div className="head-actions">
          <button className="icon-btn" type="button" aria-label="Cambiar tema claro/oscuro" onClick={toggleTheme}>
            <IconMoon className="only-light" />
            <IconSun className="only-dark" />
          </button>
          <BotonAcceso onClick={() => setAccesoAbierto(true)} />
        </div>
      </header>
      <div className="brand-rule" aria-hidden="true" />

      <div className="pub-controls">
        <Segmented
          label="Deporte"
          value={sport}
          onChange={setSport}
          accent={sportColor}
          options={SPORTS.map(({ id, label, icon: Icon }) => ({
            id,
            label: (
              <>
                <Icon className="seg-icon" />
                {label}
              </>
            )
          }))}
        />
        {hasBranches && (
          <Segmented
            label="Rama"
            size="sm"
            value={branch}
            onChange={setBranch}
            options={[
              { id: "masculino", label: "Masculino" },
              { id: "femenino", label: "Femenino" }
            ]}
          />
        )}
      </div>

      <main className="pub-main" key={pestana}>
        {pestana === "inicio" && (
          <>
            {liveMatches.length > 0 && <LiveRail matches={liveMatches} onTeam={abrirDesdeVivo} />}
            <div className="pub-grid">
              <section className="card">
                <SectionHead title="Tabla" action={() => irA("tabla")} />
                <Standings zones={data.zones} compact onTeam={abrirEquipo} />
              </section>
              <section className="card">
                <SectionHead title="Cruces" action={() => irA("cruces")} />
                <BracketView matches={data.bracket} onTeam={abrirEquipo} />
              </section>
            </div>
          </>
        )}

        {pestana === "tabla" && (
          <section className="card">
            <SectionHead title="Tabla de posiciones" />
            <Standings zones={data.zones} onTeam={abrirEquipo} />
            <p className="legend">
              {data.zones.some((z) => z.rows.some((r) => r.qualifies)) && (
                <>
                  <span className="legend-q" /> Clasifica a cruces ·{" "}
                </>
              )}
              Tocá un equipo para ver su ficha
            </p>
          </section>
        )}

        {pestana === "cruces" && (
          <section className="card">
            <SectionHead title="Cruces" />
            <BracketView matches={data.bracket} onTeam={abrirEquipo} />
          </section>
        )}

        {pestana === "historial" && (
          <section className="card">
            <SectionHead title="Resultados" />
            <Historial matches={data.historial} onTeam={abrirEquipo} />
          </section>
        )}
      </main>

      <nav className="tabbar" aria-label="Secciones" style={{ "--n": PESTANAS.length, "--i": tabIndex } as CSSProperties}>
        <span className="tabbar-thumb" aria-hidden="true" />
        {PESTANAS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={pestana === id ? "active" : ""} aria-current={pestana === id ? "page" : undefined} onClick={() => irA(id)}>
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <TeamSheet target={equipo} onClose={() => setEquipo(null)} />
      {accesoAbierto && <HojaAcceso onClose={() => setAccesoAbierto(false)} />}
    </div>
  );
}

/**
 * Botón con el logo del batallón organizador. Si todavía no se subió
 * public/logo-batallon.png, muestra un ícono genérico de acceso.
 */
function BotonAcceso({ onClick }: { onClick: () => void }) {
  const [sinLogo, setSinLogo] = useState(false);
  return (
    <button className="org-btn" type="button" aria-label="Acceso para organizadores y veedores" onClick={onClick}>
      {sinLogo ? <IconAccess /> : <img src="/logo-batallon.png" alt="" onError={() => setSinLogo(true)} />}
    </button>
  );
}

function HojaAcceso({ onClose }: { onClose: () => void }) {
  const [esStaff, setEsStaff] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet access-sheet" role="dialog" aria-modal="true" aria-labelledby="acceso-titulo" onClick={(e) => e.stopPropagation()}>
        {!esStaff ? (
          <>
            <div className="sheet-title" id="acceso-titulo">
              Aviso
            </div>
            <p className="access-intro">
              Este panel es solamente para agentes de la organización. Si sos un usuario común o un jugador, por favor volvé
              atrás: no hace falta que inicies sesión.
            </p>
            <button className="btn btn-primary" style={{ width: "100%" }} onClick={() => setEsStaff(true)}>
              Soy parte del staff
            </button>
          </>
        ) : (
          <>
            <div className="sheet-title" id="acceso-titulo">
              Acceso del staff
            </div>
            <Link className="access-option" to="/veedor/login">
              <span className="access-ico">
                <IconWhistle />
              </span>
              <div>
                <strong>Soy veedor</strong>
                <span>Cargás goles y tarjetas de los partidos que te asignaron. Entrás con tu PIN de 6 dígitos.</span>
              </div>
              <span className="access-arrow" aria-hidden="true">
                →
              </span>
            </Link>

            <Link className="access-option org" to="/admin/login">
              <span className="access-ico">
                <IconClipboard />
              </span>
              <div>
                <strong>Soy organizador</strong>
                <span>Equipos, jugadores, fixture, canchas, horarios y veedores. Entrás con tu email y contraseña.</span>
              </div>
              <span className="access-arrow" aria-hidden="true">
                →
              </span>
            </Link>
          </>
        )}

        <button className="btn btn-ghost" style={{ marginTop: 14, width: "100%" }} onClick={onClose}>
          Volver
        </button>
      </div>
    </div>
  );
}

function SectionHead({ title, action }: { title: string; action?: () => void }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {action && (
        <button type="button" className="link-btn" onClick={action}>
          Ver todo
        </button>
      )}
    </div>
  );
}

function TeamName({ team, onTeam, strong }: { team: Team; onTeam: (t: Team) => void; strong?: boolean }) {
  return (
    <button
      type="button"
      className={`team-btn ${strong ? "strong" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onTeam(team);
      }}
    >
      <Shield className="mini-shield" fill={team.shieldColor} />
      <span>{team.name}</span>
    </button>
  );
}

function LiveRail({ matches, onTeam }: { matches: LiveMatch[]; onTeam: (t: Team, m: LiveMatch) => void }) {
  return (
    <section className="live-section">
      <div className="section-head bare">
        <h2>
          <span className="live-dot" /> En vivo
        </h2>
      </div>
      <div className="live-rail">
        {matches.map((m) => (
          <article className="live-card" key={m.id} style={{ "--sport": `var(--color-${m.sport})` } as CSSProperties}>
            <div className="live-card-top">
              <span className="live-chip">{m.statusLabel}</span>
              <span className="live-meta">
                {m.ramaLabel}
                {m.court && ` · ${m.court}`}
              </span>
            </div>
            {[
              [m.home, m.homeScore, m.awayScore],
              [m.away, m.awayScore, m.homeScore]
            ].map(([team, sc, other]) => (
              <div className="live-row" key={(team as Team).id}>
                <TeamName team={team as Team} onTeam={(t) => onTeam(t, m)} strong={(sc as number) > (other as number)} />
                <span className="score tnum">{sc as number}</span>
              </div>
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}

function Standings({ zones, compact, onTeam }: { zones: ZoneStandings[]; compact?: boolean; onTeam: (t: Team) => void }) {
  if (zones.every((z) => z.rows.length === 0)) {
    return <p className="empty-note">Todavía no hay equipos cargados en esta categoría.</p>;
  }
  return (
    <div className="zones">
      {zones.map((zone) => {
        const empatados = zone.completa ? zone.rows.filter((r) => r.empatado) : [];
        return (
          <div className="zone" key={zone.id}>
            {zone.nombre && <div className="zone-name">{zone.nombre}</div>}
            <div className="table-wrap">
              <table className={`standings ${compact ? "compact" : ""}`}>
                <thead>
                  <tr>
                    <th className="pos">#</th>
                    <th className="team">Equipo</th>
                    <th>PJ</th>
                    {!compact && (
                      <>
                        <th>G</th>
                        <th>E</th>
                        <th>P</th>
                        <th className="wide">GF</th>
                        <th className="wide">GC</th>
                      </>
                    )}
                    <th>DG</th>
                    {!compact && (
                      <>
                        <th className="wide" title="Amarillas">
                          <i className="tcard y" />
                        </th>
                        <th className="wide" title="Rojas">
                          <i className="tcard r" />
                        </th>
                      </>
                    )}
                    <th className="pts">Pts</th>
                  </tr>
                </thead>
                <tbody>
                  {zone.rows.map((row) => (
                    <tr className={row.qualifies ? "q" : ""} key={row.team.id} onClick={() => onTeam(row.team)}>
                      <td className="pos tnum">
                        <span>{row.position}</span>
                      </td>
                      <td className="team">
                        <TeamName team={row.team} onTeam={onTeam} />
                      </td>
                      <td className="tnum">{row.played}</td>
                      {!compact && (
                        <>
                          <td className="tnum">{row.won}</td>
                          <td className="tnum">{row.drawn}</td>
                          <td className="tnum">{row.lost}</td>
                          <td className="tnum wide">{row.goalsFor}</td>
                          <td className="tnum wide">{row.goalsAgainst}</td>
                        </>
                      )}
                      <td className="tnum">
                        {row.goalDiff > 0 ? "+" : ""}
                        {row.goalDiff}
                      </td>
                      {!compact && (
                        <>
                          <td className="tnum wide">{row.amarillas}</td>
                          <td className="tnum wide">{row.rojas}</td>
                        </>
                      )}
                      <td className="pts tnum">{row.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {empatados.length > 0 && (
              <p className="notice">
                Empate total entre {empatados.map((r) => r.team.name).join(" y ")}: se define con un partido de desempate.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Historial({ matches, onTeam }: { matches: HistorialMatch[]; onTeam: (t: Team) => void }) {
  if (matches.length === 0) return <p className="empty-note">Acá van a aparecer los partidos a medida que terminen.</p>;
  return (
    <div className="history">
      {matches.map((m) => {
        const penales = m.penalesHome !== null && m.penalesAway !== null;
        const homeGana = m.homeScore !== m.awayScore ? m.homeScore > m.awayScore : penales && (m.penalesHome as number) > (m.penalesAway as number);
        const awayGana = m.homeScore !== m.awayScore ? m.awayScore > m.homeScore : penales && (m.penalesAway as number) > (m.penalesHome as number);
        return (
          <div className="duel" key={m.id}>
            <div className="duel-meta">
              {m.roundLabel}
              {m.date && ` · ${m.date}`}
              {penales && " · por penales"}
            </div>
            <div className={`duel-row ${homeGana ? "win" : ""}`}>
              <TeamName team={m.home} onTeam={onTeam} strong={homeGana} />
              <span className="score tnum">
                {m.homeScore}
                {penales && <small>({m.penalesHome})</small>}
              </span>
            </div>
            <div className={`duel-row ${awayGana ? "win" : ""}`}>
              <TeamName team={m.away} onTeam={onTeam} strong={awayGana} />
              <span className="score tnum">
                {m.awayScore}
                {penales && <small>({m.penalesAway})</small>}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
