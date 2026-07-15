import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Database,
  FileSearch,
  GitPullRequestArrow,
  Loader2,
  Network,
  RefreshCw,
  Route,
  ShieldCheck
} from "lucide-react";
import type { SourceDiscoveryMissionReport } from "@semantic-junkyard/shared";
import { runSourceDiscoveryMission } from "../api/client";
import type { AppSnapshot } from "../types/app";

interface OperatorControlRoomProps {
  snapshot: AppSnapshot | null;
  snapshotState: "loading" | "ready" | "degraded" | "error";
  onRefresh: () => Promise<boolean>;
  onNavigate: (sectionId: string) => void;
}

const defaultObjective = "Discover source structure, business semantics, governance signals, and safe action capabilities across every configured source.";

export function OperatorControlRoom({ snapshot, snapshotState, onRefresh, onNavigate }: OperatorControlRoomProps) {
  const [objective, setObjective] = useState(defaultObjective);
  const [provider, setProvider] = useState<"deterministic" | "local-huggingface">("deterministic");
  const [missionBusy, setMissionBusy] = useState(false);
  const [missionError, setMissionError] = useState<string | null>(null);
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [latestMission, setLatestMission] = useState<SourceDiscoveryMissionReport | null>(null);

  const missions = snapshot?.discoveryMissions ?? [];
  const selectedMission = latestMission?.id === selectedMissionId
    ? latestMission
    : missions.find((mission) => mission.id === selectedMissionId) ?? missions[0] ?? latestMission;
  const connectedSources = snapshot?.sourceConnections.filter((connection) => connection.status === "ready" || connection.status === "degraded").length ?? 0;
  const reviewQueue = snapshot?.semanticProposals.filter((proposal) => proposal.status === "proposed").length ?? 0;
  const verifiedRuns = snapshot?.actionRuns.filter((run) => run.status === "verified").length ?? 0;
  const verifiedActionRuns = snapshot?.actionRuns.filter((run) => run.status === "verified") ?? [];
  const writableConnections = snapshot?.sourceConnections.filter(
    (connection) => connection.config.kind !== "filesystem" && connection.config.writeMode !== "read_only"
  ).length ?? 0;
  const verifiedReflections = snapshot?.actionRuns.reduce(
    (total, run) => total + run.reflections.filter((reflection) => reflection.status === "verified").length,
    0
  ) ?? 0;
  const recentOperationalAudit = useMemo(
    () =>
      (snapshot?.auditEvents ?? [])
        .filter((event) =>
          event.action === "source_discovery.mission" ||
          event.action === "source_connection.sync" ||
          event.action === "semantic_proposal.decide" ||
          event.action.startsWith("business_action.")
        )
        .slice(0, 6),
    [snapshot?.auditEvents]
  );

  const totalSources = snapshot?.sourceConnections.length ?? 0;
  const fabricAvailable = snapshotState === "ready" || snapshotState === "degraded";
  const pipeline: Array<{
    label: string;
    value: string;
    detail: string;
    icon: ReactNode;
    status: "healthy" | "attention" | "inactive" | "unavailable";
  }> = [
    {
      label: "Connect",
      value: `${connectedSources}/${totalSources}`,
      detail: "sources online",
      icon: <Database size={15} />,
      status: totalSources === 0 ? "unavailable" : connectedSources === totalSources ? "healthy" : connectedSources > 0 ? "attention" : "unavailable"
    },
    {
      label: "Observe",
      value: String(snapshot?.sourceResources.length ?? 0),
      detail: "resources grounded",
      icon: <FileSearch size={15} />,
      status: (snapshot?.sourceResources.length ?? 0) > 0 ? "healthy" : connectedSources > 0 ? "attention" : "unavailable"
    },
    {
      label: "Govern",
      value: String(reviewQueue),
      detail: "proposals pending",
      icon: <ShieldCheck size={15} />,
      status: !fabricAvailable ? "unavailable" : reviewQueue > 0 ? "attention" : "healthy"
    },
    {
      label: "Act",
      value: String(snapshot?.actionRuns.length ?? 0),
      detail: "writeback runs",
      icon: <Route size={15} />,
      status: (snapshot?.actionRuns.length ?? 0) > 0 ? "healthy" : writableConnections > 0 ? "inactive" : "unavailable"
    },
    {
      label: "Verify",
      value: String(verifiedReflections),
      detail: "source readbacks",
      icon: <CheckCircle2 size={15} />,
      status: verifiedRuns > 0 ? "healthy" : (snapshot?.actionRuns.length ?? 0) > 0 ? "attention" : writableConnections > 0 ? "inactive" : "unavailable"
    }
  ];

  async function runMission() {
    setMissionBusy(true);
    setMissionError(null);
    try {
      const report = await runSourceDiscoveryMission({ objective: objective.trim(), provider, connectionIds: [], continueOnError: true });
      setLatestMission(report);
      setSelectedMissionId(report.id);
      if (!(await onRefresh())) {
        setMissionError("The mission completed, but the refreshed product snapshot could not be loaded.");
      }
    } catch (error) {
      setMissionError(error instanceof Error ? error.message : "Source discovery mission failed.");
    } finally {
      setMissionBusy(false);
    }
  }

  return (
    <section className="panel control-room" id="dashboard" aria-labelledby="control-room-title" aria-busy={missionBusy}>
      <header className="control-room-header">
        <div>
          <span className="eyebrow">Verified semantic operations</span>
          <h2 id="control-room-title">Operational control room</h2>
          <p>{connectedSources} connected sources · {snapshot?.sourceResources.length ?? 0} observed resources · {reviewQueue} proposals awaiting review</p>
        </div>
        <div className="control-room-state">
          <Activity size={16} />
          <span>{snapshotState === "ready" ? "Fabric ready" : snapshotState === "loading" ? "Loading fabric" : snapshotState}</span>
        </div>
      </header>

      <div className="protocol-pipeline" aria-label="Verified operation protocol">
        {pipeline.map((step, index) => (
          <div className={`protocol-step ${step.status}`} key={step.label}>
            <div className="protocol-step-icon">{step.icon}</div>
            <div>
              <span>{step.label}</span>
              <strong>{step.value}</strong>
              <small>{step.detail}</small>
            </div>
            {index < pipeline.length - 1 ? <ArrowRight className="protocol-arrow" size={14} /> : null}
          </div>
        ))}
      </div>

      <div className="control-room-grid">
        <section className="mission-console" aria-labelledby="mission-title">
          <div className="surface-heading">
            <div>
              <h3 id="mission-title">Source discovery mission</h3>
              <span>all configured connections</span>
            </div>
            <select aria-label="Mission semantic runtime" value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)} disabled={missionBusy}>
              <option value="deterministic">Deterministic</option>
              <option value="local-huggingface">Local Hugging Face</option>
            </select>
          </div>
          <div className="mission-command">
            <textarea aria-label="Discovery mission objective" value={objective} onChange={(event) => setObjective(event.target.value)} disabled={missionBusy} />
            <button className="primary-action" onClick={() => void runMission()} disabled={missionBusy || !objective.trim() || connectedSources === 0}>
              {missionBusy ? <Loader2 className="spin-icon" size={16} /> : <RefreshCw size={16} />}
              {missionBusy ? "Discovering" : "Run mission"}
            </button>
          </div>
          {missionError ? <div className="mission-error" role="alert">{missionError}</div> : null}
          {selectedMission ? (
            <div className="mission-receipt" aria-live="polite">
              <div className="receipt-heading">
                <span className={`run-status status-${selectedMission.status}`}>{selectedMission.status}</span>
                <strong>{formatTimestamp(selectedMission.completedAt)}</strong>
              </div>
              <div className="receipt-metrics">
                <div><strong>{selectedMission.summary.completedSyncs}/{selectedMission.summary.connectionsAttempted}</strong><span>sources synced</span></div>
                <div><strong>{selectedMission.summary.resourcesDiscovered}</strong><span>resources</span></div>
                <div><strong>{selectedMission.summary.assetsPublished}</strong><span>assets</span></div>
                <div><strong>{selectedMission.summary.proposalsAwaitingReview}</strong><span>to review</span></div>
              </div>
              {selectedMission.failures.length > 0 ? <p>{selectedMission.failures.map((failure) => `${failure.connectionName}: ${failure.message}`).join(" · ")}</p> : null}
            </div>
          ) : (
            <div className="empty-operational-state">No source-wide mission recorded</div>
          )}
          {missions.length > 1 ? (
            <div className="mission-history" aria-label="Recent discovery missions">
              {missions.slice(0, 4).map((mission) => (
                <button type="button" key={mission.id} className={selectedMission?.id === mission.id ? "selected" : ""} onClick={() => setSelectedMissionId(mission.id)}>
                  <span className={`status-dot status-${mission.status}`} />
                  <span>{formatTimestamp(mission.completedAt)}</span>
                  <strong>{mission.summary.completedSyncs}/{mission.summary.connectionsAttempted}</strong>
                </button>
              ))}
            </div>
          ) : null}
        </section>

        <section className="operation-history" aria-labelledby="operations-title">
          <div className="surface-heading">
            <div>
              <h3 id="operations-title">Verified action receipts</h3>
              <span>{verifiedRuns} completed</span>
            </div>
            <button className="text-command" type="button" onClick={() => onNavigate("actions")}>Open actions <ArrowRight size={14} /></button>
          </div>
          <div className="operation-list">
            {verifiedActionRuns.slice(0, 4).map((run) => (
              <button type="button" key={run.id} onClick={() => onNavigate("actions")}>
                <GitPullRequestArrow size={15} />
                <span><strong>{run.intent}</strong><small>{run.writes.length} writes · {run.reflections.filter((reflection) => reflection.status === "verified").length}/{run.reflections.length} verified readbacks</small></span>
                <span className={`run-status status-${run.status}`}>{run.status.replaceAll("_", " ")}</span>
              </button>
            ))}
            {verifiedActionRuns.length === 0 ? <div className="empty-operational-state">No verified source writeback receipt recorded</div> : null}
          </div>
        </section>

        <section className="audit-stream" aria-labelledby="audit-title">
          <div className="surface-heading">
            <div>
              <h3 id="audit-title">Operational audit</h3>
              <span>{recentOperationalAudit.length} recent events</span>
            </div>
            <Network size={17} />
          </div>
          <div className="audit-list">
            {recentOperationalAudit.map((event) => (
              <div key={event.id}>
                <span className={`status-dot decision-${event.decision}`} />
                <span><strong>{auditLabel(event.action)}</strong><small>{event.actor} · {formatTimestamp(event.createdAt)}</small></span>
                <span>{event.decision}</span>
              </div>
            ))}
            {recentOperationalAudit.length === 0 ? <div className="empty-operational-state">No operational event recorded</div> : null}
          </div>
        </section>
      </div>
    </section>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function auditLabel(action: string): string {
  const labels: Record<string, string> = {
    "source_discovery.mission": "Source discovery mission",
    "source_connection.sync": "Source synchronized",
    "semantic_proposal.decide": "Semantic proposal reviewed",
    "business_action.approve": "Action plan approved",
    "business_action.execute": "Business action executed",
    "business_action.dry_run": "Business action dry run"
  };
  return labels[action] ?? action.replaceAll("_", " ").replaceAll(".", " · ");
}
