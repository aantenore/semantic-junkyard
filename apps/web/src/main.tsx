import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Activity,
  Braces,
  CheckCircle2,
  CircleDot,
  Copy,
  Database,
  FileSearch,
  GitBranch,
  LineChart,
  Loader2,
  LockKeyhole,
  Network,
  Play,
  RefreshCw,
  Route,
  Search,
  Send,
  ShieldCheck,
  Upload,
  Workflow,
  Zap
} from "lucide-react";
import type { BusinessActionApproval, BusinessActionPlan, BusinessActionRun, SearchResult } from "@semantic-junkyard/shared";
import { ActionTargetSurface } from "./components/ActionTargetSurface";
import { GraphCanvas } from "./components/GraphCanvas";
import { IconButton } from "./components/IconButton";
import { OperatorControlRoom } from "./components/OperatorControlRoom";
import { SourceWorkbench } from "./components/SourceWorkbench";
import { apiHref, approveBusinessAction, curateRelation, executeBusinessAction, ingestText, loadSnapshot, planBusinessAction, previewIngest, runDiscovery, semanticSearch } from "./api/client";
import type { AppSnapshot, CuratedRelationReport, IngestPreviewReport } from "./types/app";
import { starterText } from "./data/sample";
import "./styles.css";

const POC_APP_URL = import.meta.env.VITE_POC_URL || (import.meta.env.DEV ? "http://localhost:5174" : "/poc/");

