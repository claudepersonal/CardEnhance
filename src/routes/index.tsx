import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell } from "@/components/studio/app-nav";
import { PageEmpty, PageError, PagePending } from "@/components/studio/page-states";
import { listStoredCards, listAuditLogs } from "@/lib/connectors/persist";
import { checkConnectors, type ConnectorStatus } from "@/lib/connectors/status";
import { Upload, ShieldCheck, Activity, Layers, Scan, Wand, FileOutput } from "lucide-react";

export const Route = createFileRoute("/")({
  loader: async () => {
    const [cards, status, logs] = await Promise.all([
      listStoredCards(),
      checkConnectors(),
      listAuditLogs(),
    ]);
    return { cards, status, logs };
  },
  pendingComponent: () => (
    <PageShell current="/">
      <PagePending label="Loading dashboard" />
    </PageShell>
  ),
  errorComponent: () => (
    <PageShell current="/">
      <PageError message="Failed to load dashboard" />
    </PageShell>
  ),
  component: Dashboard,
});


function formatCardDate(value: string | null | undefined): string {
  if (!value) return "\u2014";
  // DB rows may arrive as "YYYY-MM-DD HH:MM:SS" (no T, UTC) which Safari rejects
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value) ? value.replace(" ", "T") + "Z" : value;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
}

function Dashboard() {
  const { cards, status, logs } = Route.useLoaderData();
  const processed = cards.filter((c: any) => c.status === "completed").length;
  const connectorList = Object.entries(status);
  const liveCount = connectorList.filter(([, s]: [string, any]) => s?.ok || s?.connected).length;

  const stats = [
    { label: "Cards in Library", value: cards.length, icon: Layers, color: "#00c8c8" },
    { label: "Processed", value: processed, icon: ShieldCheck, color: "#0f0" },
    { label: "Audit Entries", value: logs.length, icon: Activity, color: "#ff0" },
    { label: "Connectors Live", value: `${liveCount}/${connectorList.length}`, icon: Upload, color: "#08f" },
  ];

  const pipeline = [
    { label: "Detect", icon: Scan },
    { label: "Rectify", icon: Layers },
    { label: "OCR", icon: Activity },
    { label: "Enhance", icon: Wand },
    { label: "Export", icon: FileOutput },
  ];

  const quickActions = [
    { label: "Open Studio", href: "/studio", primary: true },
    { label: "View Library", href: "/library" },
    { label: "Audit Log", href: "/audit" },
    { label: "Connectors", href: "/connectors" },
  ];

  if (cards.length === 0 && logs.length === 0) {
    return (
      <PageShell current="/">
        <PageEmpty
          title="No cards yet"
          body="Open the studio to upload and process your first card scans"
          action={
            <Link to="/studio" className="btn-primary">
              Open Studio
            </Link>
          }
        />
      </PageShell>
    );
  }

  return (
    <PageShell current="/">
      <div className="dashboard">
        <section className="stats-grid">
          {stats.map((s) => (
            <div key={s.label} className="stat-card">
              <s.icon size={20} color={s.color} />
              <div className="stat-value">{s.value}</div>
              <div className="stat-label">{s.label}</div>
            </div>
          ))}
        </section>

        <section className="pipeline">
          <h3>Pipeline</h3>
          <div className="pipeline-stages">
            {pipeline.map((stage, i) => (
              <div key={stage.label} className="pipeline-stage">
                <stage.icon size={18} />
                <span>{stage.label}</span>
                {i < pipeline.length - 1 && <span className="arrow">→</span>}
              </div>
            ))}
          </div>
        </section>

        <section className="two-col">
          <div className="col-left">
            <h3>Recent Cards</h3>
            {cards.length === 0 ? (
              <p className="muted">No cards processed yet.</p>
            ) : (
              <table className="card-table">
                <thead>
                  <tr>
                    <th>Filename</th>
                    <th>Player</th>
                    <th>Status</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {cards.slice(0, 8).map((card: any) => (
                    <tr key={card.id}>
                      <td>{card.filename}</td>
                      <td>{card.player ?? "-"}</td>
                      <td>
                        <span className={`badge ${card.status}`}>{card.status}</span>
                      </td>
                      <td>{formatCardDate(card.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="col-right">
            <h3>Connectors</h3>
            <div className="connector-list">
              {connectorList.map(([name, s]: [string, any]) => (
                <div key={name} className={`connector-pill ${s?.ok || s?.connected ? "ok" : "err"}`}>
                  <span className="dot" />
                  <span>{name}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="actions">
          {quickActions.map((a) => (
            <Link key={a.href} to={a.href} className={a.primary ? "btn-primary" : "btn-secondary"}>
              {a.label}
            </Link>
          ))}
        </section>
      </div>
    </PageShell>
  );
}
