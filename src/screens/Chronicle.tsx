import type { AtlasGraph } from "../schema/atlas";
import type { PlanModel } from "../graph/model";
import { C } from "../lib/format";

interface Props {
  graph: AtlasGraph;
  model: PlanModel;
  onOpenNode: (id: string) => void;
}

const kindColour = (type: string) =>
  type === "passed"
    ? C("--at-passed")
    : type === "failed"
      ? C("--at-failed")
      : type === "node_inserted"
        ? C("--at-gold")
        : C("--at-faint");

export function Chronicle({ graph, model, onOpenNode }: Props) {
  const days: { day: string; items: React.ReactNode[] }[] = [];

  for (const [i, ev] of graph.events.entries()) {
    const at = new Date(ev.at);
    const day = at.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

    let bucket = days.find((d) => d.day === day);
    if (!bucket) {
      bucket = { day, items: [] };
      days.push(bucket);
    }

    const title = ev.node ? (model.byId.get(ev.node)?.title ?? ev.node) : "—";

    bucket.items.push(
      <div key={i} className="chron__ev">
        <span className="chron__time tnum">
          {at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
        </span>
        <span className="chron__kind" style={{ color: kindColour(ev.type) }}>
          {ev.type.replace("_", " ")}
        </span>
        <span>
          <button className="chron__link" onClick={() => ev.node && onOpenNode(ev.node)}>
            {title}
          </button>
          {ev.detail && <span className="chron__detail">{ev.detail}</span>}
          {ev.minutes !== undefined && (
            <span className="chron__min tnum">
              {ev.minutes} min{ev.modality ? ` · ${ev.modality}` : ""}
            </span>
          )}
        </span>
      </div>,
    );
  }

  return (
    <div className="scroll">
      <div className="chron">
        <div className="kicker">Chronicle</div>
        <h2 className="chron__h">What has happened so far</h2>
        <p className="chron__lede">
          Every opening, pass, failure and repair, in the order it occurred.
        </p>

        {days.map((d) => (
          <div key={d.day} className="chron__day">
            <div className="chron__date tnum">{d.day}</div>
            {d.items}
          </div>
        ))}
      </div>
    </div>
  );
}
