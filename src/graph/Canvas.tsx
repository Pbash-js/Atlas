import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AtlasGraph, Edge } from "../schema/atlas";
import { FINISH_ID, START_ID, NODE_H, NODE_W, TERM_H, TERM_W } from "./layout";
import type { MutationIntent } from "../llm/mutator";
import type { Notice } from "../lib/notice";
import type { PlanModel } from "./model";
import { edgeStyle, pathH, pathV } from "./edges";
import { ST } from "./status";
import { C, fmt, numeral, plural } from "../lib/format";

interface View {
  x: number;
  y: number;
  k: number;
}

interface Hover {
  key: string;
  from: string;
  to: string;
  note: string;
}

interface Menu {
  x: number;
  y: number;
  nodeId: string | null;
}

type MenuKind = MutationIntent["kind"] | "reshape" | "fit";

interface MenuEntry {
  label: string;
  hint: string;
  kind: MenuKind;
}

const NODE_MENU: MenuEntry[] = [
  { label: "Edit this node", hint: "title, why, estimate", kind: "edit_node" },
  { label: "Rewrite the exit check", hint: "rubric", kind: "rewrite_check" },
  { label: "Add a prerequisite concept", hint: "insert above", kind: "insert_prereq" },
  { label: "Insert a recovery here", hint: "on failure", kind: "insert_recovery" },
  { label: "Explain it more simply", hint: "ask atlas", kind: "explain" },
  { label: "Prune from the plan", hint: "with reason", kind: "prune_node" },
];

const PLAN_MENU: MenuEntry[] = [
  { label: "Reshape the whole plan", hint: "re-derive", kind: "reshape" },
  { label: "Add a unit", hint: "new card", kind: "insert_unit" },
  // The design's "Open a new chapter" had nothing to act on: chapters are derived from ranks, so
  // there is no chapter to open, only names to set. Retitling is the operation that exists.
  { label: "Retitle the chapters", hint: "rename", kind: "retitle_chapters" },
  { label: "Fit the plan", hint: "view", kind: "fit" },
];

const LEGEND = [
  { label: "passed", token: "--at-passed", glyph: ST.passed.glyph, lock: false },
  { label: "in progress", token: "--at-progress", glyph: ST.in_progress.glyph, lock: false },
  { label: "ready", token: "--at-ready", glyph: ST.ready.glyph, lock: false },
  { label: "failed", token: "--at-failed", glyph: ST.failed.glyph, lock: false },
  { label: "locked", token: "--at-locked", glyph: "", lock: true },
];

function Padlock() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export interface CanvasProps {
  graph: AtlasGraph;
  model: PlanModel;
  selectedId: string | null;
  onSelect: (id: string) => void;
  arabic?: boolean;
  showLegend?: boolean;
  /** Runs a menu action or a free-text ask. Reshape is handled by the host, not the Mutator. */
  onAction?: (intent: MutationIntent | { kind: "reshape" }) => void;
  notices?: Notice[];
  onDismissNotice?: (id: string) => void;
  /** True while any action is in flight, so the menu can refuse to queue a second one. */
  busy?: boolean;
}

