import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  File,
  FileSearch,
  FolderTree,
  GitBranch,
  Loader2,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  ShieldCheck,
  Trash2,
  X,
  XCircle
} from "lucide-react";
import type {
  CreateSourceConnectionRequest,
  SemanticProposal,
  SourceConnection,
  SourceConnectionKind,
  SourceResource,
  SourceSyncEvent,
  SourceSyncRun,
  SourceWriteMode
} from "@semantic-junkyard/shared";
import {
  createSourceConnection,
  decideSemanticProposal,
  deleteSourceConnection,
  searchSourceResources,
  syncSourceConnection,
  testSourceConnection
} from "../api/client";
import type { AppSnapshot } from "../types/app";

type SnapshotState = "loading" | "ready" | "degraded" | "error";
type NoticeTone = "info" | "success" | "warning" | "error";
type ProposalFilter = "all" | SemanticProposal["status"];

interface SourceWorkbenchProps {
  snapshot: AppSnapshot | null;
  snapshotState: SnapshotState;
  onRefresh: () => Promise<boolean>;
}

interface OperationNotice {
  tone: NoticeTone;
  message: string;
}

const DEFAULT_SYNC_OBJECTIVE = "Discover supply-chain assets, metric definitions, lineage, governance signals, and safe source actions.";

