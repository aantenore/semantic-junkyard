import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AlertTriangle,
  Boxes,
  Braces,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Database,
  FileSearch,
  Loader2,
  MonitorCog,
  Network,
  RefreshCw,
  Route,
  Search,
  Send,
  ShieldCheck,
  Waypoints,
  Workflow
} from "lucide-react";
import {
  runProductConversation,
  type ConversationArtifact,
  type ConversationEvent,
  type GroundedAnswer,
  type ConversationMode,
  type ConversationStatus,
  type MessageKind,
  type NarrationEvent,
  type ToolEvent
} from "./agent/conversation";
import { apiHref, loadPocSnapshot } from "./api/client";
import type {
  AgentIntentPlan,
  BusinessActionPlan,
  BusinessActionRun,
  ContextEnvelope,
  EvidenceSpan,
  GraphSnapshot,
  IntentInterpreterProvider,
  PermissionEnvelope,
  PocSnapshot,
  SearchResult,
  SourceResource
} from "./types/app";
import "./styles.css";

const PRODUCT_APP_URL = import.meta.env.VITE_PRODUCT_URL || "http://localhost:5173";
const POC_APP_URL = import.meta.env.VITE_POC_URL || globalThis.location.href;
const DEFAULT_REQUEST = "Explain which governed source defines dispatch eligibility for order ORD-1001";

interface ConversationMessage extends NarrationEvent {
  id: string;
  at: string;
}

