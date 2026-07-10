import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  Bot,
  Braces,
  CheckCircle2,
  Database,
  FileSearch,
  GitPullRequest,
  Loader2,
  Network,
  Play,
  RefreshCw,
  Route,
  Search,
  Send,
  ShieldCheck,
  Workflow,
  Zap
} from "lucide-react";
import type { BusinessActionPlan, BusinessActionRun, ContextEnvelope, GraphSnapshot, PocAgentReport, PocSnapshot, SearchResult, ToolProvider } from "./types/app";
import {
  apiHref,
  entityLookup,
  executeBusinessAction,
  expandContext,
  explainPermissions,
  graphNeighbors,
  loadPocSnapshot,
  planBusinessAction,
  runDiscovery,
  runLocalAgentPoc,
  semanticSearch
} from "./api/client";
import "./styles.css";

const PRODUCT_APP_URL = import.meta.env.VITE_PRODUCT_URL || (import.meta.env.DEV ? "http://localhost:5173" : "/");
const DEFAULT_INTENT = "Align Failed Payment Rate definition across Finance and Billing, then make it reflected in source systems.";

type MessageKind = "user" | "assistant" | "tool" | "audit" | "write" | "error";
type ToolStatus = "running" | "completed" | "failed";

interface ConversationMessage {
  id: string;
  kind: MessageKind;
  title: string;
  body: string;
  at: string;
}

interface ToolEvent {
  id: string;
  name: string;
  endpoint: string;
  status: ToolStatus;
  summary: string;
  startedAt: string;
  completedAt?: string;
}