export function Canvas({
  graph,
  model,
  selectedId,
  onSelect,
  arabic = false,
  showLegend = true,
  onAction,
  notices = [],
  onDismissNotice,
  busy = false,
}: CanvasProps) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<Hover | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [chatText, setChatText] = useState("");

  const { layout, chapters, nums, bounds, byId, units } = model;

  const fit = useCallback(() => {
    const el = paneRef.current;
    const cw = el?.clientWidth ?? 900;
    const ch = el?.clientHeight ?? 700;
    const k = Math.min((cw - 150) / bounds.w, (ch - 130) / bounds.h, 1.2);
    setView({
      k,
      x: (cw - bounds.w * k) / 2 - bounds.minX * k + 18,
      y: (ch - bounds.h * k) / 2 - bounds.minY * k,
    });
  }, [bounds]);

  useEffect(() => {
    const id = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(id);
  }, [fit]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const zoom = useCallback((factor: number) => {
    const el = paneRef.current;
    const cw = el?.clientWidth ?? 900;
    const ch = el?.clientHeight ?? 700;
    setView((v) => {
      const k = Math.max(0.24, Math.min(1.6, v.k * factor));
      const s = k / v.k;
      return { k, x: cw / 2 - (cw / 2 - v.x) * s, y: ch / 2 - (ch / 2 - v.y) * s };
    });
  }, []);

  const panToY = useCallback((y: number) => {
    const ch = paneRef.current?.clientHeight ?? 700;
    setView((v) => ({ k: v.k, x: v.x, y: -y * v.k + ch * 0.22 }));
  }, []);

  // Wheel must be a non-passive native listener; React's onWheel cannot preventDefault.
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      zoom(ev.deltaY < 0 ? 1.08 : 1 / 1.08);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom]);

  const onPaneDown = (ev: React.MouseEvent) => {
    if (ev.button !== 0) return;
    const start = { mx: ev.clientX, my: ev.clientY, ...view };
    const move = (e: MouseEvent) =>
      setView({ k: start.k, x: start.x + e.clientX - start.mx, y: start.y + e.clientY - start.my });
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const openMenu = (ev: React.MouseEvent, nodeId: string | null) => {
    ev.preventDefault();
    ev.stopPropagation();
    const rect = paneRef.current?.getBoundingClientRect();
    setMenu({
      x: ev.clientX - (rect?.left ?? 0),
      y: ev.clientY - (rect?.top ?? 0),
      nodeId,
    });
  };

  /** Menu entries either move the viewport locally or hand a real intent to the host. */
  const runMenuEntry = (entry: MenuEntry, targetId: string | null) => {
    setMenu(null);
    if (entry.kind === "fit") {
      fit();
      return;
    }
    if (!onAction) return;
    if (entry.kind === "reshape" || entry.kind === "insert_unit" || entry.kind === "retitle_chapters") {
      onAction({ kind: entry.kind } as MutationIntent | { kind: "reshape" });
      return;
    }
    if (!targetId) return;
    onAction({ kind: entry.kind, nodeId: targetId } as MutationIntent);
  };

  // ── edges, including the synthetic Start / Finis spurs ──────────────────
  const { edges, markers } = useMemo(() => {
    const all: { e: Edge; key: string }[] = graph.edges.map((e, i) => ({ e, key: String(i) }));

    const roots = [...layout.rank.entries()].filter(([, r]) => r === 0).map(([id]) => id);
    const leaves = graph.nodes
      .filter(
        (n) =>
          n.type !== "RECOVERY" &&
          !graph.edges.some((e) => e.from === n.id && (e.type === "requires" || e.type === "then")),
      )
      .map((n) => n.id);

    for (const id of roots) {
      all.push({ e: { from: START_ID, to: id, type: "requires", strength: 1 }, key: `s${id}` });
    }
    for (const id of leaves) {
      all.push({ e: { from: id, to: FINISH_ID, type: "requires", strength: 1 }, key: `f${id}` });
    }

    const seen = new Set<string>();
    const markerList: { id: string; color: string }[] = [];
    const list: {
      key: string;
      d: string;
      stroke: string;
      width: number;
      dash: string;
      marker: string;
      opacity: number;
      from: string;
      to: string;
      note: string;
    }[] = [];

    for (const { e, key } of all) {
      const a = layout.pos.get(e.from);
      const b = layout.pos.get(e.to);
      if (!a || !b) continue;

      const st = edgeStyle(e.type, e.strength);
      const markerId =
        "cc" + (e.type === "on_fail" ? "f" : e.type === "if" ? "i" : st.width < 1.2 ? "w" : "n");
      if (!seen.has(markerId)) {
        seen.add(markerId);
        markerList.push({ id: markerId, color: st.stroke });
      }

      const fail = e.type === "on_fail";
      const aw = a.term ? TERM_W : NODE_W;
      const ah = a.term ? TERM_H : NODE_H;
      const bw = b.term ? TERM_W : NODE_W;

      const sx = fail ? a.x + aw : a.x + aw / 2;
      const sy = fail ? a.y + ah / 2 : a.y + ah;

      list.push({
        key,
        d: fail
          ? pathH(sx, sy, b.x, b.y + NODE_H / 2)
          : pathV(sx, sy, b.x + bw / 2, b.y),
        stroke: st.stroke,
        width: hover?.key === key ? st.width + 0.9 : st.width,
        dash: st.dash ?? "none",
        marker: `url(#${markerId})`,
        opacity: hover ? (hover.key === key ? 1 : 0.14) : 1,
        from: e.from,
        to: e.to,
        note: st.note,
      });
    }

    return { edges: list, markers: markerList };
  }, [graph, layout, hover]);

  const dimmed = (id: string) => Boolean(hover && hover.from !== id && hover.to !== id);

  const menuItems = menu?.nodeId ? NODE_MENU : PLAN_MENU;
  const menuTarget = menu?.nodeId ? byId.get(menu.nodeId) : null;

  const activeChapter = selectedId ? chapters.chapterOf.get(selectedId) : undefined;
  const bandEnd = bounds.minY + bounds.h;

  return (
    <div
      className="pane"
      ref={paneRef}
      onMouseDown={onPaneDown}
      onContextMenu={(ev) => openMenu(ev, null)}
    >
      <div
        className="viewport"
        style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.k})` }}
      >
        {chapters.chapters.map((c) => (
          <div key={`gate-${c.i}`}>
            <div
              className="gate__rule"
              style={{
                left: 20,
                top: c.y,
                width: layout.spanW + 56,
                background: c.open ? C("--at-gold") : C("--at-rule"),
                opacity: c.open ? 0.55 : 1,
              }}
            />
            <div
              className="gate__label"
              style={{ left: layout.centreX - 210, top: c.y - 17, width: 420 }}
            >
              <span
                className="gate__seal tnum"
                style={{
                  border: `1px solid ${c.sealed ? C("--at-gold") : C("--at-rule")}`,
                  background: c.sealed ? C("--at-gold-ghost") : "transparent",
                  color: c.sealed ? C("--at-gold") : C("--at-faint"),
                }}
              >
                {numeral(c.i, arabic)}
              </span>
              <span className="gate__title">{c.title}</span>
              <span
                className="gate__note"
                style={{ color: c.sealed ? C("--at-gold") : C("--at-faint") }}
              >
                {c.sealed
                  ? `sealed · ${c.passed} of ${c.units}`
                  : c.open
                    ? `open · ${c.passed} of ${c.units} passed`
                    : `opens when Chapter ${numeral(c.i - 1, arabic)} is sealed`}
              </span>
            </div>
          </div>
        ))}

        <svg
          width={bounds.minX + bounds.w + 140}
          height={bounds.minY + bounds.h + 140}
          style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}
        >
          <defs>
            {markers.map((m) => (
              <marker
                key={m.id}
                id={m.id}
                markerWidth="9"
                markerHeight="9"
                viewBox="0 0 10 10"
                refX="7"
                refY="5"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M0,1.5 L8,5 L0,8.5" fill="none" stroke={m.color} strokeWidth="1.2" />
              </marker>
            ))}
          </defs>
          {edges.map((e) => (
            <g key={e.key}>
              <path
                d={e.d}
                fill="none"
                stroke={e.stroke}
                strokeWidth={e.width}
                strokeDasharray={e.dash}
                markerEnd={e.marker}
                opacity={e.opacity}
              />
              <path
                d={e.d}
                fill="none"
                stroke="transparent"
                strokeWidth={16}
                style={{ pointerEvents: "stroke", cursor: "help" }}
                onMouseEnter={() =>
                  setHover({ key: e.key, from: e.from, to: e.to, note: e.note })
                }
                onMouseLeave={() => setHover(null)}
              >
                <title>{e.note}</title>
              </path>
            </g>
          ))}
        </svg>

        {[START_ID, FINISH_ID].map((id) => {
          const p = layout.pos.get(id);
          if (!p) return null;
          return (
            <div
              key={id}
              className="term"
              style={{
                left: p.x,
                top: p.y,
                width: TERM_W,
                height: TERM_H,
                opacity: dimmed(id) ? 0.16 : 1,
              }}
            >
              <span className="term__title">{id === START_ID ? "Start" : "Finis"}</span>
              <span className="term__meta">
                {id === START_ID
                  ? `${units.length} units · ${plural(chapters.chapters.length, "chapter")}`
                  : "the capability, demonstrated"}
              </span>
            </div>
          );
        })}

        {graph.nodes.map((n) => {
          const p = layout.pos.get(n.id);
          if (!p) return null;

          const gated = chapters.isGated(n.id);
          const meta = ST[gated && n.status === "locked" ? "locked" : n.status];
          const isRecovery = n.type === "RECOVERY";
          const isDecision = n.type === "DECISION";
          const isSelected = n.id === selectedId;
          const locked = n.status === "locked" || gated;
          const est = n.type === "UNIT" || isRecovery ? fmt(n.estimate_min) : "";
          const chapterIndex = chapters.chapterOf.get(n.id) ?? 0;

          const classes = [
            "node",
            isRecovery ? "is-recovery" : "",
            isDecision ? "is-decision" : "",
            isSelected ? "is-selected" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <div
              key={n.id}
              className={classes}
              style={{
                left: p.x,
                top: p.y,
                width: NODE_W,
                height: NODE_H,
                borderLeft: `3px solid ${C(meta.token)}`,
                boxShadow: isSelected
                  ? `0 0 0 1px ${C("--at-gold-ghost")}, 0 6px 22px rgba(0,0,0,.28)`
                  : `0 1px 0 ${C("--at-rule-soft")}`,
                opacity: dimmed(n.id) ? 0.14 : locked ? 0.6 : 1,
              }}
              onClick={(ev) => {
                ev.stopPropagation();
                onSelect(n.id);
                setMenu(null);
              }}
              onMouseDown={(ev) => ev.stopPropagation()}
              onContextMenu={(ev) => {
                onSelect(n.id);
                openMenu(ev, n.id);
              }}
            >
              <div className="node__top">
                <span className="node__num tnum">{nums.get(n.id) ?? ""}</span>
                <span className="node__kind">
                  {n.type === "UNIT" ? n.kind : isRecovery ? "recovery" : "decision"}
                </span>
                <span className="node__status" style={{ color: C(meta.token) }}>
                  {locked && <Padlock />}
                  {gated && n.status === "locked"
                    ? `chapter ${numeral(chapterIndex, arabic)}`
                    : meta.label}
                </span>
              </div>

              <div className="node__title">{n.title}</div>

              <div className="node__foot tnum">
                <span>{est}</span>
                {n.type === "UNIT" && n.attempts > 0 && n.status !== "passed" && (
                  <span className="node__attempts">{plural(n.attempts, "attempt")}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rail">
        {chapters.chapters.map((c, i) => {
          const next = chapters.chapters[i + 1];
          const nextY = next ? next.y : bandEnd;
          const slot = Math.max(28, (nextY - c.y) * view.k);
          // The label is vertical and centre-aligned, so a title longer than its slot would clip
          // to its own middle and read as gibberish. Budget characters against the slot instead.
          const full = `${numeral(c.i, arabic)} · ${c.title}`;
          const budget = Math.max(4, Math.floor((slot - 16) / 7.2));
          const label = full.length > budget ? `${full.slice(0, Math.max(1, budget - 1))}…` : full;
          return (
            <button
              key={c.i}
              className="rail__btn"
              title={`${c.title} — ${c.sealed ? "sealed" : c.open ? "open" : "shut"}`}
              style={{
                top: c.y * view.k + view.y,
                height: slot,
                background: c.i === activeChapter ? C("--at-gold-ghost") : "transparent",
                color:
                  c.i === activeChapter
                    ? C("--at-gold")
                    : c.open
                      ? C("--at-dim")
                      : C("--at-faint"),
                opacity: c.open ? 1 : 0.6,
              }}
              onMouseDown={(ev) => ev.stopPropagation()}
              onClick={() => panToY(c.y)}
            >
              <span className="rail__label">{label}</span>
            </button>
          );
        })}
      </div>

      <div className="ctrls" onMouseDown={(ev) => ev.stopPropagation()}>
        <button className="ctrls__btn" title="closer" onClick={() => zoom(1.2)}>
          ＋
        </button>
        <button className="ctrls__btn" title="further" onClick={() => zoom(1 / 1.2)}>
          −
        </button>
        <button className="ctrls__btn" title="fit the whole plan" onClick={fit}>
          ▢
        </button>
      </div>

      {showLegend && (
        <div className="legend" onMouseDown={(ev) => ev.stopPropagation()}>
          {LEGEND.map((l) => (
            <span key={l.label} className="legend__row" style={{ color: C(l.token) }}>
              {l.lock ? <Padlock /> : <span className="legend__glyph">{l.glyph}</span>}
              <span style={{ color: C("--at-faint") }}>{l.label}</span>
            </span>
          ))}
        </div>
      )}

      <div className="chat">
        <div className="chat__inner" onMouseDown={(ev) => ev.stopPropagation()}>
          {notices.map((n) => (
            <div key={n.id} className={`chat__line is-${n.status}`}>
              <span className="chat__line-text">{n.text}</span>
              {onDismissNotice && (
                <button
                  className="chat__line-x"
                  title="dismiss"
                  aria-label="Dismiss"
                  onClick={() => onDismissNotice(n.id)}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <form
            className="chat__form"
            onSubmit={(ev) => {
              ev.preventDefault();
              const q = chatText.trim();
              if (!q || busy || !onAction) return;
              setChatText("");
              onAction({ kind: "ask", text: q, nodeId: selectedId });
            }}
          >
            <span className="chat__mark">❦</span>
            <input
              className="chat__input"
              type="text"
              placeholder="Ask Atlas — reshape the plan, add a concept, explain a node"
              value={chatText}
              disabled={busy}
              onChange={(e) => setChatText(e.target.value)}
            />
            <button className="chat__send" type="submit" disabled={busy || !chatText.trim()}>
              {busy ? "…" : "Ask"}
            </button>
          </form>
          <div className="chat__hint">
            <span>{hover ? hover.note : "Right-click a card for node actions"}</span>
          </div>
        </div>
      </div>

      {menu && (
        <div
          className="menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(ev) => ev.stopPropagation()}
          onClick={(ev) => ev.stopPropagation()}
        >
          <div className="menu__head">
            {menuTarget
              ? `${nums.get(menuTarget.id) ?? ""} · ${menuTarget.title}`
              : "The plan"}
          </div>
          {menuItems.map((it) => (
            <button
              key={it.label}
              className="menu__item"
              disabled={busy && it.kind !== "fit"}
              onClick={() => runMenuEntry(it, menu.nodeId)}
            >
              <span>{it.label}</span>
              <span className="menu__hint">{it.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