function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [query, setQuery] = useState("Late Dispatch Rate");
  const [mode, setMode] = useState<"hybrid" | "lexical" | "vector" | "graph">("hybrid");
  const [text, setText] = useState(starterText);
  const [name, setName] = useState("agent-discovery-note.md");
  const [ingestionMode, setIngestionMode] = useState<"full_data" | "metadata_only" | "external_reference">("full_data");
  const [ingestPreview, setIngestPreview] = useState<IngestPreviewReport | null>(null);
  const [curationSource, setCurationSource] = useState("Late Dispatch Rate");
  const [curationRelation, setCurationRelation] = useState("USES_DENOMINATOR");
  const [curationTarget, setCurationTarget] = useState("Dispatch Eligible Orders");
  const [curationRationale, setCurationRationale] = useState("Supply-chain owner confirmed the governed denominator.");
  const [curatedRelation, setCuratedRelation] = useState<CuratedRelationReport | null>(null);
  const [businessIntent, setBusinessIntent] = useState("Set order ORD-1001 status to dispatched");
  const [actionPlan, setActionPlan] = useState<BusinessActionPlan | null>(null);
  const [actionRun, setActionRun] = useState<BusinessActionRun | null>(null);
  const [actionApproval, setActionApproval] = useState<BusinessActionApproval | null>(null);
  const [actionMode, setActionMode] = useState<"autonomous" | "approval_required" | "dry_run">("autonomous");
  const [actionRisk, setActionRisk] = useState<"low" | "medium" | "high">("medium");
  const [actionPhase, setActionPhase] = useState<"idle" | "planning" | "planned" | "executing" | "reflected" | "verified" | "approval_required" | "reconciliation_required" | "blocked" | "failed">("idle");
  const [actionNotice, setActionNotice] = useState("Write a business request, then plan it before execution.");
  const [approvalRationale, setApprovalRationale] = useState("");
  const [approvalAttested, setApprovalAttested] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [lastActionAt, setLastActionAt] = useState<string | null>(null);
  const [fingerprintCopied, setFingerprintCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshotState, setSnapshotState] = useState<"loading" | "ready" | "degraded" | "error">("loading");
  const [activeSection, setActiveSection] = useState("dashboard");
  const initializedRef = useRef(false);
  const searchRequestRef = useRef(0);
  const actionPlanRequestRef = useRef(0);

  async function refresh(): Promise<boolean> {
    setSnapshotState("loading");
    setError(null);
    try {
      const next = await loadSnapshot();
      setSnapshot(next);
      setSnapshotState(next.degraded.length > 0 ? "degraded" : "ready");
      if (next.degraded.length > 0) setError(`Product loaded with unavailable optional surfaces: ${next.degraded.join(", ")}.`);
      return true;
    } catch (err) {
      setSnapshotState("error");
      setError(err instanceof Error ? err.message : "API unavailable");
      return false;
    }
  }

  async function executeSearch(nextQuery = query, nextMode = mode) {
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setBusy(true);
    setError(null);
    try {
      const response = await semanticSearch(nextQuery, nextMode);
      if (searchRequestRef.current === requestId) setSearchResults(response.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void (async () => {
      if (await refresh()) await executeSearch();
    })();
  }, []);

  const groupedModules = useMemo(() => {
    const modules = snapshot?.status.modules ?? [];
    return modules.reduce<Record<string, typeof modules>>((acc, module) => {
      acc[module.kind] = [...(acc[module.kind] ?? []), module];
      return acc;
    }, {});
  }, [snapshot]);

  const latestRun = snapshot?.discoveryRuns[0];
  const selectedEntities = snapshot?.graph.nodes.slice(0, 6) ?? [];
  const actionSteps = [
    {
      label: "Resolve intent",
      done: Boolean(actionPlan || actionRun),
      active: actionPhase === "planning",
      detail: actionPlan?.actionType ?? "waiting"
    },
    {
      label: "Plan writes",
      done: Boolean(actionPlan?.targets.length || actionRun?.writes.length),
      active: actionPhase === "planned",
      detail: actionPlan ? `${actionPlan.targets.length} targets` : "not planned"
    },
    {
      label: "Write sources",
      done: Boolean(actionRun?.writes.length),
      active: actionPhase === "executing",
      detail: actionRun ? `${actionRun.writes.length} writes` : "not executed"
    },
    {
      label: "Reflect read model",
      done: actionRun?.status === "verified",
      active: actionPhase === "verified",
      detail: actionRun ? `${actionRun.reflections.filter((item) => item.status === "verified").length}/${actionRun.reflections.length} verified` : "not reflected"
    }
  ];
  const moduleLabels: Record<string, string> = {
    "business-action-router": "Actions",
    connector: "Connectors",
    parser: "Parser",
    chunker: "Chunker",
    embedding: "Embedding",
    "metadata-store": "Metadata",
    "lexical-store": "Lexical",
    "vector-store": "Vector",
    "graph-store": "Graph",
    "policy-engine": "Policy",
    "ontology-validator": "Ontology",
    "lineage-collector": "Lineage",
    "agent-protocol": "Agent API",
    "writeback-gateway": "Writeback",
    "reflection-engine": "Reflection"
  };
  const navigationItems = [
    { id: "dashboard", label: "Dashboard", icon: <Activity size={17} /> },
    { id: "sources", label: "Sources", icon: <Database size={17} /> },
    { id: "ingest", label: "Ingest", icon: <Upload size={17} /> },
    { id: "actions", label: "Actions", icon: <Route size={17} /> },
    { id: "graph", label: "Graph", icon: <Network size={17} /> },
    { id: "agents", label: "Agents", icon: <Zap size={17} /> },
    { id: "discovery", label: "Discovery", icon: <FileSearch size={17} /> }
  ];

  function navigateTo(sectionId: string) {
    setActiveSection(sectionId);
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function invalidateActionPlan() {
    actionPlanRequestRef.current += 1;
    setActionBusy(false);
    setActionPlan(null);
    setActionRun(null);
    setActionApproval(null);
    setFingerprintCopied(false);
    setApprovalRationale("");
    setApprovalAttested(false);
    setActionPhase("idle");
    setActionNotice("Request or policy changed. Create a new plan before execution.");
  }

  function applyBusinessPreset(intent: string) {
    setBusinessIntent(intent);
    invalidateActionPlan();
  }

  async function onIngest() {
    setBusy(true);
    setError(null);
    try {
      await ingestText(ingestInput());
      setIngestPreview(null);
      if (await refresh()) {
        await executeSearch(query, mode);
      } else {
        setError("Ingestion succeeded, but the refreshed product snapshot could not be loaded. Use Refresh before retrying.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ingest failed");
    } finally {
      setBusy(false);
    }
  }

  async function onPreviewIngest() {
    setBusy(true);
    setError(null);
    try {
      setIngestPreview(await previewIngest(ingestInput()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  }

  async function onCurateRelation() {
    setBusy(true);
    setError(null);
    try {
      const relation = await curateRelation({
        sourceName: curationSource,
        sourceType: "Concept",
        targetName: curationTarget,
        targetType: "Concept",
        relationType: curationRelation,
        rationale: curationRationale
      });
      setCuratedRelation(relation);
      if (!(await refresh())) {
        setError("Curation succeeded, but the refreshed graph could not be loaded. Use Refresh before retrying.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Curation failed");
    } finally {
      setBusy(false);
    }
  }

  async function onPlanBusinessAction() {
    const requestId = actionPlanRequestRef.current + 1;
    actionPlanRequestRef.current = requestId;
    const request = { intent: businessIntent.trim(), mode: actionMode, maxAutonomousRisk: actionRisk };
    setActionBusy(true);
    setError(null);
    setActionRun(null);
    setActionApproval(null);
    setFingerprintCopied(false);
    setApprovalRationale("");
    setApprovalAttested(false);
    setActionPhase("planning");
    setActionNotice("Planning source writes from the business intent...");
    try {
      const plan = await planBusinessAction(request);
      if (actionPlanRequestRef.current !== requestId) return;
      setActionPlan(plan);
      setActionPhase(plan.status === "blocked" ? "blocked" : plan.status === "approval_required" ? "approval_required" : "planned");
      setActionNotice(
        plan.status === "blocked"
          ? plan.warnings.join(" ")
          : `${plan.targets.length} source targets planned. Review the diffs${plan.status === "approval_required" ? ", approve the exact fingerprint," : ""} then execute.`
      );
      setLastActionAt(new Date().toLocaleTimeString());
    } catch (err) {
      if (actionPlanRequestRef.current !== requestId) return;
      setActionPhase("failed");
      setActionNotice("Planning failed. Check the error banner.");
      setError(err instanceof Error ? err.message : "Business action planning failed");
    } finally {
      if (actionPlanRequestRef.current === requestId) setActionBusy(false);
    }
  }

  async function onApproveBusinessAction() {
    if (!actionPlan || actionPlan.status !== "approval_required" || !approvalAttested || !approvalRationale.trim()) return;
    setActionBusy(true);
    setError(null);
    try {
      const approval = await approveBusinessAction(actionPlan, approvalRationale.trim());
      setActionApproval(approval);
      setActionNotice(`Plan approved by ${approval.approvedBy}. Approval ${approval.id} is valid for this fingerprint once.`);
      setLastActionAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Business action approval failed");
    } finally {
      setActionBusy(false);
    }
  }

  async function copyPlanFingerprint() {
    if (!actionPlan) return;
    try {
      await navigator.clipboard.writeText(actionPlan.fingerprint);
      setFingerprintCopied(true);
    } catch {
      setError("The plan fingerprint could not be copied from this browser context.");
    }
  }

  async function onExecuteBusinessAction() {
    const executableStatus = actionPlan?.status === "planned" || actionPlan?.status === "approval_required";
    if (
      !actionPlan ||
      !executableStatus ||
      actionPlan.intent !== businessIntent.trim() ||
      actionPlan.mode !== actionMode ||
      actionPlan.maxAutonomousRisk !== actionRisk
    ) {
      setError("Create and review a current plan before execution.");
      return;
    }
    setActionBusy(true);
    setError(null);
    setActionPhase("executing");
    setActionNotice("Executing through writeback gateway, then rereading source systems...");
    try {
      const run = await executeBusinessAction({
        plan: actionPlan,
        approvalId: actionApproval?.id,
        idempotencyKey: `${actionPlan.id}:${actionPlan.fingerprint}`
      });
      setActionRun(run);
      setActionPlan(run.plan);
      setActionPhase(
        run.status === "verified"
          ? "verified"
          : run.status === "reflected"
            ? "reflected"
            : run.status === "approval_required"
              ? "approval_required"
              : run.status === "reconciliation_required"
                ? "reconciliation_required"
              : run.status === "blocked"
                ? "blocked"
                : run.status === "planned"
                  ? "planned"
                  : "failed"
      );
      setActionNotice(
        run.status === "verified"
          ? `${run.writes.filter((item) => item.status === "executed").length} source mutations and ${run.writes.filter((item) => item.status === "skipped").length} verified no-ops; ${run.reflections.filter((item) => item.status === "verified").length}/${run.reflections.length} reflections verified. Search results were refreshed from source evidence.`
          : run.status === "reflected"
            ? "Source readback reported drift or missing state. Only verified writes were added to the semantic read model."
            : run.status === "reconciliation_required"
              ? "The source outcome is ambiguous. Reconcile the authoritative source before creating another execution."
            : `No source completion was claimed. Action status: ${run.status}.`
      );
      setLastActionAt(new Date().toLocaleTimeString());
      if (run.status === "verified" || run.status === "reflected") {
        if (await refresh()) {
          await executeSearch(businessIntent, "hybrid");
        } else {
          setError(`The ${run.status} run was saved, but the refreshed snapshot could not be loaded. Use Refresh; do not execute again.`);
        }
      }
    } catch (err) {
      setActionPhase("failed");
      setActionNotice("Execution failed. Check the error banner.");
      setError(err instanceof Error ? err.message : "Business action execution failed");
    } finally {
      setActionBusy(false);
    }
  }

  async function onDiscovery() {
    setBusy(true);
    setError(null);
    try {
      await runDiscovery("Discover what an autonomous agent can safely do with this semantic layer.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Discovery failed");
    } finally {
      setBusy(false);
    }
  }

  function ingestInput() {
    return {
      name,
      text,
      ingestionMode,
      mimeType: name.endsWith(".html") ? "text/html" : name.endsWith(".json") ? "application/json" : name.endsWith(".md") ? "text/markdown" : "text/plain"
    };
  }

  function writeForStep(stepId: string) {
    return actionRun?.writes.find((write) => write.stepId === stepId);
  }

  function reflectionForStep(stepId: string) {
    const write = writeForStep(stepId);
    return write ? actionRun?.reflections.find((reflection) => reflection.writeId === write.id) : undefined;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Database size={24} />
          <span>Semantic Junkyard</span>
        </div>
        <nav className="nav-list" aria-label="Product sections">
          {navigationItems.map((item) => (
            <button
              className={`nav-item ${activeSection === item.id ? "active" : ""}`}
              key={item.id}
              onClick={() => navigateTo(item.id)}
              aria-label={item.label}
              title={item.label}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="workspace-card">
          <span>Workspace</span>
          <strong>Local Junkyard</strong>
          <small>Role: owner</small>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="topbar-section">
            <span className="meta-label">Semantic control plane</span>
            <strong className="mobile-product-name">Semantic Junkyard</strong>
            <strong>Semantic Junkyard</strong>
            <span className={`status-pill status-${snapshotState}`}>{snapshotState === "ready" ? "Active" : snapshotState === "loading" ? "Loading" : snapshotState === "degraded" ? "Degraded" : "Unavailable"}</span>
          </div>
          <div className="topbar-section wide">
            <span className="meta-label">Provider</span>
            <strong>{snapshot?.provider ? `${snapshot.provider.kind} · ${snapshot.provider.model}` : snapshotState === "loading" ? "Loading provider" : "Provider unavailable"}</strong>
            <span className="dot" />
            <a className="external-app-link" href={POC_APP_URL} target="_blank" rel="noreferrer">
              <Zap size={14} />
              Open PoC app
            </a>
          </div>
          <div className="topbar-actions">
            <IconButton icon={<RefreshCw size={17} />} label="Refresh" onClick={() => void refresh()} />
            <IconButton icon={<Braces size={17} />} label="OpenAPI" onClick={() => window.open(apiHref("/api/openapi.json"), "_blank", "noopener,noreferrer")} />
            <div className="avatar">SJ</div>
          </div>
        </header>

        <nav className="mobile-section-nav" aria-label="Product sections">
          {navigationItems.map((item) => (
            <button key={item.id} className={activeSection === item.id ? "active" : ""} onClick={() => navigateTo(item.id)} aria-label={item.label} title={item.label}>
              {item.icon}
            </button>
          ))}
        </nav>

        <section className="content-grid">
          <OperatorControlRoom snapshot={snapshot} snapshotState={snapshotState} onRefresh={refresh} onNavigate={navigateTo} />
          <SourceWorkbench snapshot={snapshot} snapshotState={snapshotState} onRefresh={refresh} />

          <section className="ingest-panel panel" id="ingest">
            <div className="panel-header">
              <div>
                <h2>Ingest</h2>
                <p>Source-spanned semantic capture</p>
              </div>
              <Upload size={18} />
            </div>
            <label className="field">
              <span>Source name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field">
              <span>Paste unstructured data</span>
              <textarea value={text} onChange={(event) => setText(event.target.value)} />
            </label>
            <div className="segmented vertical">
              {([
                ["full_data", "Full data"],
                ["metadata_only", "Metadata only"],
                ["external_reference", "External reference"]
              ] as const).map(([value, label]) => (
                <button type="button" key={value} className={ingestionMode === value ? "selected" : ""} aria-pressed={ingestionMode === value} onClick={() => setIngestionMode(value)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="runtime-badges" aria-label="Active ingestion runtime">
              <span>Parser: local</span>
              <span>MCP/API-ready</span>
              <span>Policy: sensitivity + rules</span>
            </div>
            <div className="ingest-actions">
              <button className="secondary-action" onClick={onPreviewIngest} disabled={busy || text.trim().length === 0}>
                <FileSearch size={17} />
                Preview
              </button>
              <button className="primary-action" onClick={onIngest} disabled={busy || text.trim().length === 0}>
                <Upload size={17} />
                Ingest
              </button>
            </div>

            {ingestPreview ? (
              <div className="preview-card">
                <div>
                  <strong>Preview</strong>
                  <span>{ingestPreview.profile.chunkCount} chunks · {ingestPreview.profile.entityCount} entities · {ingestPreview.profile.relationCount} relations</span>
                </div>
                <p>{ingestPreview.entities.slice(0, 4).map((entity) => entity.canonicalName).join(", ") || "No entity candidates yet"}</p>
                {ingestPreview.profile.warnings.map((warning) => <small key={warning}>{warning}</small>)}
              </div>
            ) : null}

            <div className="module-strip compact">
              {snapshot?.status.modules.slice(0, 6).map((module) => (
                <div className="module-row" key={module.id}>
                  <CircleDot size={14} />
                  <span>{module.label}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="search-panel panel" id="actions">
            <div className="search-bar">
              <Search size={19} />
              <input
                type="search"
                aria-label="Search semantic evidence"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") executeSearch();
                }}
              />
              <button className="small-button" onClick={() => executeSearch()} disabled={busy}>
                <Play size={15} />
                Search
              </button>
              <button className="small-button" onClick={onDiscovery} disabled={busy}>
                <Zap size={15} />
                Profile fabric
              </button>
            </div>
            <div className="toolbar">
              <div className="segmented">
                {(["hybrid", "lexical", "vector", "graph"] as const).map((item) => (
                  <button
                    key={item}
                    className={mode === item ? "selected" : ""}
                    aria-pressed={mode === item}
                    disabled={busy}
                    onClick={() => {
                      setMode(item);
                      executeSearch(query, item);
                    }}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <span className="filter-button" aria-label="Policy-aware filtering is active">
                <ShieldCheck size={15} />
                Policy-aware
              </span>
            </div>

            {error ? <div className="error-banner" role="alert">{error}</div> : null}

            <div className={`business-action-panel action-${actionPhase}`} aria-busy={actionBusy}>
              <div className="panel-subhead">
                <h3>Business action router</h3>
                <span className={`action-state ${actionPhase}`}>
                  {(actionPhase === "planning" || actionPhase === "executing") ? <Loader2 className="spin-icon" size={13} /> : null}
                  {actionRun?.status || actionPlan?.status
                    ? (actionRun?.status ?? actionPlan!.status).replaceAll("_", " ")
                    : snapshotState === "loading"
                      ? "Loading sources"
                      : `${snapshot?.sourceConnections.filter((connection) => connection.config.kind !== "filesystem" && connection.config.writeMode !== "read_only").length ?? 0} managed writable sources`}
                </span>
              </div>
              <div className="action-feedback" aria-live="polite">
                <div>
                  <strong>{actionPhase === "idle" ? "Ready" : actionPhase === "planned" ? "Plan ready" : actionPhase === "verified" ? "Completed" : actionPhase.replaceAll("_", " ")}</strong>
                  <span>{actionNotice}</span>
                </div>
                {lastActionAt ? <small>{lastActionAt}</small> : null}
              </div>
              <div className="action-policy-controls">
                <div className="segmented" role="group" aria-label="Business action mode">
                  {(["autonomous", "approval_required", "dry_run"] as const).map((item) => (
                    <button
                      type="button"
                      key={item}
                      className={actionMode === item ? "selected" : ""}
                      aria-pressed={actionMode === item}
                      disabled={actionBusy}
                      onClick={() => {
                        setActionMode(item);
                        invalidateActionPlan();
                      }}
                    >
                      {item.replaceAll("_", " ")}
                    </button>
                  ))}
                </div>
                <label>
                  <span>Autonomy ceiling</span>
                  <select
                    value={actionRisk}
                    disabled={actionBusy}
                    onChange={(event) => {
                      setActionRisk(event.target.value as typeof actionRisk);
                      invalidateActionPlan();
                    }}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High (server-capped)</option>
                  </select>
                </label>
              </div>
              <div className="action-presets" aria-label="Business action presets">
                <span>Presets</span>
                <button type="button" disabled={actionBusy} className={businessIntent === "Set order ORD-1001 status to dispatched" ? "selected" : ""} onClick={() => applyBusinessPreset("Set order ORD-1001 status to dispatched")}>
                  <Database size={14} />
                  Dispatch order
                </button>
                <button
                  type="button"
                  disabled={actionBusy}
                  className={businessIntent === "Use dispatch eligible orders as the denominator for Late Dispatch Rate and publish version 2" ? "selected" : ""}
                  onClick={() => applyBusinessPreset("Use dispatch eligible orders as the denominator for Late Dispatch Rate and publish version 2")}
                >
                  <GitBranch size={14} />
                  Publish Git contract
                </button>
              </div>
              <div className="business-intent-row">
                <input
                  aria-label="Business action request"
                  value={businessIntent}
                  disabled={actionBusy}
                  onChange={(event) => {
                    setBusinessIntent(event.target.value);
                    invalidateActionPlan();
                  }}
                />
                <button className="secondary-action" onClick={onPlanBusinessAction} disabled={busy || actionBusy || !businessIntent.trim()}>
                  {actionPhase === "planning" ? <Loader2 className="spin-icon" size={15} /> : <Route size={15} />}
                  {actionPhase === "planning" ? "Planning" : actionPlan ? "Replan" : "Plan"}
                </button>
                <button
                  className="primary-action compact-action"
                  onClick={onExecuteBusinessAction}
                  disabled={
                    busy ||
                    actionBusy ||
                    !actionPlan ||
                    actionPlan.intent !== businessIntent.trim() ||
                    actionPlan.mode !== actionMode ||
                    actionPlan.maxAutonomousRisk !== actionRisk ||
                    (actionPlan.status !== "planned" && actionPlan.status !== "approval_required") ||
                    (actionPlan.status === "approval_required" && !actionApproval)
                  }
                >
                  {actionPhase === "executing" ? <Loader2 className="spin-icon" size={15} /> : <Send size={15} />}
                  {actionPhase === "executing" ? "Executing" : actionMode === "dry_run" ? "Record dry run" : "Execute plan"}
                </button>
              </div>
              {actionPlan ? (
                <section className="action-plan-proof" aria-label="Current plan identity and evidence binding">
                  <div>
                    <span>Plan identity</span>
                    <strong>{actionPlan.id}</strong>
                    <small>{actionPlan.principal.actor} / {actionPlan.principal.clearance} / {actionPlan.principal.policyVersion}</small>
                  </div>
                  <div className="fingerprint-control">
                    <span>Full fingerprint</span>
                    <code>{actionPlan.fingerprint}</code>
                    <button type="button" className="compact-icon-button" onClick={() => void copyPlanFingerprint()} aria-label="Copy full plan fingerprint" title="Copy full plan fingerprint">
                      {fingerprintCopied ? <CheckCircle2 size={15} /> : <Copy size={15} />}
                    </button>
                  </div>
                  <div>
                    <span>Proof binding</span>
                    <strong>{[...new Set(actionPlan.targets.flatMap((target) => target.evidenceChunkIds))].length} evidence chunks / {actionPlan.targets.length} targets</strong>
                    <small>{actionRun ? (actionRun.plan.id === actionPlan.id && actionRun.plan.fingerprint === actionPlan.fingerprint ? `Run ${actionRun.id}: executed fingerprint matches reviewed fingerprint.` : "Run identity does not match the reviewed plan.") : "Execution has not started."}</small>
                  </div>
                </section>
              ) : null}
              {actionPlan?.status === "approval_required" ? (
                <section className="approval-review" aria-label="Plan approval review">
                  <div className="approval-preconditions">
                    {actionPlan.targets
                      .filter((target) => target.autonomy === "approval_required")
                      .map((target) => (
                        <div key={target.stepId}>
                          <strong>{target.systemName}</strong>
                          <span>{target.diff.summary}</span>
                          <small>{target.evidenceChunkIds.length} evidence chunks / {target.risk} risk</small>
                        </div>
                      ))}
                  </div>
                  <label className="approval-rationale">
                    <span>Approval rationale</span>
                    <textarea
                      value={approvalRationale}
                      disabled={actionBusy || Boolean(actionApproval)}
                      onChange={(event) => setApprovalRationale(event.target.value)}
                      placeholder="Record why this exact source diff is approved"
                    />
                  </label>
                  <label className="approval-attestation">
                    <input
                      type="checkbox"
                      checked={approvalAttested}
                      disabled={actionBusy || Boolean(actionApproval)}
                      onChange={(event) => setApprovalAttested(event.target.checked)}
                    />
                    <span>I reviewed the target systems, diffs, evidence, risk, and plan fingerprint.</span>
                  </label>
                  <button
                    className="secondary-action approval-command"
                    onClick={onApproveBusinessAction}
                    disabled={busy || actionBusy || Boolean(actionApproval) || !approvalAttested || !approvalRationale.trim()}
                  >
                    <ShieldCheck size={15} />
                    {actionApproval ? "Approved" : actionBusy ? "Approving" : "Approve exact plan"}
                  </button>
                </section>
              ) : null}
              <div className="action-stepper">
                {actionSteps.map((step, index) => (
                  <div className={`action-step ${step.done ? "done" : ""} ${step.active ? "active" : ""}`} key={step.label}>
                    <span>{step.done ? <CheckCircle2 size={14} /> : index + 1}</span>
                    <div>
                      <strong>{step.label}</strong>
                      <small>{step.detail}</small>
                    </div>
                  </div>
                ))}
              </div>
              <div className="action-summary-grid">
                <div>
                  <span>Intent resolved</span>
                  <strong>{actionPlan?.title ?? "Waiting for business intent"}</strong>
                  <small>{actionPlan?.summary ?? "The router will choose target systems, diffs, risk, autonomy, and reflection checks."}</small>
                </div>
                <div>
                  <span>Reflection</span>
                  <strong>{actionRun ? `${actionRun.reflections.filter((item) => item.status === "verified").length}/${actionRun.reflections.length} verified` : "not executed"}</strong>
                  <small>{actionRun?.semanticUpdates[0]?.chunkIds.length ?? 0} semantic chunks refreshed</small>
                </div>
              </div>
              {actionPlan ? (
                <div className="action-target-list">
                  {actionPlan.targets.map((target) => {
                    const connection = snapshot?.sourceConnections.find((candidate) => candidate.id === target.systemId);
                    return (
                      <ActionTargetSurface
                        key={target.stepId}
                        target={target}
                        connection={connection}
                        connectorIdentityUnavailable={Boolean(snapshot?.surfaceErrors.sourceConnections)}
                        write={writeForStep(target.stepId)}
                        reflection={reflectionForStep(target.stepId)}
                      />
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="result-table">
              <div className="table-row table-head">
                <span>Type</span>
                <span>Evidence / snippet</span>
                <span>Source</span>
                <span>Score</span>
              </div>
              {searchResults.map((result) => (
                <div className="table-row" key={result.chunkId}>
                  <span className="type-chip">Chunk</span>
                  <span>
                    <strong>{result.summary}</strong>
                    <small>{result.text.slice(0, 150)}{result.text.length > 150 ? "..." : ""}</small>
                  </span>
                  <span>{result.sourceName}</span>
                  <span>{result.hybridScore.toFixed(3)}</span>
                </div>
              ))}
            </div>

            <div className="entities-panel">
              <div className="panel-subhead">
                <h3>Discovered entities</h3>
                <span>{snapshot?.status.entities ?? 0} total</span>
              </div>
              <div className="entity-grid">
                {selectedEntities.map((entity) => (
                  <div className="entity-row" key={entity.id}>
                    <span>{entity.label}</span>
                    <small>{entity.type}</small>
                    <strong>{entity.degree}</strong>
                  </div>
                ))}
              </div>
            </div>

            <div className="curation-panel">
              <div className="panel-subhead">
                <h3>Semantic control</h3>
                <span>{curatedRelation ? curatedRelation.relation.type : "manual curation"}</span>
              </div>
              <div className="curation-grid">
                <label className="field compact-field">
                  <span>Source</span>
                  <input value={curationSource} onChange={(event) => setCurationSource(event.target.value)} />
                </label>
                <label className="field compact-field">
                  <span>Relation</span>
                  <input value={curationRelation} onChange={(event) => setCurationRelation(event.target.value.toUpperCase().replace(/\s+/g, "_"))} />
                </label>
                <label className="field compact-field">
                  <span>Target</span>
                  <input value={curationTarget} onChange={(event) => setCurationTarget(event.target.value)} />
                </label>
              </div>
              <label className="field compact-field">
                <span>Rationale</span>
                <input value={curationRationale} onChange={(event) => setCurationRationale(event.target.value)} />
              </label>
              <button className="curation-button" onClick={onCurateRelation} disabled={busy || !curationSource.trim() || !curationTarget.trim() || !curationRationale.trim()}>
                <GitBranch size={15} />
                Curate relation
              </button>
              {curatedRelation ? (
                <p className="curation-result">{curatedRelation.sourceEntity.canonicalName} {curatedRelation.relation.type} {curatedRelation.targetEntity.canonicalName}</p>
              ) : null}
            </div>
          </section>

          <aside className="right-rail">
            <section className="panel graph-panel" id="graph">
              <div className="panel-header">
                <div>
                  <h2>Knowledge graph</h2>
                  <p>{snapshotState === "loading" ? "Loading graph" : `${snapshot?.graph.nodes.length ?? 0} nodes · ${snapshot?.graph.edges.length ?? 0} edges`}</p>
                </div>
                <span className={`live-pill ${snapshotState}`}>{snapshotState === "ready" ? "Live" : snapshotState}</span>
              </div>
              <GraphCanvas graph={snapshot?.graph ?? { nodes: [], edges: [] }} />
            </section>

            <section className="panel agent-panel" id="agents">
              <div className="panel-header">
                <div>
                  <h2>Agent autonomy</h2>
                  <p>Capability manifest</p>
                </div>
                <LockKeyhole size={18} />
              </div>
              <p className="manifest-copy">{snapshot?.manifest?.autonomyBoundary ?? (snapshotState === "loading" ? "Loading agent capability manifest." : "Agent manifest unavailable.")}</p>
              <div className="mcp-surface">
                <div>
                  <span>MCP server</span>
                  <strong>{snapshot?.mcp?.summary ?? (snapshotState === "loading" ? "loading" : "unavailable")}</strong>
                </div>
                <small>{snapshotState === "loading" ? "Loading MCP capability metadata" : `${snapshot?.mcp?.server.transport ?? "not connected"} - ${snapshot?.mcp?.server.command ?? "configure MCP runtime"}`}</small>
              </div>
              <div className="source-surface">
                <div>
                  <span>Source writeback</span>
                  <strong>{snapshotState === "loading" ? "loading" : `${snapshot?.sourceRecords.length ?? 0} reflected records`}</strong>
                </div>
                <small>{snapshotState === "loading" ? "Loading source-system capabilities" : snapshot?.sourceSystems.map((system) => system.name).slice(0, 3).join(" · ") || "No source systems configured"}</small>
              </div>
              <div className="capability-list">
                {snapshot?.manifest?.capabilities.slice(0, 6).map((capability) => (
                  <div key={capability.name} className="capability-row">
                    <CheckCircle2 size={15} />
                    <span>{capability.name}</span>
                    <small>{capability.risk}</small>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel timeline-panel" id="discovery">
              <div className="panel-header">
                <div>
                  <h2>Discovery timeline</h2>
                  <p>{latestRun?.status ?? "waiting"}</p>
                </div>
                <Workflow size={18} />
              </div>
              <div className="timeline">
                {latestRun?.events.slice().reverse().map((event) => (
                  <div className={`timeline-item ${event.severity}`} key={event.id}>
                    <span />
                    <div>
                      <strong>{event.title}</strong>
                      <p>{event.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </section>

        <footer className="bottom-dock">
          {Object.entries(groupedModules).slice(0, 8).map(([kind, modules]) => (
            <div className="dock-item" key={kind}>
              {kind.includes("graph") ? <Network size={18} /> : kind.includes("policy") ? <ShieldCheck size={18} /> : kind.includes("metric") ? <LineChart size={18} /> : <Database size={18} />}
              <span>{moduleLabels[kind] ?? kind}</span>
              <strong>{modules.length} active</strong>
            </div>
          ))}
        </footer>
      </main>
    </div>
  );
}

declare global {
  interface Window {
    __semanticJunkyardRoot?: Root;
  }
}

const rootElement = document.getElementById("root")!;
const root = window.__semanticJunkyardRoot ?? createRoot(rootElement);
window.__semanticJunkyardRoot = root;
root.render(
  <StrictMode>
    <App />
  </StrictMode>
);
