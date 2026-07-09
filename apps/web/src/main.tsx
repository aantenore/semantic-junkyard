import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Bell,
  Boxes,
  Braces,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Database,
  FileSearch,
  Filter,
  GitBranch,
  GitPullRequest,
  KeyRound,
  Layers3,
  LineChart,
  Loader2,
  LockKeyhole,
  Network,
  Play,
  RefreshCw,
  Route,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Upload,
  Workflow,
  Zap
} from "lucide-react";
import type { BusinessActionPlan, BusinessActionRun, SearchResult } from "@semantic-junkyard/shared";
import { GraphCanvas } from "./components/GraphCanvas";
import { IconButton } from "./components/IconButton";
import { curateRelation, executeBusinessAction, ingestText, loadSnapshot, planBusinessAction, previewIngest, runDiscovery, runLocalAgentPoc, semanticSearch } from "./api/client";
import type { AppSnapshot, CuratedRelationReport, IngestPreviewReport, PocAgentReport } from "./types/app";
import { starterText } from "./data/sample";
import "./styles.css";

function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [query, setQuery] = useState("Which semantic contract governs failed payment rate?");
  const [mode, setMode] = useState<"hybrid" | "lexical" | "vector" | "graph">("hybrid");
  const [text, setText] = useState(starterText);
  const [name, setName] = useState("agent-discovery-note.md");
  const [ingestionMode, setIngestionMode] = useState<"full_data" | "metadata_only" | "external_reference">("full_data");
  const [ingestPreview, setIngestPreview] = useState<IngestPreviewReport | null>(null);
  const [curationSource, setCurationSource] = useState("Billing Pipeline");
  const [curationRelation, setCurationRelation] = useState("DEPENDS_ON");
  const [curationTarget, setCurationTarget] = useState("Revenue Mart");
  const [curationRationale, setCurationRationale] = useState("Owner-confirmed semantic dependency.");
  const [curatedRelation, setCuratedRelation] = useState<CuratedRelationReport | null>(null);
  const [businessIntent, setBusinessIntent] = useState("Align Failed Payment Rate definition across Finance and Billing, then make it reflected in source systems.");
  const [actionPlan, setActionPlan] = useState<BusinessActionPlan | null>(null);
  const [actionRun, setActionRun] = useState<BusinessActionRun | null>(null);
  const [actionPhase, setActionPhase] = useState<"idle" | "planning" | "planned" | "executing" | "verified" | "approval_required" | "failed">("idle");
  const [actionNotice, setActionNotice] = useState("Write a business request, then plan it before execution.");
  const [lastActionAt, setLastActionAt] = useState<string | null>(null);
  const [pocReport, setPocReport] = useState<PocAgentReport | null>(null);
  const [traceProvider, setTraceProvider] = useState<"local-huggingface" | "deterministic">("local-huggingface");
  const [traceBusy, setTraceBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const next = await loadSnapshot();
    setSnapshot(next);
  }

  async function executeSearch(nextQuery = query, nextMode = mode) {
    setBusy(true);
    setError(null);
    try {
      const response = await semanticSearch(nextQuery, nextMode);
      setSearchResults(response.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refresh()
      .then(() => Promise.all([executeSearch(), runAgentTrace("local-huggingface")]))
      .catch((err) => setError(err instanceof Error ? err.message : "API unavailable"));
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

  async function onIngest() {
    setBusy(true);
    setError(null);
    try {
      await ingestText(ingestInput());
      setIngestPreview(null);
      await refresh();
      await executeSearch(query, mode);
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
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Curation failed");
    } finally {
      setBusy(false);
    }
  }

  async function onPlanBusinessAction() {
    setBusy(true);
    setError(null);
    setActionRun(null);
    setActionPhase("planning");
    setActionNotice("Planning source writes from the business intent...");
    try {
      const plan = await planBusinessAction({ intent: businessIntent, mode: "autonomous", maxAutonomousRisk: "medium" });
      setActionPlan(plan);
      setActionPhase(plan.status === "approval_required" ? "approval_required" : "planned");
      setActionNotice(`${plan.targets.length} source targets planned. Review the diffs, then execute.`);
      setLastActionAt(new Date().toLocaleTimeString());
    } catch (err) {
      setActionPhase("failed");
      setActionNotice("Planning failed. Check the error banner.");
      setError(err instanceof Error ? err.message : "Business action planning failed");
    } finally {
      setBusy(false);
    }
  }

  async function onExecuteBusinessAction() {
    setBusy(true);
    setError(null);
    setActionPhase("executing");
    setActionNotice("Executing through writeback gateway, then rereading source systems...");
    try {
      const run = await executeBusinessAction({ intent: businessIntent, mode: "autonomous", maxAutonomousRisk: "medium" });
      setActionRun(run);
      setActionPlan(run.plan);
      setActionPhase(run.status === "verified" ? "verified" : run.status === "approval_required" ? "approval_required" : "failed");
      setActionNotice(
        run.status === "verified"
          ? `${run.writes.length} source writes executed and ${run.reflections.filter((item) => item.status === "verified").length}/${run.reflections.length} reflections verified. Search results were refreshed from source evidence.`
          : `Action finished with status ${run.status}. Review target autonomy and approval policy.`
      );
      setLastActionAt(new Date().toLocaleTimeString());
      await refresh();
      await executeSearch(businessIntent, "hybrid");
    } catch (err) {
      setActionPhase("failed");
      setActionNotice("Execution failed. Check the error banner.");
      setError(err instanceof Error ? err.message : "Business action execution failed");
    } finally {
      setBusy(false);
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

  async function runAgentTrace(provider = traceProvider) {
    setTraceBusy(true);
    setTraceProvider(provider);
    setError(null);
    try {
      const report = await runLocalAgentPoc(provider);
      setPocReport(report);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent trace failed");
    } finally {
      setTraceBusy(false);
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
        <nav className="nav-list">
          {[
            ["Dashboard", <Activity size={17} />],
            ["Ingest", <Upload size={17} />],
            ["Discovery", <FileSearch size={17} />],
            ["Actions", <Route size={17} />],
            ["Graph", <Network size={17} />],
            ["Agents", <Zap size={17} />],
            ["Catalog", <Layers3 size={17} />],
            ["Policies", <ShieldCheck size={17} />],
            ["Lineage", <GitBranch size={17} />]
          ].map(([label, icon], index) => (
            <button className={`nav-item ${index === 0 ? "active" : ""}`} key={String(label)}>
              {icon}
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="system-nav">
          <span>SYSTEM</span>
          <button className="nav-item">
            <Boxes size={17} />
            <span>Modules</span>
          </button>
          <button className="nav-item">
            <KeyRound size={17} />
            <span>Access</span>
          </button>
          <button className="nav-item">
            <Settings size={17} />
            <span>Settings</span>
          </button>
        </div>
        <div className="workspace-card">
          <span>Workspace</span>
          <strong>Local Junkyard</strong>
          <small>Role: owner</small>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="topbar-section">
            <span className="meta-label">Workspace</span>
            <strong className="mobile-product-name">Semantic Junkyard</strong>
            <strong>Agentic Semantic Layer</strong>
            <span className="status-pill">Active</span>
          </div>
          <div className="topbar-section wide">
            <span className="meta-label">Provider</span>
            <strong>{snapshot?.provider.kind ?? "deterministic"} · {snapshot?.provider.model ?? "loading"}</strong>
            <span className="dot" />
          </div>
          <div className="topbar-actions">
            <IconButton icon={<RefreshCw size={17} />} label="Refresh" onClick={() => refresh()} />
            <IconButton icon={<Bell size={17} />} label="Notifications" />
            <IconButton icon={<Braces size={17} />} label="OpenAPI" onClick={() => window.open("/api/openapi.json", "_blank")} />
            <div className="avatar">SJ</div>
          </div>
        </header>

        <section className="content-grid">
          <section className="ingest-panel panel">
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
                <button key={value} className={ingestionMode === value ? "selected" : ""} onClick={() => setIngestionMode(value)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="segmented vertical subtle">
              <button className="selected">Parser: local</button>
              <button>MCP/API-ready</button>
              <button>Policy: ABAC</button>
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

          <section className="search-panel panel">
            <div className="search-bar">
              <Search size={19} />
              <input
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
                Run discovery
              </button>
            </div>
            <div className="toolbar">
              <div className="segmented">
                {(["hybrid", "lexical", "vector", "graph"] as const).map((item) => (
                  <button
                    key={item}
                    className={mode === item ? "selected" : ""}
                    onClick={() => {
                      setMode(item);
                      executeSearch(query, item);
                    }}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <button className="filter-button">
                <Filter size={15} />
                Policy-aware
              </button>
            </div>

            {error ? <div className="error-banner">{error}</div> : null}

            <div className={`business-action-panel action-${actionPhase}`} aria-busy={actionPhase === "planning" || actionPhase === "executing"}>
              <div className="panel-subhead">
                <h3>Business action router</h3>
                <span className={`action-state ${actionPhase}`}>
                  {(actionPhase === "planning" || actionPhase === "executing") ? <Loader2 className="spin-icon" size={13} /> : null}
                  {actionRun?.status ?? actionPlan?.status ?? `${snapshot?.sourceSystems.length ?? 0} source systems`}
                </span>
              </div>
              <div className="action-feedback">
                <div>
                  <strong>{actionPhase === "idle" ? "Ready" : actionPhase === "planned" ? "Plan ready" : actionPhase === "verified" ? "Completed" : actionPhase.replace("_", " ")}</strong>
                  <span>{actionNotice}</span>
                </div>
                {lastActionAt ? <small>{lastActionAt}</small> : null}
              </div>
              <div className="business-intent-row">
                <input value={businessIntent} onChange={(event) => setBusinessIntent(event.target.value)} />
                <button className="secondary-action" onClick={onPlanBusinessAction} disabled={busy || !businessIntent.trim()}>
                  {actionPhase === "planning" ? <Loader2 className="spin-icon" size={15} /> : <Route size={15} />}
                  {actionPhase === "planning" ? "Planning" : actionPlan ? "Replan" : "Plan"}
                </button>
                <button className="primary-action compact-action" onClick={onExecuteBusinessAction} disabled={busy || !businessIntent.trim()}>
                  {actionPhase === "executing" ? <Loader2 className="spin-icon" size={15} /> : <Send size={15} />}
                  {actionPhase === "executing" ? "Executing" : actionRun?.status === "verified" ? "Run again" : "Execute"}
                </button>
              </div>
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
                  {actionPlan.targets.map((target) => (
                    <div className="action-target" key={target.stepId}>
                      <div>
                        <strong>{target.systemName}</strong>
                        <small>{target.capability} · {target.risk} · {target.autonomy}</small>
                      </div>
                      <p>{target.diff.summary}</p>
                      <span className={`target-status ${reflectionForStep(target.stepId)?.status ?? writeForStep(target.stepId)?.status ?? target.status}`}>
                        {reflectionForStep(target.stepId)?.status ?? writeForStep(target.stepId)?.status ?? target.status}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {actionRun ? (
                <div className="reflection-list">
                  {actionRun.writes.slice(0, 4).map((write) => (
                    <div className="reflection-row" key={write.id}>
                      <GitPullRequest size={15} />
                      <span>{write.systemName}</span>
                      <small>{actionRun.reflections.find((reflection) => reflection.writeId === write.id)?.status ?? write.status} · {write.objectType}</small>
                    </div>
                  ))}
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
              <button className="curation-button" onClick={onCurateRelation} disabled={busy || !curationSource.trim() || !curationTarget.trim()}>
                <GitBranch size={15} />
                Curate relation
              </button>
              {curatedRelation ? (
                <p className="curation-result">{curatedRelation.sourceEntity.canonicalName} {curatedRelation.relation.type} {curatedRelation.targetEntity.canonicalName}</p>
              ) : null}
            </div>
          </section>

          <aside className="right-rail">
            <section className="panel graph-panel">
              <div className="panel-header">
                <div>
                  <h2>Knowledge graph</h2>
                  <p>{snapshot?.graph.nodes.length ?? 0} nodes · {snapshot?.graph.edges.length ?? 0} edges</p>
                </div>
                <span className="live-pill">Live</span>
              </div>
              <GraphCanvas graph={snapshot?.graph ?? { nodes: [], edges: [] }} />
            </section>

            <section className="panel agent-panel">
              <div className="panel-header">
                <div>
                  <h2>Agent autonomy</h2>
                  <p>Capability manifest</p>
                </div>
                <LockKeyhole size={18} />
              </div>
              <p className="manifest-copy">{snapshot?.manifest.autonomyBoundary}</p>
              <div className="mcp-surface">
                <div>
                  <span>MCP server</span>
                  <strong>{snapshot?.mcp.summary ?? "loading"}</strong>
                </div>
                <small>{snapshot?.mcp.server.transport ?? "stdio"} - {snapshot?.mcp.server.command ?? "node apps/mcp/dist/server.js"}</small>
              </div>
              <div className="source-surface">
                <div>
                  <span>Source writeback</span>
                  <strong>{snapshot?.sourceRecords.length ?? 0} reflected records</strong>
                </div>
                <small>{snapshot?.sourceSystems.map((system) => system.name).slice(0, 3).join(" · ") ?? "loading"}</small>
              </div>
              <div className="capability-list">
                {snapshot?.manifest.capabilities.slice(0, 6).map((capability) => (
                  <div key={capability.name} className="capability-row">
                    <CheckCircle2 size={15} />
                    <span>{capability.name}</span>
                    <small>{capability.risk}</small>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel trace-panel">
              <div className="panel-header">
                <div>
                  <h2>Agent trace</h2>
                  <p>{pocReport ? `${pocReport.provider} - ${pocReport.model}` : "ready"}</p>
                </div>
                <div className="trace-actions">
                  <div className="trace-provider" role="group" aria-label="Agent trace provider">
                    <button className={traceProvider === "local-huggingface" ? "selected" : ""} onClick={() => setTraceProvider("local-huggingface")}>
                      Local HF
                    </button>
                    <button className={traceProvider === "deterministic" ? "selected" : ""} onClick={() => setTraceProvider("deterministic")}>
                      Rules
                    </button>
                  </div>
                  <button
                    className="trace-run-button"
                    onClick={() => runAgentTrace()}
                    disabled={busy || traceBusy}
                    aria-label={traceBusy ? "Agent trace running" : "Run trace"}
                    title={traceBusy ? "Agent trace running" : "Run trace"}
                  >
                    <Play size={14} />
                  </button>
                </div>
              </div>
              <div className="trace-body">
                <p className="trace-summary">{pocReport?.modelReasoningSummary ?? "Run the PoC to inspect tool use, discoveries, observations, and citations."}</p>
                {pocReport?.businessAction ? (
                  <div className="trace-business-action">
                    <strong>{pocReport.businessAction.status}</strong>
                    <span>{pocReport.businessAction.writes} writes · {pocReport.businessAction.verifiedReflections} reflections · {pocReport.businessAction.semanticChunksRefreshed} chunks</span>
                  </div>
                ) : null}
                <div className="trace-steps">
                  {pocReport?.steps.map((step) => (
                    <div className="trace-step" key={`${step.step}-${step.tool}`}>
                      <span>{step.step}</span>
                      <div>
                        <strong>{step.tool}</strong>
                        <p>{step.rationale}</p>
                        <small>{step.observation}</small>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="trace-citations">
                  {pocReport?.citations.slice(0, 3).map((citation) => (
                    <div className="trace-citation" key={citation.chunkId}>
                      <strong>{citation.sourceName}</strong>
                      <p>{citation.excerpt}</p>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="panel timeline-panel">
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
              <ChevronDown size={14} />
            </div>
          ))}
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