export function SourceWorkbench({ snapshot, snapshotState, onRefresh }: SourceWorkbenchProps) {
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [connectionKind, setConnectionKind] = useState<SourceConnectionKind>("filesystem");
  const [connectionName, setConnectionName] = useState("");
  const [connectionDescription, setConnectionDescription] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [includePaths, setIncludePaths] = useState("");
  const [maxFiles, setMaxFiles] = useState(250);
  const [maxFileMegabytes, setMaxFileMegabytes] = useState(2);
  const [recursive, setRecursive] = useState(true);
  const [ingestionMode, setIngestionMode] = useState<"full_data" | "metadata_only" | "external_reference">("full_data");
  const [sampleRows, setSampleRows] = useState(0);
  const [writeMode, setWriteMode] = useState<SourceWriteMode>("read_only");
  const [writeRuleEnabled, setWriteRuleEnabled] = useState(false);
  const [writeRuleTable, setWriteRuleTable] = useState("orders");
  const [writeRuleAliases, setWriteRuleAliases] = useState("order");
  const [writeRuleKey, setWriteRuleKey] = useState("order_id");
  const [writeRuleColumns, setWriteRuleColumns] = useState("status");
  const [writeRuleRisk, setWriteRuleRisk] = useState<"low" | "medium" | "high">("low");
  const [semanticContractPaths, setSemanticContractPaths] = useState("");
  const [syncObjective, setSyncObjective] = useState(DEFAULT_SYNC_OBJECTIVE);
  const [syncProvider, setSyncProvider] = useState<"deterministic" | "local-huggingface">("deterministic");
  const [connectionOperation, setConnectionOperation] = useState<string | null>(null);
  const [operationNotice, setOperationNotice] = useState<OperationNotice | null>(null);
  const [resourceQuery, setResourceQuery] = useState("Late Dispatch Rate");
  const [resourceSearchResults, setResourceSearchResults] = useState<SourceResource[] | null>(null);
  const [resourceSearchState, setResourceSearchState] = useState<"idle" | "loading" | "error">("idle");
  const [resourceSearchError, setResourceSearchError] = useState<string | null>(null);
  const [proposalFilter, setProposalFilter] = useState<ProposalFilter>("proposed");
  const [proposalRationales, setProposalRationales] = useState<Record<string, string>>({});
  const [proposalOperation, setProposalOperation] = useState<string | null>(null);
  const [proposalUpdates, setProposalUpdates] = useState<Record<string, SemanticProposal>>({});

  const connections = snapshot?.sourceConnections ?? [];
  const initialLoading = snapshotState === "loading" && !snapshot;
  const snapshotError = snapshotState === "error" && !snapshot ? "The product snapshot could not be loaded. Use Refresh to retry." : undefined;
  const connectionError = snapshot?.surfaceErrors.sourceConnections ?? snapshotError;
  const resourceError = snapshot?.surfaceErrors.sourceResources ?? snapshotError;
  const syncRunError = snapshot?.surfaceErrors.sourceSyncRuns ?? snapshotError;
  const proposalError = snapshot?.surfaceErrors.semanticProposals ?? snapshotError;

  useEffect(() => {
    if (connections.length === 0) {
      setSelectedConnectionId(null);
      if (snapshot && !connectionError) setCreateOpen(true);
      return;
    }
    if (!selectedConnectionId || !connections.some((connection) => connection.id === selectedConnectionId)) {
      setSelectedConnectionId(connections[0]?.id ?? null);
    }
  }, [connectionError, connections, selectedConnectionId, snapshot]);

  const selectedConnection = connections.find((connection) => connection.id === selectedConnectionId) ?? null;
  const resourcesForSelected = useMemo(
    () => (snapshot?.sourceResources ?? []).filter((resource) => !selectedConnectionId || resource.connectionId === selectedConnectionId),
    [selectedConnectionId, snapshot?.sourceResources]
  );
  const displayedResources = resourceSearchResults ?? resourcesForSelected;
  const proposals = useMemo(
    () => (snapshot?.semanticProposals ?? []).map((proposal) => proposalUpdates[proposal.id] ?? proposal),
    [proposalUpdates, snapshot?.semanticProposals]
  );
  const filteredProposals = useMemo(
    () => proposals.filter((proposal) => proposalFilter === "all" || proposal.status === proposalFilter),
    [proposalFilter, proposals]
  );
  const latestSyncRun = useMemo(() => {
    const matchingRuns = (snapshot?.sourceSyncRuns ?? []).filter((run) => !selectedConnectionId || run.connectionId === selectedConnectionId);
    return matchingRuns.slice().sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0] ?? null;
  }, [selectedConnectionId, snapshot?.sourceSyncRuns]);
  const resourceById = useMemo(() => new Map((snapshot?.sourceResources ?? []).map((resource) => [resource.id, resource])), [snapshot?.sourceResources]);
  const connectionById = useMemo(() => new Map(connections.map((connection) => [connection.id, connection])), [connections]);
  const proposedCount = proposals.filter((proposal) => proposal.status === "proposed" && !proposal.authoritative).length;

  function resetKindDefaults(kind: SourceConnectionKind) {
    setConnectionKind(kind);
    setWriteMode(kind === "git" ? "approval_required" : "read_only");
    setSourcePath("");
    setIncludePaths("");
    setSemanticContractPaths("");
    setWriteRuleEnabled(false);
  }

  function connectionRequest(): CreateSourceConnectionRequest {
    const common = { name: connectionName.trim(), description: connectionDescription.trim() };
    const maxFileBytes = Math.max(1, Math.round(maxFileMegabytes * 1_000_000));
    if (connectionKind === "filesystem") {
      return {
        ...common,
        config: {
          kind: "filesystem",
          rootPath: sourcePath.trim(),
          recursive,
          maxFiles,
          maxFileBytes,
          ingestionMode
        }
      };
    }
    if (connectionKind === "sqlite") {
      return {
        ...common,
        config: {
          kind: "sqlite",
          databasePath: sourcePath.trim(),
          includeTables: splitList(includePaths),
          sampleRows,
          writeMode,
          writeRules: writeRuleEnabled
            ? [
                {
                  table: writeRuleTable.trim(),
                  aliases: splitList(writeRuleAliases),
                  keyColumn: writeRuleKey.trim(),
                  allowedColumns: splitList(writeRuleColumns),
                  risk: writeRuleRisk
                }
              ]
            : []
        }
      };
    }
    return {
      ...common,
      config: {
        kind: "git",
        repositoryPath: sourcePath.trim(),
        includePaths: splitList(includePaths),
        maxFiles,
        maxFileBytes,
        writeMode,
        semanticContractPaths: splitList(semanticContractPaths)
      }
    };
  }

  async function onCreateConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConnectionOperation("create");
    setOperationNotice({ tone: "info", message: "Creating source connection..." });
    try {
      const created = await createSourceConnection(connectionRequest());
      setCreateOpen(false);
      setConnectionName("");
      setConnectionDescription("");
      setSourcePath("");
      const refreshed = await onRefresh();
      if (refreshed) setSelectedConnectionId(created.id);
      setOperationNotice({
        tone: refreshed ? "success" : "warning",
        message: refreshed ? `${created.name} was added to the source registry.` : `${created.name} was created, but the registry refresh failed.`
      });
    } catch (error) {
      setOperationNotice({ tone: "error", message: errorMessage(error, "Connection creation failed.") });
    } finally {
      setConnectionOperation(null);
    }
  }

  async function onTestConnection(connection: SourceConnection) {
    setConnectionOperation(`test:${connection.id}`);
    setOperationNotice({ tone: "info", message: `Testing ${connection.name}...` });
    try {
      const result = await testSourceConnection(connection.id);
      const refreshed = await onRefresh();
      setOperationNotice({
        tone: result.ok ? (refreshed ? "success" : "warning") : "error",
        message: `${result.message}${refreshed ? "" : " The test completed, but the registry refresh failed."}`
      });
    } catch (error) {
      setOperationNotice({ tone: "error", message: errorMessage(error, `Connection test failed for ${connection.name}.`) });
    } finally {
      setConnectionOperation(null);
    }
  }

  async function onSyncConnection(connection: SourceConnection) {
    setConnectionOperation(`sync:${connection.id}`);
    setOperationNotice({ tone: "info", message: `Synchronizing ${connection.name}...` });
    try {
      const run = await syncSourceConnection(connection.id, { objective: syncObjective, provider: syncProvider });
      const refreshed = await onRefresh();
      setSelectedConnectionId(connection.id);
      setResourceSearchResults(null);
      setOperationNotice({
        tone: run.status === "completed" && refreshed ? "success" : "warning",
        message: `${run.status === "completed" ? "Sync completed" : `Sync ${run.status}`}: ${run.resourcesDiscovered} resources, ${run.assetsPublished} assets, ${run.proposalsCreated} proposals.${refreshed ? "" : " Snapshot refresh failed."}`
      });
    } catch (error) {
      setOperationNotice({ tone: "error", message: errorMessage(error, `Synchronization failed for ${connection.name}.`) });
      await onRefresh();
    } finally {
      setConnectionOperation(null);
    }
  }

  async function onDeleteConnection(connection: SourceConnection) {
    if (!window.confirm(`Delete source connection "${connection.name}" and its registry observations?`)) {
      setOperationNotice({ tone: "info", message: `Deletion cancelled for ${connection.name}.` });
      return;
    }
    setConnectionOperation(`delete:${connection.id}`);
    setOperationNotice({ tone: "info", message: `Deleting ${connection.name}...` });
    try {
      await deleteSourceConnection(connection.id);
      setSelectedConnectionId(null);
      setResourceSearchResults(null);
      const refreshed = await onRefresh();
      setOperationNotice({
        tone: refreshed ? "success" : "warning",
        message: refreshed ? `${connection.name} was deleted.` : `${connection.name} was deleted, but the registry refresh failed.`
      });
    } catch (error) {
      setOperationNotice({ tone: "error", message: errorMessage(error, `Deletion failed for ${connection.name}.`) });
    } finally {
      setConnectionOperation(null);
    }
  }

  async function onSearchResources(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resourceQuery.trim()) return;
    setResourceSearchState("loading");
    setResourceSearchError(null);
    try {
      const result = await searchSourceResources({
        query: resourceQuery.trim(),
        connectionId: selectedConnectionId ?? undefined,
        topK: 12
      });
      setResourceSearchResults(result.resources);
      setResourceSearchState("idle");
    } catch (error) {
      setResourceSearchState("error");
      setResourceSearchError(errorMessage(error, "Source resource search failed."));
    }
  }

  async function onProposalDecision(proposal: SemanticProposal, decision: "accepted" | "rejected") {
    const rationale = proposalRationales[proposal.id]?.trim() ?? "";
    if (!rationale || proposal.status !== "proposed" || proposal.authoritative) return;
    setProposalOperation(`${proposal.id}:${decision}`);
    setOperationNotice({ tone: "info", message: `${decision === "accepted" ? "Accepting" : "Rejecting"} semantic proposal...` });
    try {
      const decided = await decideSemanticProposal(proposal.id, { decision, rationale });
      setProposalUpdates((current) => ({ ...current, [decided.id]: decided }));
      setProposalRationales((current) => ({ ...current, [proposal.id]: "" }));
      const refreshed = await onRefresh();
      setOperationNotice({
        tone: refreshed ? "success" : "warning",
        message: refreshed ? `Proposal ${decision} with operator rationale.` : `Proposal ${decision}; snapshot refresh failed, so the local row was updated from the decision response.`
      });
    } catch (error) {
      setOperationNotice({ tone: "error", message: errorMessage(error, `Proposal could not be ${decision}.`) });
    } finally {
      setProposalOperation(null);
    }
  }

  return (
    <section className="panel source-workbench" id="sources" aria-labelledby="sources-title">
      <div className="source-workbench-header">
        <div>
          <span className="section-kicker">Operator sources</span>
          <h2 id="sources-title">Source registry</h2>
          <p>
            {snapshotState === "loading" && !snapshot
              ? "Loading registry snapshot"
              : `${connectionError ? "Connections unavailable" : `${connections.length} configured`} / ${resourceError ? "resources unavailable" : `${snapshot?.sourceResources.length ?? 0} observed`} / ${proposalError ? "review unavailable" : `${proposedCount} reviewable`}`}
          </p>
        </div>
        <div className="source-header-actions">
          <label className="inline-control">
            <span>Sync runtime</span>
            <select value={syncProvider} onChange={(event) => setSyncProvider(event.target.value as typeof syncProvider)} disabled={Boolean(connectionOperation)}>
              <option value="deterministic">Deterministic</option>
              <option value="local-huggingface">Local Hugging Face</option>
            </select>
          </label>
          <button className="secondary-action" type="button" aria-expanded={createOpen} aria-controls="connection-create-form" onClick={() => setCreateOpen((open) => !open)}>
            {createOpen ? <X size={16} /> : <Plus size={16} />}
            {createOpen ? "Close" : "Add connection"}
          </button>
        </div>
      </div>

      <label className="sync-objective-control">
        <span>Sync objective</span>
        <input value={syncObjective} onChange={(event) => setSyncObjective(event.target.value)} disabled={Boolean(connectionOperation)} />
      </label>

      {createOpen ? (
        <form className="connection-create-band" id="connection-create-form" onSubmit={onCreateConnection}>
          <div className="connection-kind-picker" role="group" aria-label="Connection kind">
            {([
              ["filesystem", "Filesystem", <FolderTree size={16} />],
              ["sqlite", "SQLite", <Database size={16} />],
              ["git", "Git", <GitBranch size={16} />]
            ] as const).map(([kind, label, icon]) => (
              <button type="button" key={kind} className={connectionKind === kind ? "selected" : ""} aria-pressed={connectionKind === kind} onClick={() => resetKindDefaults(kind)}>
                {icon}
                {label}
              </button>
            ))}
          </div>

          <div className="connection-form-grid common-fields">
            <label className="control-field">
              <span>Name</span>
              <input value={connectionName} onChange={(event) => setConnectionName(event.target.value)} required maxLength={255} placeholder="Operations Database" />
            </label>
            <label className="control-field span-two">
              <span>Description</span>
              <input value={connectionDescription} onChange={(event) => setConnectionDescription(event.target.value)} maxLength={2000} placeholder="Operator-owned source description" />
            </label>
          </div>

          {connectionKind === "filesystem" ? (
            <div className="connection-form-grid">
              <label className="control-field span-two">
                <span>Root path</span>
                <input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} required placeholder="/absolute/path/to/source" />
              </label>
              <label className="control-field">
                <span>Ingestion mode</span>
                <select value={ingestionMode} onChange={(event) => setIngestionMode(event.target.value as typeof ingestionMode)}>
                  <option value="full_data">Full data</option>
                  <option value="metadata_only">Metadata only</option>
                  <option value="external_reference">External reference</option>
                </select>
              </label>
              <NumberControl label="Max files" value={maxFiles} min={1} max={10000} onChange={setMaxFiles} />
              <NumberControl label="Max file MB" value={maxFileMegabytes} min={0.001} max={50} step={0.5} onChange={setMaxFileMegabytes} />
              <label className="check-control">
                <input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
                <span>Recursive discovery</span>
              </label>
            </div>
          ) : null}

          {connectionKind === "sqlite" ? (
            <div className="connection-form-grid">
              <label className="control-field span-two">
                <span>Database path</span>
                <input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} required placeholder="/absolute/path/to/operations.sqlite" />
              </label>
              <label className="control-field">
                <span>Include tables</span>
                <input value={includePaths} onChange={(event) => setIncludePaths(event.target.value)} placeholder="orders, shipments" />
              </label>
              <NumberControl label="Sample rows" value={sampleRows} min={0} max={20} onChange={setSampleRows} />
              <WriteModeControl value={writeMode} onChange={setWriteMode} />
              <label className="check-control">
                <input type="checkbox" checked={writeRuleEnabled} onChange={(event) => setWriteRuleEnabled(event.target.checked)} />
                <span>Bounded write rule</span>
              </label>
              {writeRuleEnabled ? (
                <div className="write-rule-fields span-all">
                  <label className="control-field">
                    <span>Table</span>
                    <input value={writeRuleTable} onChange={(event) => setWriteRuleTable(event.target.value)} required />
                  </label>
                  <label className="control-field">
                    <span>Aliases</span>
                    <input value={writeRuleAliases} onChange={(event) => setWriteRuleAliases(event.target.value)} placeholder="order" />
                  </label>
                  <label className="control-field">
                    <span>Key column</span>
                    <input value={writeRuleKey} onChange={(event) => setWriteRuleKey(event.target.value)} required />
                  </label>
                  <label className="control-field">
                    <span>Allowed columns</span>
                    <input value={writeRuleColumns} onChange={(event) => setWriteRuleColumns(event.target.value)} required placeholder="status" />
                  </label>
                  <label className="control-field">
                    <span>Risk</span>
                    <select value={writeRuleRisk} onChange={(event) => setWriteRuleRisk(event.target.value as typeof writeRuleRisk)}>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}

          {connectionKind === "git" ? (
            <div className="connection-form-grid">
              <label className="control-field span-two">
                <span>Repository path</span>
                <input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} required placeholder="/absolute/path/to/repository" />
              </label>
              <label className="control-field">
                <span>Include paths</span>
                <input value={includePaths} onChange={(event) => setIncludePaths(event.target.value)} placeholder="contracts, models" />
              </label>
              <label className="control-field span-two">
                <span>Semantic contract paths</span>
                <input value={semanticContractPaths} onChange={(event) => setSemanticContractPaths(event.target.value)} placeholder="contracts/late-dispatch-rate.yaml" />
              </label>
              <WriteModeControl value={writeMode} onChange={setWriteMode} />
              <NumberControl label="Max files" value={maxFiles} min={1} max={10000} onChange={setMaxFiles} />
              <NumberControl label="Max file MB" value={maxFileMegabytes} min={0.001} max={50} step={0.5} onChange={setMaxFileMegabytes} />
            </div>
          ) : null}

          <div className="connection-form-actions">
            <button className="primary-action" type="submit" disabled={connectionOperation === "create"}>
              {connectionOperation === "create" ? <Loader2 className="spin-icon" size={16} /> : <Plus size={16} />}
              {connectionOperation === "create" ? "Creating" : `Create ${kindLabel(connectionKind)}`}
            </button>
          </div>
        </form>
      ) : null}

      {operationNotice ? (
        <div className={`operation-notice ${operationNotice.tone}`} role={operationNotice.tone === "error" ? "alert" : "status"} aria-live="polite">
          {noticeIcon(operationNotice.tone)}
          <span>{operationNotice.message}</span>
          <button type="button" className="notice-dismiss" aria-label="Dismiss source operation status" title="Dismiss" onClick={() => setOperationNotice(null)}>
            <X size={14} />
          </button>
        </div>
      ) : null}

      <section className="source-registry-surface" aria-labelledby="connections-title">
        <div className="surface-heading">
          <div>
            <h3 id="connections-title">Connections</h3>
            <span>{selectedConnection ? `Selected: ${selectedConnection.name}` : "No connection selected"}</span>
          </div>
          <span className={`surface-state ${connectionError ? "error" : snapshotState}`}>{connectionError ? "Unavailable" : snapshotState === "loading" ? "Loading" : "Registry online"}</span>
        </div>

        {snapshotState === "loading" && !snapshot ? <SurfaceState icon={<Loader2 className="spin-icon" size={17} />} title="Loading source connections" detail="Waiting for the registry endpoint." /> : null}
        {connectionError ? <SurfaceState icon={<CircleAlert size={17} />} title="Source connections unavailable" detail={connectionError} tone="error" /> : null}
        {!connectionError && snapshot && connections.length === 0 ? <SurfaceState icon={<ServerCog size={17} />} title="No source connections" detail="Add a filesystem, SQLite, or Git connection." /> : null}

        {!connectionError && connections.length > 0 ? (
          <div className="connection-table" role="table" aria-label="Source connections">
            <div className="connection-row connection-head" role="row">
              <span role="columnheader">Connector</span>
              <span role="columnheader">Status / location</span>
              <span role="columnheader">Observed / last sync</span>
              <span role="columnheader">Write capability</span>
              <span role="columnheader">Actions</span>
            </div>
            {connections.map((connection) => {
              const observedCount = snapshot?.sourceResources.filter((resource) => resource.connectionId === connection.id).length ?? 0;
              const isSelected = connection.id === selectedConnectionId;
              return (
                <div className={`connection-row ${isSelected ? "selected" : ""}`} role="row" key={connection.id}>
                  <button
                    type="button"
                    className="connection-identity"
                    onClick={() => {
                      setSelectedConnectionId(connection.id);
                      setResourceSearchResults(null);
                    }}
                    aria-pressed={isSelected}
                  >
                    <ConnectorIcon kind={connection.kind} />
                    <span>
                      <strong>{connection.name}</strong>
                      <small>{kindLabel(connection.kind)}</small>
                    </span>
                  </button>
                  <div className="connection-cell" role="cell">
                    <span className={`connector-status ${connection.status}`}>{connection.status}</span>
                    <small title={connectionLocation(connection)}>{connectionLocation(connection)}</small>
                    {connection.lastError ? <small className="cell-error">{connection.lastError}</small> : null}
                  </div>
                  <div className="connection-cell" role="cell">
                    <strong>{resourceError ? "Unavailable" : `${observedCount} resource${observedCount === 1 ? "" : "s"}`}</strong>
                    <small>{connection.lastSyncAt ? formatDateTime(connection.lastSyncAt) : "Never synchronized"}</small>
                  </div>
                  <div className="connection-cell" role="cell">
                    <strong>{writeModeLabel(connection)}</strong>
                    <small>{writeCapability(connection)}</small>
                  </div>
                  <div className="connection-actions" role="cell" aria-busy={connectionOperation?.endsWith(connection.id)}>
                    <button className="source-action-button" type="button" disabled={Boolean(connectionOperation)} onClick={() => void onTestConnection(connection)}>
                      {connectionOperation === `test:${connection.id}` ? <Loader2 className="spin-icon" size={14} /> : <CheckCircle2 size={14} />}
                      {connectionOperation === `test:${connection.id}` ? "Testing" : "Test"}
                    </button>
                    <button className="source-action-button primary" type="button" disabled={Boolean(connectionOperation) || !syncObjective.trim()} onClick={() => void onSyncConnection(connection)}>
                      {connectionOperation === `sync:${connection.id}` ? <Loader2 className="spin-icon" size={14} /> : <RefreshCw size={14} />}
                      {connectionOperation === `sync:${connection.id}` ? "Syncing" : "Sync"}
                    </button>
                    <button
                      className="connection-delete-button"
                      type="button"
                      disabled={Boolean(connectionOperation)}
                      aria-label={`Delete ${connection.name}`}
                      title={`Delete ${connection.name}`}
                      onClick={() => void onDeleteConnection(connection)}
                    >
                      {connectionOperation === `delete:${connection.id}` ? <Loader2 className="spin-icon" size={15} /> : <Trash2 size={15} />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <div className="source-detail-grid">
        <section className="source-detail-surface resource-inventory" aria-labelledby="resources-title">
          <div className="surface-heading">
            <div>
              <h3 id="resources-title">Observed resources</h3>
              <span>{resourceSearchResults ? `${resourceSearchResults.length} search matches` : `${resourcesForSelected.length} in snapshot`}</span>
            </div>
            {resourceSearchResults ? (
              <button className="compact-icon-button" type="button" aria-label="Clear resource search" title="Clear search" onClick={() => setResourceSearchResults(null)}>
                <X size={15} />
              </button>
            ) : null}
          </div>
          <form className="resource-search" onSubmit={onSearchResources}>
            <Search size={15} />
            <input aria-label="Search observed resources" value={resourceQuery} onChange={(event) => setResourceQuery(event.target.value)} />
            <button type="submit" disabled={resourceSearchState === "loading" || !resourceQuery.trim() || Boolean(resourceError)}>
              {resourceSearchState === "loading" ? <Loader2 className="spin-icon" size={14} /> : <FileSearch size={14} />}
              {resourceSearchState === "loading" ? "Searching" : "Search"}
            </button>
          </form>
          {resourceError ? <SurfaceState icon={<CircleAlert size={17} />} title="Resource inventory unavailable" detail={resourceError} tone="error" /> : null}
          {resourceSearchState === "error" ? <SurfaceState icon={<CircleAlert size={17} />} title="Resource search failed" detail={resourceSearchError ?? "The search endpoint returned an error."} tone="error" /> : null}
          {initialLoading ? <SurfaceState icon={<Loader2 className="spin-icon" size={17} />} title="Loading observed resources" detail="Waiting for the resource inventory endpoint." /> : null}
          {!resourceError && !initialLoading && resourceSearchState !== "error" && !selectedConnection ? <SurfaceState icon={<File size={17} />} title="Select a connection" detail="Resource inventory is scoped to the selected connector." /> : null}
          {!resourceError && !initialLoading && selectedConnection && displayedResources.length === 0 && resourceSearchState !== "loading" ? (
            <SurfaceState
              icon={<File size={17} />}
              title={resourceSearchResults ? "No matching resources" : "No observed resources"}
              detail={resourceSearchResults ? `No resource matched "${resourceQuery}".` : "Run Sync to observe source resources."}
            />
          ) : null}
          {!resourceError && resourceSearchState !== "error" && displayedResources.length > 0 ? (
            <div className="resource-list">
              {displayedResources.slice(0, 12).map((resource) => (
                <div className="resource-row" key={resource.id}>
                  <ResourceIcon resource={resource} />
                  <div>
                    <strong title={resource.qualifiedName}>{resource.name}</strong>
                    <small title={resource.uri}>{resource.qualifiedName}</small>
                  </div>
                  <span className={`sensitivity ${resource.sensitivity}`}>{resource.sensitivity}</span>
                  <span className={`writable-state ${resource.writable ? "writable" : "read-only"}`}>{resource.writable ? "Writable" : "Read only"}</span>
                  <time dateTime={resource.observedAt}>{formatDateTime(resource.observedAt)}</time>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="source-detail-surface semantic-review" aria-labelledby="review-title">
          <div className="surface-heading review-heading">
            <div>
              <h3 id="review-title">Semantic review</h3>
              <span>{proposalError ? "Queue unavailable" : `${filteredProposals.length} shown / ${proposedCount} reviewable`}</span>
            </div>
            <div className="review-filter" role="group" aria-label="Proposal status filter">
              {(["proposed", "accepted", "rejected", "all"] as const).map((status) => (
                <button type="button" key={status} className={proposalFilter === status ? "selected" : ""} aria-pressed={proposalFilter === status} onClick={() => setProposalFilter(status)}>
                  {status}
                </button>
              ))}
            </div>
          </div>
          {proposalError ? <SurfaceState icon={<CircleAlert size={17} />} title="Semantic proposals unavailable" detail={proposalError} tone="error" /> : null}
          {initialLoading ? <SurfaceState icon={<Loader2 className="spin-icon" size={17} />} title="Loading semantic proposals" detail="Waiting for the review queue endpoint." /> : null}
          {!proposalError && !initialLoading && filteredProposals.length === 0 ? (
            <SurfaceState icon={<ShieldCheck size={17} />} title={`No ${proposalFilter === "all" ? "" : `${proposalFilter} `}proposals`} detail="The registry has no proposals in this state." />
          ) : null}
          {!proposalError && !initialLoading && filteredProposals.length > 0 ? (
            <div className="proposal-list">
              {filteredProposals.map((proposal) => {
                const reviewable = proposal.status === "proposed" && !proposal.authoritative;
                const rationale = proposalRationales[proposal.id] ?? "";
                const evidenceNames = [...new Set(proposal.evidenceResourceIds.map((id) => resourceById.get(id)?.name ?? shortId(id)))];
                return (
                  <article className={`proposal-row status-${proposal.status}`} key={proposal.id}>
                    <div className="proposal-title-row">
                      <div>
                        <span className="proposal-kind">{proposal.kind.replaceAll("_", " ")}</span>
                        <strong>{resourceById.get(proposal.subjectId)?.name ?? shortId(proposal.subjectId)} {humanizePredicate(proposal.predicate)} {proposal.objectId ? resourceById.get(proposal.objectId)?.name ?? shortId(proposal.objectId) : ""}</strong>
                      </div>
                      <span className={`proposal-status ${proposal.status}`}>{proposal.status}</span>
                    </div>
                    <p>{proposal.explanation}</p>
                    <div className="proposal-metadata">
                      <span><strong>{Math.round(proposal.confidence * 100)}%</strong> confidence</span>
                      <span>{connectionById.get(proposal.connectionId)?.name ?? shortId(proposal.connectionId)}</span>
                      <span>{proposal.origin.replaceAll("_", " ")}</span>
                      <span>{proposal.authoritative ? <LockKeyhole size={12} /> : <ShieldCheck size={12} />}{proposal.authoritative ? "Authoritative" : "Reviewable origin"}</span>
                      <span>
                        {proposal.evidenceResourceIds.length} resource{proposal.evidenceResourceIds.length === 1 ? "" : "s"} / {proposal.evidenceChunkIds.length} chunk{proposal.evidenceChunkIds.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="proposal-evidence" title={evidenceNames.join(", ")}>
                      <FileSearch size={13} />
                      <span>{evidenceNames.join(", ") || "No resource evidence linked"}</span>
                    </div>
                    {reviewable ? (
                      <div className="proposal-decision">
                        <label>
                          <span>Decision rationale</span>
                          <input
                            value={rationale}
                            onChange={(event) => setProposalRationales((current) => ({ ...current, [proposal.id]: event.target.value }))}
                            maxLength={2000}
                            placeholder="Required for accept or reject"
                          />
                        </label>
                        <button
                          type="button"
                          className="decision-button accept"
                          disabled={Boolean(proposalOperation) || !rationale.trim()}
                          title={!rationale.trim() ? "Enter a rationale before accepting" : "Accept proposal"}
                          onClick={() => void onProposalDecision(proposal, "accepted")}
                        >
                          {proposalOperation === `${proposal.id}:accepted` ? <Loader2 className="spin-icon" size={14} /> : <Check size={14} />}
                          {proposalOperation === `${proposal.id}:accepted` ? "Accepting" : "Accept"}
                        </button>
                        <button
                          type="button"
                          className="decision-button reject"
                          disabled={Boolean(proposalOperation) || !rationale.trim()}
                          title={!rationale.trim() ? "Enter a rationale before rejecting" : "Reject proposal"}
                          onClick={() => void onProposalDecision(proposal, "rejected")}
                        >
                          {proposalOperation === `${proposal.id}:rejected` ? <Loader2 className="spin-icon" size={14} /> : <XCircle size={14} />}
                          {proposalOperation === `${proposal.id}:rejected` ? "Rejecting" : "Reject"}
                        </button>
                      </div>
                    ) : (
                      <div className="proposal-decision-record">
                        <span>{proposal.authoritative ? "Source-controlled assertion" : proposal.decidedBy ? `Decided by ${proposal.decidedBy}` : "Not reviewable in this state"}</span>
                        {proposal.decisionRationale ? <small>{proposal.decisionRationale}</small> : null}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          ) : null}
        </section>

        <section className="source-detail-surface sync-trace" aria-labelledby="sync-trace-title">
          <div className="surface-heading">
            <div>
              <h3 id="sync-trace-title">Latest sync trace</h3>
              <span>{latestSyncRun ? `${latestSyncRun.status} / ${formatDateTime(latestSyncRun.startedAt)}` : "No run selected"}</span>
            </div>
            {latestSyncRun ? <span className={`sync-status ${latestSyncRun.status}`}>{latestSyncRun.status}</span> : null}
          </div>
          {syncRunError ? <SurfaceState icon={<CircleAlert size={17} />} title="Sync trace unavailable" detail={syncRunError} tone="error" /> : null}
          {initialLoading ? <SurfaceState icon={<Loader2 className="spin-icon" size={17} />} title="Loading sync trace" detail="Waiting for synchronization run history." /> : null}
          {!syncRunError && !initialLoading && !selectedConnection ? <SurfaceState icon={<Clock3 size={17} />} title="Select a connection" detail="The latest trace is scoped to the selected connector." /> : null}
          {!syncRunError && !initialLoading && selectedConnection && !latestSyncRun ? <SurfaceState icon={<Clock3 size={17} />} title="No synchronization run" detail="Run Sync to create an operator trace." /> : null}
          {!syncRunError && latestSyncRun ? <SyncTrace run={latestSyncRun} /> : null}
        </section>
      </div>
    </section>
  );
}

function NumberControl({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return (
    <label className="control-field">
      <span>{label}</span>
      <input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(event.currentTarget.valueAsNumber)} required />
    </label>
  );
}

function WriteModeControl({ value, onChange }: { value: SourceWriteMode; onChange: (value: SourceWriteMode) => void }) {
  return (
    <label className="control-field">
      <span>Write mode</span>
      <select value={value} onChange={(event) => onChange(event.target.value as SourceWriteMode)}>
        <option value="read_only">Read only</option>
        <option value="approval_required">Approval required</option>
        <option value="autonomous">Autonomous</option>
      </select>
    </label>
  );
}

function SurfaceState({ icon, title, detail, tone = "neutral" }: { icon: ReactNode; title: string; detail: string; tone?: "neutral" | "error" }) {
  return (
    <div className={`surface-empty-state ${tone}`} role={tone === "error" ? "alert" : "status"}>
      {icon}
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function ConnectorIcon({ kind }: { kind: SourceConnectionKind }) {
  if (kind === "sqlite") return <Database size={17} />;
  if (kind === "git") return <GitBranch size={17} />;
  return <FolderTree size={17} />;
}

function ResourceIcon({ resource }: { resource: SourceResource }) {
  if (["database", "table", "column", "dataset"].includes(resource.kind)) return <Database size={15} />;
  if (resource.kind === "semantic_contract") return <GitBranch size={15} />;
  return <File size={15} />;
}

function SyncTrace({ run }: { run: SourceSyncRun }) {
  const model = run.events
    .slice()
    .reverse()
    .map((event) => event.metadata.modelId ?? event.metadata.model)
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const runtimeLabel = run.provider === "local-huggingface"
    ? `Local Hugging Face / ${model ?? "model ID unavailable"}`
    : "Deterministic / no model invoked";
  return (
    <div className="sync-trace-content">
      <div className="sync-run-summary">
        <span><ServerCog size={13} />{runtimeLabel}</span>
        <span>{run.resourcesDiscovered} resources</span>
        <span>{run.assetsPublished} assets</span>
        <span>{run.proposalsCreated} proposals</span>
      </div>
      <div className="sync-event-list">
        {run.events.slice().sort((left, right) => left.step - right.step).map((event) => (
          <div className={`sync-event ${event.severity}`} key={event.id}>
            <span className="sync-event-step">{event.step}</span>
            <div>
              <div className="sync-event-title">
                <strong>{event.title}</strong>
                <span>{event.phase}</span>
              </div>
              <p>{event.detail}</p>
              <SafeEventMetadata event={event} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SafeEventMetadata({ event }: { event: SourceSyncEvent }) {
  const safeKeys = new Set(["provider", "model", "modelId", "proposals", "checkpoint"]);
  const entries = Object.entries(event.metadata).filter(([key]) => safeKeys.has(key));
  if (event.evidenceResourceIds.length > 0) entries.push(["evidence", `${event.evidenceResourceIds.length} resources`]);
  if (entries.length === 0) return null;
  return (
    <div className="sync-event-metadata">
      {entries.map(([key, value]) => (
        <span key={key} title={safeMetadataValue(value)}>{humanizePredicate(key)}: {safeMetadataValue(value)}</span>
      ))}
    </div>
  );
}

function connectionLocation(connection: SourceConnection): string {
  if (connection.config.kind === "filesystem") return connection.config.rootPath;
  if (connection.config.kind === "sqlite") return connection.config.databasePath;
  return connection.config.repositoryPath;
}

function writeModeLabel(connection: SourceConnection): string {
  if (connection.config.kind === "filesystem") return "Read only";
  return connection.config.writeMode.replaceAll("_", " ");
}

function writeCapability(connection: SourceConnection): string {
  if (connection.config.kind === "filesystem") return "Discovery and evidence ingest";
  if (connection.config.kind === "sqlite") {
    const count = connection.config.writeRules.length;
    return count === 0 ? "No bounded write rule" : `${count} bounded record rule${count === 1 ? "" : "s"}`;
  }
  const count = connection.config.semanticContractPaths.length;
  return count === 0 ? "No writable contract path" : `${count} semantic contract path${count === 1 ? "" : "s"}`;
}

function kindLabel(kind: SourceConnectionKind): string {
  if (kind === "sqlite") return "SQLite";
  if (kind === "git") return "Git";
  return "Filesystem";
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function shortId(value: string): string {
  return value.length > 20 ? `${value.slice(0, 9)}...${value.slice(-6)}` : value;
}

function humanizePredicate(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
}

function safeMetadataValue(value: unknown): string {
  if (typeof value === "string") return value.length > 100 ? `${value.slice(0, 97)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "unavailable";
  const serialized = JSON.stringify(value);
  return serialized.length > 100 ? `${serialized.slice(0, 97)}...` : serialized;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function noticeIcon(tone: NoticeTone) {
  if (tone === "success") return <CheckCircle2 size={16} />;
  if (tone === "error") return <CircleAlert size={16} />;
  if (tone === "warning") return <ShieldCheck size={16} />;
  return <Loader2 className="spin-icon" size={16} />;
}