function App() {
  const [snapshot, setSnapshot] = useState<PocSnapshot | null>(null);
  const [snapshotState, setSnapshotState] = useState<"loading" | "ready" | "error">("loading");
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [input, setInput] = useState(DEFAULT_REQUEST);
  const [activeRequest, setActiveRequest] = useState(DEFAULT_REQUEST);
  const [provider, setProvider] = useState<IntentInterpreterProvider>("deterministic");
  const [conversationMode, setConversationMode] = useState<ConversationMode>("read_only");
  const [conversationStatus, setConversationStatus] = useState<ConversationStatus>("idle");
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      id: "welcome",
      kind: "assistant",
      title: "External product client ready",
      body: "Each turn begins with the selected product intent interpreter, then follows governed source, discovery, evidence, planning, and writeback APIs as required.",
      at: new Date().toLocaleTimeString()
    }
  ]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [intentPlan, setIntentPlan] = useState<AgentIntentPlan | null>(null);
  const [resourceResults, setResourceResults] = useState<SourceResource[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [graph, setGraph] = useState<GraphSnapshot | null>(null);
  const [initialContext, setInitialContext] = useState<ContextEnvelope | null>(null);
  const [refreshedContext, setRefreshedContext] = useState<ContextEnvelope | null>(null);
  const [initialEvidence, setInitialEvidence] = useState<EvidenceSpan | null>(null);
  const [refreshedEvidence, setRefreshedEvidence] = useState<EvidenceSpan | null>(null);
  const [permissions, setPermissions] = useState<PermissionEnvelope | null>(null);
  const [groundedAnswer, setGroundedAnswer] = useState<GroundedAnswer | null>(null);
  const [plan, setPlan] = useState<BusinessActionPlan | null>(null);
  const [run, setRun] = useState<BusinessActionRun | null>(null);
  const [discoveryTitle, setDiscoveryTitle] = useState("waiting");
  const messageThreadRef = useRef<HTMLDivElement | null>(null);

  const conversationBusy = conversationStatus === "running";
  const displayedPlan = plan ?? run?.plan ?? null;
  const evidenceContext = refreshedContext ?? initialContext;
  const evidenceItems = evidenceContext?.evidence.slice(0, 5) ?? searchResults.slice(0, 5).map((result) => ({
    chunkId: result.chunkId,
    sourceId: result.sourceId,
    sourceName: result.sourceName,
    text: result.summary,
    metadata: {}
  }));
  const verifiedReflections = run?.reflections.filter((reflection) => reflection.status === "verified").length ?? 0;
  const refreshedChunks = run?.semanticUpdates.reduce((total, update) => total + update.chunkIds.length, 0) ?? 0;
  const registryItems = resourceResults.length > 0 ? resourceResults : snapshot?.sourceResources.slice(0, 8) ?? [];
  const reflectedDetails = useMemo(() => {
    if (!run) return [];
    return run.writes.map((write) => {
      const reflection = run.reflections.find((candidate) => candidate.writeId === write.id);
      const record = snapshot?.sourceRecords.find((candidate) => candidate.id === reflection?.sourceRecordId);
      return {
        id: write.id,
        target: `${write.systemName} / ${write.objectType}:${write.objectKey}`,
        connectorVersion: formatValue(write.payload.connectorSourceVersion) ?? formatValue(write.payload.version) ?? "unreported",
        reflectionVersion: record?.version ?? null,
        postcondition: formatValue(write.payload.connectorPostcondition) ?? "Postcondition not reported",
        passed: write.payload.externalPostconditionPassed === true && reflection?.status === "verified",
        readback: write.payload.connectorReadback,
        evidenceChunkId: reflection?.evidenceChunkId ?? null
      };
    });
  }, [run, snapshot?.sourceRecords]);

  async function refreshSnapshot() {
    setSnapshotBusy(true);
    setSnapshotState("loading");
    setSnapshotError(null);
    try {
      setSnapshot(await loadPocSnapshot());
      setSnapshotState("ready");
    } catch (error) {
      setSnapshotState("error");
      setSnapshotError(error instanceof Error ? error.message : "Product snapshot refresh failed");
    } finally {
      setSnapshotBusy(false);
    }
  }

  useEffect(() => {
    void refreshSnapshot();
  }, []);

  useEffect(() => {
    messageThreadRef.current?.scrollTo({
      top: messageThreadRef.current.scrollHeight,
      behavior: "auto"
    });
  }, [messages.length]);

  function pushMessage(message: NarrationEvent) {
    setMessages((current) => [
      ...current,
      {
        ...message,
        id: globalThis.crypto.randomUUID(),
        at: new Date().toLocaleTimeString()
      }
    ]);
  }

  function applyArtifact(artifact: ConversationArtifact) {
    switch (artifact.type) {
      case "intent":
        setIntentPlan(artifact.value);
        break;
      case "resources":
        setResourceResults(artifact.value);
        break;
      case "discovery":
        setDiscoveryTitle(artifact.value.events.at(-1)?.title ?? artifact.value.status);
        break;
      case "search":
        setSearchResults(artifact.value);
        break;
      case "graph":
        setGraph(artifact.value);
        break;
      case "context":
        if (artifact.phase === "refreshed") setRefreshedContext(artifact.value);
        else setInitialContext(artifact.value);
        break;
      case "evidence":
        if (artifact.phase === "refreshed") setRefreshedEvidence(artifact.value);
        else setInitialEvidence(artifact.value);
        break;
      case "permissions":
        setPermissions(artifact.value);
        break;
      case "answer":
        setGroundedAnswer(artifact.value);
        break;
      case "plan":
        setPlan(artifact.value);
        break;
      case "run":
        setRun(artifact.value);
        setPlan(artifact.value.plan);
        setSnapshot((current) =>
          current
            ? {
                ...current,
                actionRuns: [artifact.value, ...current.actionRuns.filter((candidate) => candidate.id !== artifact.value.id)]
              }
            : current
        );
        break;
      case "source_state":
        setSnapshot((current) =>
          current
            ? {
                ...current,
                sourceSystems: artifact.value.systems,
                sourceRecords: artifact.value.records
              }
            : current
        );
        break;
      case "entities":
        break;
    }
  }

  function handleConversationEvent(event: ConversationEvent) {
    switch (event.type) {
      case "narration":
        pushMessage(event.value);
        break;
      case "tool_started":
        setToolEvents((current) => [event.value, ...current]);
        break;
      case "tool_finished":
        setToolEvents((current) => current.map((item) => (item.id === event.value.id ? event.value : item)));
        break;
      case "artifact":
        applyArtifact(event.value);
        break;
      case "status":
        setConversationStatus(event.value);
        break;
    }
  }

  function resetConversationArtifacts() {
    setToolEvents([]);
    setIntentPlan(null);
    setResourceResults([]);
    setSearchResults([]);
    setGraph(null);
    setInitialContext(null);
    setRefreshedContext(null);
    setInitialEvidence(null);
    setRefreshedEvidence(null);
    setPermissions(null);
    setGroundedAnswer(null);
    setPlan(null);
    setRun(null);
    setDiscoveryTitle("waiting");
  }

  async function submitConversation() {
    const message = input.trim();
    if (!message || conversationBusy) return;

    resetConversationArtifacts();
    setConversationError(null);
    setConversationStatus("running");
    setActiveRequest(message);
    pushMessage({ kind: "user", title: "Request", body: message });

    try {
      await runProductConversation(
        {
          message,
          provider,
          mode: conversationMode
        },
        handleConversationEvent
      );
    } catch (error) {
      setConversationError(error instanceof Error ? error.message : "The external product conversation failed");
    }
  }

  const statusTiles = [
    { label: "Observed resources", value: snapshot?.sourceResources.length ?? 0 },
    { label: "Source sync runs", value: snapshot?.sourceSyncRuns.length ?? 0 },
    { label: "Reflected records", value: snapshot?.sourceRecords.length ?? 0 },
    { label: "Action runs", value: snapshot?.actionRuns.length ?? 0 }
  ];

  return (
    <div className="poc-shell">
      <header className="poc-header">
        <div className="brand">
          <Waypoints size={24} aria-hidden="true" />
          <div>
            <strong>Semantic Junkyard PoC</strong>
            <span>External REST conversation client</span>
          </div>
        </div>

        <div className="header-status" role="status">
          <span className={`health-dot ${snapshotState}`} />
          <strong>{snapshotState === "ready" ? "Product API connected" : snapshotState === "error" ? "Product API unavailable" : "Connecting to product API"}</strong>
          <span>{snapshot ? `${snapshot.sourceResources.length} resources / ${snapshot.status.chunks} chunks` : "live read model"}</span>
        </div>

        <nav className="header-actions" aria-label="Application links">
          <button className="icon-command" onClick={() => void refreshSnapshot()} disabled={snapshotBusy} aria-label="Refresh product snapshot" title="Refresh product snapshot">
            {snapshotBusy ? <Loader2 className="spin-icon" size={17} /> : <RefreshCw size={17} />}
          </button>
          <a className="app-link current" href={POC_APP_URL} aria-current="page">
            <MonitorCog size={15} />
            PoC client
          </a>
          <a className="app-link" href={PRODUCT_APP_URL} target="_blank" rel="noreferrer">
            <Boxes size={15} />
            Product
          </a>
          <a className="app-link" href={apiHref("/api/openapi.json")} target="_blank" rel="noreferrer">
            <Braces size={15} />
            OpenAPI
          </a>
        </nav>
      </header>

      <main className="poc-layout">
        <section className="conversation-panel panel" aria-labelledby="conversation-title">
          <div className="panel-header conversation-heading">
            <div>
              <h1 id="conversation-title">Product conversation</h1>
              <p>{activeRequest}</p>
            </div>
            <StatusBadge status={conversationStatus} />
          </div>

          <div className="control-grid">
            <fieldset>
              <legend>Intent interpreter</legend>
              <div className="segmented-control">
                <button
                  type="button"
                  className={provider === "local-huggingface" ? "selected" : ""}
                  aria-pressed={provider === "local-huggingface"}
                  disabled={conversationBusy}
                  onClick={() => setProvider("local-huggingface")}
                >
                  Local model
                </button>
                <button
                  type="button"
                  className={provider === "deterministic" ? "selected" : ""}
                  aria-pressed={provider === "deterministic"}
                  disabled={conversationBusy}
                  onClick={() => setProvider("deterministic")}
                >
                  Deterministic rules
                </button>
              </div>
            </fieldset>

            <fieldset>
              <legend>Execution boundary</legend>
              <div className="segmented-control three">
                {(["read_only", "plan_only", "autonomous"] as const).map((mode) => (
                  <button
                    type="button"
                    key={mode}
                    className={conversationMode === mode ? "selected" : ""}
                    aria-pressed={conversationMode === mode}
                    disabled={conversationBusy}
                    onClick={() => setConversationMode(mode)}
                  >
                    {mode.replaceAll("_", " ")}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>

          <form
            className="conversation-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitConversation();
            }}
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask the product a governed question or action"
              aria-label="Product request"
              disabled={conversationBusy}
            />
            <button className="primary-command" disabled={conversationBusy || input.trim().length === 0}>
              {conversationBusy ? <Loader2 className="spin-icon" size={16} /> : <Send size={16} />}
              {conversationBusy ? "Running" : conversationMode === "autonomous" ? "Plan & execute" : conversationMode === "plan_only" ? "Build plan" : "Ask product"}
            </button>
          </form>

          {conversationError ? <div className="error-banner" role="alert">{conversationError}</div> : null}
          {snapshotError ? <div className="error-banner subtle" role="alert">Snapshot: {snapshotError}</div> : null}

          <div className="message-thread" ref={messageThreadRef} aria-live="polite" aria-busy={conversationBusy}>
            {messages.map((message) => (
              <article className={`message ${message.kind}`} key={message.id}>
                <span>{messageKindLabel(message.kind)}</span>
                <div>
                  <header>
                    <strong>{message.title}</strong>
                    <time>{message.at}</time>
                  </header>
                  <p>{message.body}</p>
                </div>
              </article>
            ))}
            {groundedAnswer ? (
              <section className="grounded-answer" aria-label="Grounded answer with citations">
                <strong>Answer contract</strong>
                <p>{groundedAnswer.answer}</p>
                <ul>
                  {groundedAnswer.claims.map((claim) => (
                    <li key={`${claim.text}:${claim.citationChunkIds.join(":")}`}>
                      <span>{claim.text}</span>
                      {claim.citationChunkIds.map((chunkId) => (
                        <a key={chunkId} href={`#poc-evidence-${chunkId}`}>{chunkId}</a>
                      ))}
                    </li>
                  ))}
                </ul>
                <small>{groundedAnswer.boundary}</small>
              </section>
            ) : null}
          </div>
        </section>

        <aside className="inspector" aria-label="Product observations and audit">
          <section className="panel product-panel">
            <div className="panel-header compact">
              <div>
                <h2>Product read model</h2>
                <p>Current state from external REST reads</p>
              </div>
              <Database size={18} aria-hidden="true" />
            </div>
            <div className="status-grid">
              {statusTiles.map((tile) => (
                <div key={tile.label}>
                  <span>{tile.label}</span>
                  <strong>{tile.value}</strong>
                </div>
              ))}
            </div>
            <div className="inline-facts">
              <span>Semantic chunks <strong>{snapshot?.status.chunks ?? 0}</strong></span>
              <span>Semantic runtime <strong>{snapshot?.provider.kind ?? "waiting"}</strong></span>
            </div>
          </section>

          <section className="panel interpreter-panel">
            <div className="panel-header compact">
              <div>
                <h2>Intent contract</h2>
                <p>{intentPlan ? providerLabel(intentPlan) : provider === "local-huggingface" ? "Local model selected" : "Deterministic rules selected"}</p>
              </div>
              <ShieldCheck size={18} aria-hidden="true" />
            </div>
            {intentPlan ? (
              <div className="interpreter-content">
                <div className="model-line">
                  <span>{intentPlan.provider === "deterministic" ? "Rules" : "Local model"}</span>
                  <strong>{intentPlan.modelId ?? "No model"}</strong>
                </div>
                <div className="confidence-line">
                  <label htmlFor="intent-confidence">Confidence</label>
                  <meter id="intent-confidence" min="0" max="1" low={0.35} high={0.7} optimum={1} value={intentPlan.confidence} />
                  <strong>{Math.round(intentPlan.confidence * 100)}%</strong>
                </div>
                <div className="safe-summary">
                  <span>Harness summary</span>
                  <p>{intentPlan.summary}</p>
                </div>
                {intentPlan.warnings.length > 0 ? (
                  <div className="warning-list" role="note">
                    {intentPlan.warnings.map((warning) => <p key={warning}>{warning}</p>)}
                  </div>
                ) : null}
                <details className="compact-details">
                  <summary>Interpreted queries</summary>
                  <dl>
                    <div><dt>Resource</dt><dd>{intentPlan.resourceQuery}</dd></div>
                    <div><dt>Search</dt><dd>{intentPlan.searchQuery}</dd></div>
                    <div><dt>Entity</dt><dd>{intentPlan.entityQuery ?? "not requested"}</dd></div>
                    <div><dt>Action</dt><dd>{intentPlan.actionIntent ?? "read-only"}</dd></div>
                  </dl>
                </details>
              </div>
            ) : (
              <EmptyState text="Waiting for the first /api/agent/interpret response." />
            )}
          </section>

          <section className="panel registry-panel">
            <div className="panel-header compact">
              <div>
                <h2>Source registry</h2>
                <p>{resourceResults.length > 0 ? `${resourceResults.length} conversation matches` : `${snapshot?.sourceResources.length ?? 0} observed resources`}</p>
              </div>
              <Search size={18} aria-hidden="true" />
            </div>
            <div className="registry-list">
              {registryItems.length > 0 ? registryItems.map((resource) => (
                <div className="registry-row" key={resource.id}>
                  <div>
                    <strong>{resource.qualifiedName}</strong>
                    <small>{resource.kind} / {resource.sensitivity}</small>
                  </div>
                  <span className={resource.writable ? "write-enabled" : "read-only"}>{resource.writable ? "writable" : "read only"}</span>
                </div>
              )) : <EmptyState text={resourceResults.length === 0 && intentPlan ? "No source resource matched this conversation." : "No observed source resources are available."} />}
            </div>
            <div className="sync-line">
              <span>Latest sync</span>
              <strong>{snapshot?.sourceSyncRuns[0]?.status ?? "none"}</strong>
              <small>{snapshot?.sourceSyncRuns[0]?.objective ?? "No source synchronization run reported."}</small>
            </div>
          </section>

          <section className="panel evidence-panel">
            <div className="panel-header compact">
              <div>
                <h2>Evidence and graph</h2>
                <p>{refreshedEvidence ? "Refreshed after verified write" : initialEvidence?.sourceName ?? discoveryTitle}</p>
              </div>
              <FileSearch size={18} aria-hidden="true" />
            </div>
            <div className="evidence-summary">
              <span><Search size={14} /> {searchResults.length} results</span>
              <span><Network size={14} /> {graph ? `${graph.nodes.length} nodes / ${graph.edges.length} edges` : "graph skipped"}</span>
              <span><ShieldCheck size={14} /> {evidenceContext?.evidence.length ?? 0} evidence spans</span>
            </div>
            {refreshedEvidence ? (
              <div className="refreshed-evidence">
                <span>Post-write evidence</span>
                <strong>{refreshedEvidence.sourceName}</strong>
                <p>{refreshedEvidence.text}</p>
              </div>
            ) : null}
            <div className="evidence-list">
              {evidenceItems.length > 0 ? evidenceItems.map((item) => (
                <div className="evidence-row" id={`poc-evidence-${item.chunkId}`} key={item.chunkId}>
                  <strong>{item.sourceName}</strong>
                  <p>{item.text}</p>
                  <small>{item.chunkId}</small>
                </div>
              )) : <EmptyState text="No governed evidence has been assembled." />}
            </div>
          </section>

          <section className="panel action-panel">
            <div className="panel-header compact">
              <div>
                <h2>Exact plan and readback</h2>
                <p>{displayedPlan?.status ?? "No action plan"}</p>
              </div>
              <Route size={18} aria-hidden="true" />
            </div>
            <div className="action-meter">
              <div><span>Targets</span><strong>{displayedPlan?.targets.length ?? 0}</strong></div>
              <div><span>Writes</span><strong>{run?.writes.length ?? 0}</strong></div>
              <div><span>Verified</span><strong>{verifiedReflections}/{run?.reflections.length ?? 0}</strong></div>
              <div><span>Chunks</span><strong>{refreshedChunks}</strong></div>
            </div>
            {displayedPlan ? (
              <>
                <div className="plan-proof" role="group" aria-label="Plan identity and evidence binding">
                  <dl>
                    <div><dt>Plan ID</dt><dd>{displayedPlan.id}</dd></div>
                    <div><dt>Principal</dt><dd>{displayedPlan.principal.actor} / {displayedPlan.principal.clearance}</dd></div>
                    <div><dt>Run ID</dt><dd>{run?.id ?? "not executed"}</dd></div>
                    <div><dt>Continuity</dt><dd>{run ? (run.plan.id === displayedPlan.id && run.plan.fingerprint === displayedPlan.fingerprint ? "executed fingerprint matches reviewed fingerprint" : "identity mismatch") : "awaiting execution"}</dd></div>
                  </dl>
                  <span>Full plan fingerprint</span>
                  <code>{displayedPlan.fingerprint}</code>
                  <small>{uniqueValues(displayedPlan.targets.flatMap((target) => target.evidenceChunkIds)).length} bound evidence chunks</small>
                </div>
                <div className="target-list">
                  {displayedPlan.targets.map((target) => (
                  <div className="target-row" key={target.stepId}>
                    <div className="target-heading">
                      <div>
                        <strong>{target.systemName}</strong>
                        <small>{target.capability} / {target.risk}</small>
                      </div>
                      <span>{target.autonomy.replaceAll("_", " ")}</span>
                    </div>
                    <p>{target.diff.summary}</p>
                    <details className="compact-details">
                      <summary>Exact diff</summary>
                      <pre>{formatJson({ before: target.diff.before, after: target.diff.after })}</pre>
                    </details>
                  </div>
                  ))}
                </div>
              </>
            ) : <EmptyState text="Read-only turns do not create a business-action plan." />}

            {reflectedDetails.length > 0 ? (
              <div className="readback-block">
                <h3>Verified source readback</h3>
                {reflectedDetails.map((detail) => (
                  <div className="readback-row" key={detail.id}>
                    <div className="readback-heading">
                      {detail.passed ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                      <strong>{detail.target}</strong>
                    </div>
                    <dl>
                      <div><dt>Source version</dt><dd>{detail.connectorVersion}</dd></div>
                      <div><dt>Reflection record</dt><dd>{detail.reflectionVersion ? `v${detail.reflectionVersion}` : "unreported"}</dd></div>
                      <div><dt>Postcondition</dt><dd>{detail.passed ? "passed" : "not verified"}</dd></div>
                    </dl>
                    <p>{detail.postcondition}</p>
                    <small>Evidence chunk: {detail.evidenceChunkId ?? "not refreshed"}</small>
                    <details className="compact-details">
                      <summary>Authoritative readback</summary>
                      <pre>{formatJson(detail.readback)}</pre>
                    </details>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="panel trace-panel">
            <div className="panel-header compact">
              <div>
                <h2>REST trace and audit</h2>
                <p>{toolEvents.length} client calls / {permissions ? "autonomy checked" : "no action permission check"}</p>
              </div>
              <Workflow size={18} aria-hidden="true" />
            </div>
            <div className="tool-list">
              {toolEvents.length > 0 ? toolEvents.map((event) => (
                <details className={`tool-event ${event.status}`} data-tool-name={event.name} key={event.id}>
                  <summary>
                    <span className="tool-icon">{toolStatusIcon(event)}</span>
                    <span>
                      <strong>{event.name}</strong>
                      <small>{event.endpoint}</small>
                    </span>
                    <ChevronRight className="details-chevron" size={15} />
                  </summary>
                  <p>{event.summary}</p>
                  <div className="technical-grid">
                    <div>
                      <span>Request</span>
                      <pre>{formatJson(event.request)}</pre>
                    </div>
                    <div>
                      <span>{event.error ? "Error" : "Response"}</span>
                      <pre>{formatJson(event.error ?? event.response ?? "waiting")}</pre>
                    </div>
                  </div>
                  <time>{formatTimestamp(event.startedAt)}{event.completedAt ? ` - ${formatTimestamp(event.completedAt)}` : ""}</time>
                </details>
              )) : <EmptyState text="REST calls for the current conversation will appear here." />}
            </div>
            <details className="server-audit compact-details">
              <summary>Product audit events ({snapshot?.auditEvents.length ?? 0})</summary>
              <div>
                {snapshot?.auditEvents.slice(0, 10).map((event) => (
                  <p key={event.id}><strong>{event.decision}</strong> {event.action} / {event.target}</p>
                ))}
              </div>
            </details>
          </section>
        </aside>
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: ConversationStatus }) {
  const failed = ["failed", "blocked", "insufficient_evidence", "reconciliation_required"].includes(status);
  const pending = status === "running" || status === "approval_required" || status === "plan_ready";
  return (
    <span className={`run-state ${failed ? "failed" : pending ? "pending" : "ready"}`}>
      {status === "running" ? <Loader2 className="spin-icon" size={13} /> : failed ? <CircleStop size={13} /> : pending ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
      {statusLabel(status)}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="empty-state">{text}</p>;
}

function toolStatusIcon(event: ToolEvent) {
  if (event.status === "running") return <Loader2 className="spin-icon" size={14} />;
  if (event.status === "failed") return <AlertTriangle size={14} />;
  return <CheckCircle2 size={14} />;
}

function statusLabel(status: ConversationStatus): string {
  const labels: Record<ConversationStatus, string> = {
    idle: "ready",
    running: "running",
    answered: "answered",
    plan_ready: "plan ready",
    approval_required: "approval required",
    reconciliation_required: "reconciliation required",
    blocked: "blocked",
    insufficient_evidence: "insufficient evidence",
    verified: "verified",
    failed: "failed"
  };
  return labels[status];
}

function messageKindLabel(kind: MessageKind): string {
  const labels: Record<MessageKind, string> = {
    user: "You",
    assistant: "Client",
    tool: "Calling",
    audit: "Observed",
    write: "Write",
    stop: "Stopped",
    error: "Error"
  };
  return labels[kind];
}

function providerLabel(intent: AgentIntentPlan): string {
  return intent.provider === "deterministic" ? "Deterministic rules / no model" : `Local Hugging Face / ${intent.modelId ?? "model unreported"}`;
}

function formatJson(value: unknown): string {
  if (value === undefined) return "not available";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleTimeString();
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

declare global {
  interface Window {
    __semanticJunkyardPocRoot?: Root;
  }
}

const rootElement = document.getElementById("root")!;
const root = window.__semanticJunkyardPocRoot ?? createRoot(rootElement);
window.__semanticJunkyardPocRoot = root;
root.render(
  <StrictMode>
    <App />
  </StrictMode>
);