function App() {
  const [snapshot, setSnapshot] = useState<PocSnapshot | null>(null);
  const [input, setInput] = useState(DEFAULT_INTENT);
  const [activeIntent, setActiveIntent] = useState(DEFAULT_INTENT);
  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      id: "welcome",
      kind: "assistant",
      title: "Ask Semantic Junkyard",
      body: "Ask for a business outcome. I will call the product APIs, show each tool call, explain what happened, write through the gateway when policy allows it, and reread the semantic layer before claiming completion.",
      at: new Date().toLocaleTimeString()
    }
  ]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [contextPack, setContextPack] = useState<ContextEnvelope | null>(null);
  const [graph, setGraph] = useState<GraphSnapshot | null>(null);
  const [plan, setPlan] = useState<BusinessActionPlan | null>(null);
  const [run, setRun] = useState<BusinessActionRun | null>(null);
  const [pocReport, setPocReport] = useState<PocAgentReport | null>(null);
  const [discoveryTitle, setDiscoveryTitle] = useState("waiting");
  const [provider, setProvider] = useState<ToolProvider>("local-huggingface");
  const [conversationMode, setConversationMode] = useState<"read_only" | "plan_only" | "autonomous">("autonomous");
  const [conversationBusy, setConversationBusy] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotState, setSnapshotState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const messageThreadRef = useRef<HTMLDivElement | null>(null);

  const displayedRun = run;
  const displayedPlan = plan ?? displayedRun?.plan ?? null;
  const reflectedWrites = displayedRun?.reflections.filter((reflection) => reflection.status === "verified").length ?? 0;
  const semanticChunks = displayedRun?.semanticUpdates.reduce((total, update) => total + update.chunkIds.length, 0) ?? 0;
  const latestToolStatus = toolEvents.some((event) => event.status === "running") ? "running" : "completed";
  const topEvidence = searchResults[0];
  const evidenceItems = useMemo(() => {
    if (contextPack) {
      return contextPack.evidence.slice(0, 4).map((item) => ({
        id: item.chunkId,
        sourceName: item.sourceName,
        text: item.text
      }));
    }
    return searchResults.slice(0, 4).map((item) => ({
      id: item.chunkId,
      sourceName: item.sourceName,
      text: item.summary
    }));
  }, [contextPack, searchResults]);

  const statusTiles = useMemo(
    () => [
      { label: "Source systems", value: snapshot?.sourceSystems.length ?? 0 },
      { label: "Reflected records", value: snapshot?.sourceRecords.length ?? 0 },
      { label: "Action runs", value: snapshot?.actionRuns.length ?? 0 },
      { label: "Semantic chunks", value: snapshot?.status.chunks ?? 0 }
    ],
    [snapshot]
  );

  async function refreshSnapshot() {
    setSnapshotBusy(true);
    setSnapshotState("loading");
    setError(null);
    try {
      setSnapshot(await loadPocSnapshot());
      setSnapshotState("ready");
    } catch (err) {
      setSnapshotState("error");
      setError(err instanceof Error ? err.message : "Snapshot refresh failed");
    } finally {
      setSnapshotBusy(false);
    }
  }

  useEffect(() => {
    refreshSnapshot();
  }, []);

  useEffect(() => {
    messageThreadRef.current?.scrollTo({
      top: messageThreadRef.current.scrollHeight,
      behavior: "auto"
    });
  }, [messages.length]);

  function pushMessage(message: Omit<ConversationMessage, "id" | "at">) {
    setMessages((current) => [
      ...current,
      {
        ...message,
        id: uid("msg"),
        at: new Date().toLocaleTimeString()
      }
    ]);
  }

  async function auditedTool<T>(input: {
    name: string;
    endpoint: string;
    summary: string;
    run: () => Promise<T>;
    describe: (result: T) => string;
  }): Promise<T> {
    const id = uid("tool");
    const startedAt = new Date().toLocaleTimeString();
    setToolEvents((current) => [
      {
        id,
        name: input.name,
        endpoint: input.endpoint,
        status: "running",
        summary: input.summary,
        startedAt
      },
      ...current
    ]);
    pushMessage({
      kind: "tool",
      title: input.name,
      body: `${input.summary} Endpoint: ${input.endpoint}.`
    });

    try {
      const result = await input.run();
      const completedAt = new Date().toLocaleTimeString();
      const summary = input.describe(result);
      setToolEvents((current) => current.map((event) => (event.id === id ? { ...event, status: "completed", summary, completedAt } : event)));
      pushMessage({
        kind: "audit",
        title: `${input.name} completed`,
        body: summary
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : `${input.name} failed`;
      setToolEvents((current) => current.map((event) => (event.id === id ? { ...event, status: "failed", summary: message, completedAt: new Date().toLocaleTimeString() } : event)));
      pushMessage({
        kind: "error",
        title: `${input.name} failed`,
        body: message
      });
      throw err;
    }
  }

  async function runConversation() {
    const intent = input.trim();
    if (!intent || conversationBusy || agentBusy) return;

    setConversationBusy(true);
    setError(null);
    setActiveIntent(intent);
    setPlan(null);
    setRun(null);
    setGraph(null);
    setContextPack(null);
    setSearchResults([]);
    pushMessage({ kind: "user", title: "Business request", body: intent });
    pushMessage({
      kind: "assistant",
      title: "I am using the product behind the scenes",
      body:
        conversationMode === "read_only"
          ? "I will check permissions, run discovery, and assemble evidence. This mode will not plan or write to source systems."
          : conversationMode === "plan_only"
            ? "I will check permissions, assemble evidence, and return an exact source-system plan for review without executing it."
            : "I will first check autonomy and evidence, then plan source-system writes, execute only if policy allows it, and finally reread the reflected semantic state."
    });

    try {
      const permissions = await auditedTool({
        name: "explain_permissions",
        endpoint: "POST /api/tools/explain_permissions",
        summary: "Checking what an external agent may do before it touches data or source systems.",
        run: () => explainPermissions(intent),
        describe: (result) => `${result.decision}. Next safe step: ${result.safeNextSteps[0] ?? "semantic search"}.`
      });
      pushMessage({
        kind: "assistant",
        title: "Autonomy boundary",
        body: `I can continue because the manifest allows read access, planning, and configured low/medium-risk writeback. Stop conditions remain active: ${permissions.manifest.stopConditions.slice(0, 2).join("; ")}.`
      });

      const discovery = await auditedTool({
        name: "run_discovery",
        endpoint: "POST /api/discovery/run",
        summary: "Starting product-side discovery so the request is not handled as a blind command.",
        run: () => runDiscovery(`PoC conversation discovery: ${intent}`),
        describe: (result) => `${result.events.length} discovery events recorded; run status ${result.status}.`
      });
      setDiscoveryTitle(discovery.events.at(-1)?.title ?? discovery.status);

      const search = await auditedTool({
        name: "semantic_search",
        endpoint: "POST /api/tools/semantic_search",
        summary: "Searching lexical, vector, and graph signals for evidence behind the business request.",
        run: () => semanticSearch(intent, "hybrid", 8),
        describe: (result) => `${result.results.length} evidence candidates returned. Top source: ${result.results[0]?.sourceName ?? "none"}.`
      });
      setSearchResults(search.results);

      const groundingEntityId = search.results.flatMap((result) => result.entityIds)[0];
      let primaryEntity: { id: string; canonicalName: string; degree: number } | undefined;
      if (groundingEntityId) {
        const entityResult = await auditedTool({
          name: "entity_lookup",
          endpoint: "POST /api/tools/entity_lookup",
          summary: `Grounding the request with entity ID '${groundingEntityId}' returned by semantic search.`,
          run: () => entityLookup({ entityId: groundingEntityId, topK: 1 }),
          describe: (result) => `${result.entities.length} entity candidate resolved. ${result.entities[0] ? `${result.entities[0].canonicalName} has graph degree ${result.entities[0].degree}.` : "No entity was resolved."}`
        });
        primaryEntity = entityResult.entities[0];
      } else {
        pushMessage({
          kind: "audit",
          title: "Graph grounding skipped",
          body: "Semantic search returned no canonical entity IDs for this domain. The workflow will not substitute a finance-demo entity."
        });
      }

      if (primaryEntity) {
        const neighbors = await auditedTool({
          name: "graph_neighbors",
          endpoint: "POST /api/tools/graph_neighbors",
          summary: `Reading bounded graph context around ${primaryEntity.canonicalName}.`,
          run: () => graphNeighbors(primaryEntity.id, 1),
          describe: (result) => `${result.nodes.length} nodes and ${result.edges.length} edges returned inside the approved graph boundary.`
        });
        setGraph(neighbors);
      }

      const context = await auditedTool({
        name: "expand_context",
        endpoint: "POST /api/tools/expand_context",
        summary: "Building an evidence pack before any answer or writeback.",
        run: () => expandContext({ query: intent, entityIds: primaryEntity ? [primaryEntity.id] : [] }),
        describe: (result) => `${result.evidence.length} evidence spans assembled. Guidance: ${result.guidance}`
      });
      setContextPack(context);

      if (conversationMode === "read_only") {
        pushMessage({
          kind: "assistant",
          title: "Read-only discovery complete",
          body: `${search.results.length} search results and ${context.evidence.length} policy-filtered evidence spans were collected. No business action was planned or executed.`
        });
        return;
      }

      const nextPlan = await auditedTool({
        name: "business_action_plan",
        endpoint: "POST /api/business/actions/plan",
        summary: "Translating the business request into source-system targets, diffs, risk, and autonomy.",
        run: () => planBusinessAction({ intent, mode: "autonomous", maxAutonomousRisk: "medium" }),
        describe: (result) => `${result.targets.length} source targets planned; risk ${result.risk}; status ${result.status}.`
      });
      setPlan(nextPlan);
      pushMessage({
        kind: "assistant",
        title: "Plan explanation",
        body: `${nextPlan.title}. I will target ${nextPlan.targets.map((target) => target.systemName).join(", ")}. ${nextPlan.warnings.length > 0 ? `Warnings: ${nextPlan.warnings.join(" ")}` : "No approval warning was raised for the configured autonomy policy."}`
      });

      if (conversationMode === "plan_only") {
        pushMessage({
          kind: "assistant",
          title: "Plan ready for review",
          body: `The exact plan fingerprint is ${nextPlan.fingerprint.slice(0, 12)}. No source write was executed in plan-only mode.`
        });
        return;
      }

      if (nextPlan.status === "approval_required" || nextPlan.status === "blocked") {
        pushMessage({
          kind: "audit",
          title: "Execution paused",
          body: `The product returned ${nextPlan.status}, so the PoC stopped before writing. ${nextPlan.warnings.join(" ")}`
        });
        return;
      }

      const nextRun = await auditedTool({
        name: "business_action_execute",
        endpoint: "POST /api/business/actions/execute",
        summary: "Executing through the writeback gateway and waiting for source reflection.",
        run: () => executeBusinessAction({ plan: nextPlan, idempotencyKey: `${nextPlan.id}:${nextPlan.fingerprint}` }),
        describe: (result) => `${result.writes.length} writes executed; ${result.reflections.filter((reflection) => reflection.status === "verified").length}/${result.reflections.length} reflections verified; status ${result.status}.`
      });
      setRun(nextRun);
      setPlan(nextRun.plan);
      if (nextRun.writes.length > 0) {
        pushMessage({
          kind: "write",
          title: "Source writes returned",
          body: `The writeback gateway touched ${nextRun.writes.map((write) => `${write.systemName}:${write.objectType}`).join(", ")}. Completion still depends on verified readback.`
        });
      }

      const refreshed = await auditedTool({
        name: "refresh_product_snapshot",
        endpoint: "GET /api/status + /api/source-systems + /api/business/actions/runs",
        summary: "Rereading product state after source writeback.",
        run: () => loadPocSnapshot(),
        describe: (result) => `${result.sourceRecords.length} source records are visible; latest action runs: ${result.actionRuns.length}.`
      });
      setSnapshot(refreshed);

      if (nextRun.status !== "verified") {
        pushMessage({
          kind: nextRun.status === "reflected" ? "error" : "audit",
          title: `Stopped on ${nextRun.status}`,
          body: `${nextRun.reflections.filter((reflection) => reflection.status === "verified").length}/${nextRun.reflections.length} reflections verified. The PoC will not claim completion or treat unverified readback as current semantic truth.`
        });
        return;
      }

      const reflected = await auditedTool({
        name: "semantic_search",
        endpoint: "POST /api/tools/semantic_search",
        summary: "Searching for reflected evidence created from the source reread.",
        run: () => semanticSearch(`Business Action Reflection ${intent}`, "hybrid", 6),
        describe: (result) => `${result.results.length} reflected evidence candidates returned. Top source: ${result.results[0]?.sourceName ?? "none"}.`
      });
      setSearchResults(reflected.results);
      const reflectedContext = await auditedTool({
        name: "expand_context",
        endpoint: "POST /api/tools/expand_context",
        summary: "Opening the post-write evidence pack so the UI shows current reflected source state.",
        run: () =>
          expandContext({
            query: `Business Action Reflection ${intent}`,
            chunkIds: reflected.results.slice(0, 6).map((result) => result.chunkId)
          }),
        describe: (result) => `${result.evidence.length} post-write evidence spans assembled from reflected source state.`
      });
      setContextPack(reflectedContext);

      const refreshedChunks = nextRun.semanticUpdates.reduce((total, update) => total + update.chunkIds.length, 0);
      pushMessage({
        kind: "assistant",
        title: "Completed with reflected readback",
        body: `${nextRun.status} run complete. ${nextRun.writes.length} writes, ${nextRun.reflections.filter((reflection) => reflection.status === "verified").length} verified reflections, and ${refreshedChunks} semantic ${refreshedChunks === 1 ? "chunk" : "chunks"} refreshed from source evidence.`
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Conversation failed";
      setError(message);
    } finally {
      setConversationBusy(false);
    }
  }

  async function runAgentAudit() {
    if (agentBusy || conversationBusy) return;
    setAgentBusy(true);
    setError(null);
    pushMessage({
      kind: "assistant",
      title: "Starting local agent PoC",
      body: `I am asking the product API for the bundled local agent use case using ${provider}. This run returns an audit-safe trace and model summary.`
    });

    try {
      const report = await auditedTool({
        name: "poc_local_agent",
        endpoint: "POST /api/poc/local-agent",
        summary: "Running the reproducible local agent PoC and collecting its tool trace.",
        run: () => runLocalAgentPoc(provider),
        describe: (result) => `${result.steps.length} agent steps returned; status ${result.overallStatus}; ${result.businessAction.writes} writes and ${result.businessAction.verifiedReflections} verified reflections. Provider: ${result.provider}.`
      });
      setPocReport(report);
      pushMessage({
        kind: "assistant",
        title: `${report.provider} · ${report.model}`,
        body: `Run status: ${report.overallStatus}. Orchestration: ${report.orchestrationProvider}. Model role: ${report.modelRole}. ${report.modelReasoningSummary || "The deterministic harness completed the evidence-backed trace."}`
      });
      for (const step of report.steps) {
        pushMessage({
          kind: step.tool.includes("execute") ? "write" : step.tool.includes("search") || step.tool.includes("lookup") ? "tool" : "audit",
          title: `Agent step ${step.step}: ${step.tool}`,
          body: `${step.rationale} Observation: ${step.observation}`
        });
      }
      pushMessage({
        kind: "assistant",
        title: "Agent final answer",
        body: report.finalAnswer
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent PoC failed");
    } finally {
      setAgentBusy(false);
    }
  }

  return (
    <div className="poc-shell">
      <header className="poc-header">
        <div className="brand">
          <Bot size={24} />
          <div>
            <strong>Semantic Junkyard PoC</strong>
            <span>External conversational agent cockpit</span>
          </div>
        </div>
        <div className="header-status">
          <span className={`health-dot ${snapshotState === "error" ? "error" : snapshotState === "ready" ? "ok" : "loading"}`} />
          <strong>{snapshot?.provider.kind ?? "loading"} · {snapshot?.provider.model ?? "provider"}</strong>
          <span>{latestToolStatus === "running" ? "tool running" : snapshotState}</span>
        </div>
        <nav className="header-actions">
          <button className="icon-command" onClick={refreshSnapshot} disabled={snapshotBusy} aria-label="Refresh PoC snapshot" title="Refresh PoC snapshot">
            {snapshotBusy ? <Loader2 className="spin-icon" size={17} /> : <RefreshCw size={17} />}
          </button>
          <a className="app-link" href={PRODUCT_APP_URL} target="_blank" rel="noreferrer">
            <Activity size={15} />
            Product
          </a>
          <a className="app-link" href={apiHref("/api/openapi.json")} target="_blank" rel="noreferrer">
            <Braces size={15} />
            OpenAPI
          </a>
        </nav>
      </header>

      <main className="poc-layout">
        <section className="conversation-panel panel">
          <div className="panel-header">
            <div>
              <h1>Business conversation</h1>
              <p>{activeIntent}</p>
            </div>
            <span className={`run-state ${conversationBusy ? "running" : error ? "failed" : "ready"}`}>
              {conversationBusy ? <Loader2 className="spin-icon" size={13} /> : error ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
              {conversationBusy ? "running" : error ? "needs attention" : "ready"}
            </span>
          </div>

          <div className="conversation-mode" role="group" aria-label="Conversation execution mode">
            {(["read_only", "plan_only", "autonomous"] as const).map((item) => (
              <button
                type="button"
                key={item}
                className={conversationMode === item ? "selected" : ""}
                aria-pressed={conversationMode === item}
                disabled={conversationBusy || agentBusy}
                onClick={() => setConversationMode(item)}
              >
                {item.replaceAll("_", " ")}
              </button>
            ))}
          </div>

          <form
            className="conversation-form"
            onSubmit={(event) => {
              event.preventDefault();
              runConversation();
            }}
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask for a business action that should reflect into source systems"
              aria-label="Business request"
              disabled={conversationBusy || agentBusy}
            />
            <button className="primary-command" disabled={conversationBusy || agentBusy || input.trim().length === 0}>
              {conversationBusy ? <Loader2 className="spin-icon" size={16} /> : <Send size={16} />}
              Ask product
            </button>
          </form>

          {error ? <div className="error-banner" role="alert">{error}</div> : null}

          <div className="message-thread" ref={messageThreadRef} aria-live="polite">
            {messages.map((message) => (
              <article className={`message ${message.kind}`} key={message.id}>
                <span>{message.kind}</span>
                <div>
                  <header>
                    <strong>{message.title}</strong>
                    <small>{message.at}</small>
                  </header>
                  <p>{message.body}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <aside className="inspector">
          <section className="panel product-card">
            <div className="panel-header compact">
              <div>
                <h2>Product read model</h2>
                <p>Live state via REST</p>
              </div>
              <Database size={18} />
            </div>
            <div className="status-grid">
              {statusTiles.map((tile) => (
                <div key={tile.label}>
                  <span>{tile.label}</span>
                  <strong>{tile.value}</strong>
                </div>
              ))}
            </div>
            <div className="source-list">
              {snapshot?.sourceSystems.map((system) => (
                <div key={system.id}>
                  <strong>{system.name}</strong>
                  <small>{system.capabilities.length} capabilities · {system.kind}</small>
                </div>
              ))}
            </div>
          </section>

          <section className="panel agent-controls">
            <div className="panel-header compact">
              <div>
                <h2>Bundled agent PoC</h2>
                <p>Deterministic harness with configurable trace summary</p>
              </div>
              <Zap size={18} />
            </div>
            <div className="provider-toggle" role="group" aria-label="Agent provider">
              <button disabled={conversationBusy || agentBusy} aria-pressed={provider === "local-huggingface"} className={provider === "local-huggingface" ? "selected" : ""} onClick={() => setProvider("local-huggingface")}>
                HF summary
              </button>
              <button disabled={conversationBusy || agentBusy} aria-pressed={provider === "deterministic"} className={provider === "deterministic" ? "selected" : ""} onClick={() => setProvider("deterministic")}>
                Rules summary
              </button>
            </div>
            <button className="secondary-command full" onClick={runAgentAudit} disabled={agentBusy || conversationBusy}>
              {agentBusy ? <Loader2 className="spin-icon" size={16} /> : <Play size={16} />}
              Run agent audit
            </button>
            <div className="mini-kpis">
              <div>
                <span>Steps</span>
                <strong>{pocReport?.steps.length ?? 0}</strong>
              </div>
              <div>
                <span>Writes</span>
                <strong>{pocReport?.businessAction.writes ?? 0}</strong>
              </div>
              <div>
                <span>Reflections</span>
                <strong>{pocReport ? `${pocReport.businessAction.verifiedReflections}/${pocReport.businessAction.writes}` : "0/0"}</strong>
              </div>
            </div>
          </section>

          <section className="panel tool-log">
            <div className="panel-header compact">
              <div>
                <h2>Client tool telemetry</h2>
                <p>Calls initiated by this external app</p>
              </div>
              <Workflow size={18} />
            </div>
            <div className="tool-list">
              {toolEvents.map((event) => (
                <div className={`tool-event ${event.status}`} key={event.id}>
                  <span>{event.status === "running" ? <Loader2 className="spin-icon" size={13} /> : event.status === "completed" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}</span>
                  <div>
                    <strong>{event.name}</strong>
                    <small>{event.endpoint}</small>
                    <p>{event.summary}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="server-audit-list">
              <strong>Product audit</strong>
              {snapshot?.auditEvents.slice(0, 8).map((event) => (
                <div key={event.id}>
                  <span>{event.decision}</span>
                  <p>{event.action} · {event.target}</p>
                  <small>{event.createdAt}</small>
                </div>
              ))}
            </div>
          </section>

          <section className="panel action-card">
            <div className="panel-header compact">
              <div>
                <h2>Plan and writeback</h2>
                <p>{displayedPlan?.status ?? displayedRun?.status ?? "waiting"}</p>
              </div>
              <Route size={18} />
            </div>
            <div className="action-meter">
              <div>
                <span>Targets</span>
                <strong>{displayedPlan?.targets.length ?? 0}</strong>
              </div>
              <div>
                <span>Writes</span>
                <strong>{displayedRun?.writes.length ?? 0}</strong>
              </div>
              <div>
                <span>Verified</span>
                <strong>{reflectedWrites}/{displayedRun?.reflections.length ?? 0}</strong>
              </div>
              <div>
                <span>Chunks</span>
                <strong>{semanticChunks}</strong>
              </div>
            </div>
            <div className="target-list">
              {displayedPlan?.targets.map((target) => (
                <div className="target-row" key={target.stepId}>
                  <div>
                    <strong>{target.systemName}</strong>
                    <small>{target.capability} · {target.risk} · {target.autonomy}</small>
                  </div>
                  <p>{target.diff.summary}</p>
                  <span>{displayedRun?.reflections.find((reflection) => displayedRun.writes.find((write) => write.id === reflection.writeId)?.stepId === target.stepId)?.status ?? target.status}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel evidence-card">
            <div className="panel-header compact">
              <div>
                <h2>Evidence and graph</h2>
                <p>{topEvidence?.sourceName ?? discoveryTitle}</p>
              </div>
              <FileSearch size={18} />
            </div>
            <div className="evidence-summary">
              <div>
                <Search size={15} />
                <span>{searchResults.length} search results</span>
              </div>
              <div>
                <Network size={15} />
                <span>{graph ? `${graph.nodes.length} nodes · ${graph.edges.length} edges` : "graph pending"}</span>
              </div>
              <div>
                <ShieldCheck size={15} />
                <span>{contextPack ? `${contextPack.evidence.length} evidence spans` : "context pending"}</span>
              </div>
            </div>
            <div className="evidence-list">
              {evidenceItems.map((item) => (
                <div key={item.id}>
                  <strong>{item.sourceName}</strong>
                  <p>{item.text}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="panel raw-agent-card">
            <div className="panel-header compact">
              <div>
                <h2>Agent raw trace</h2>
                <p>{pocReport ? `${pocReport.overallStatus} · ${pocReport.provider} · ${pocReport.model}` : "waiting"}</p>
              </div>
              <GitPullRequest size={18} />
            </div>
            <div className="raw-steps">
              {pocReport?.steps.map((step) => (
                <div key={`${step.step}-${step.tool}`}>
                  <span>{step.step}</span>
                  <div>
                    <strong>{step.tool}</strong>
                    <p>{step.rationale}</p>
                    <small>{step.observation}</small>
                  </div>
                </div>
              ))}
              {pocReport?.stopConditionEvaluations.map((evaluation, index) => (
                <div key={`stop-${index}-${evaluation.condition}`}>
                  <span>{evaluation.status === "passed" ? "OK" : evaluation.status === "triggered" ? "!" : "?"}</span>
                  <div>
                    <strong>Stop condition · {evaluation.status.replace("_", " ")}</strong>
                    <p>{evaluation.condition}</p>
                    <small>{evaluation.detail}</small>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
