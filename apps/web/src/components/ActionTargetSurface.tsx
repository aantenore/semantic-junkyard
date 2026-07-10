import { Braces, CheckCircle2, Database, GitBranch, HelpCircle, LockKeyhole, RefreshCw } from "lucide-react";
import type { BusinessActionTarget, ReflectionResult, SourceConnection, SourceWrite } from "@semantic-junkyard/shared";

interface ActionTargetSurfaceProps {
  target: BusinessActionTarget;
  connection?: SourceConnection;
  connectorIdentityUnavailable: boolean;
  write?: SourceWrite;
  reflection?: ReflectionResult;
}

export function ActionTargetSurface({ target, connection, connectorIdentityUnavailable, write, reflection }: ActionTargetSurfaceProps) {
  const identity = connectorIdentity(connectorIdentityUnavailable, connection);
  const status = reflection?.status ?? write?.status ?? target.status;
  const payload = write?.payload ?? {};
  const connectorPostcondition = stringValue(payload.connectorPostcondition) ?? plannedPostcondition(target);
  const postconditionPassed = typeof payload.externalPostconditionPassed === "boolean" ? payload.externalPostconditionPassed : null;
  const metadata = readbackMetadata(target, write, reflection);

  return (
    <article className="action-target">
      <div className="action-target-heading">
        <div className="action-target-identity">
          <TargetIcon connection={connection} legacy={!connectorIdentityUnavailable && !connection} />
          <div>
            <strong>{target.systemName}</strong>
            <small>{target.objectType}:{target.objectKey}</small>
          </div>
        </div>
        <span className={`target-origin ${identity.tone}`}>{identity.label}</span>
      </div>

      <div className="action-target-contract">
        <code>{target.technicalOperation}</code>
        <span>{target.capability}</span>
        <span>{target.risk} risk</span>
        <span>{target.autonomy.replaceAll("_", " ")}</span>
      </div>

      <p>{target.diff.summary}</p>

      <div className="action-readback-grid">
        <div>
          <span>Postcondition</span>
          <strong>{connectorPostcondition}</strong>
          <small>
            {write?.dryRun
              ? "Dry run: no external write was attempted."
              : postconditionPassed === null
                ? "Pending source execution and independent readback."
                : postconditionPassed
                  ? "External postcondition passed."
                  : "External postcondition failed."}
          </small>
        </div>
        <div>
          <span>Readback</span>
          <strong>{reflection?.summary ?? (write ? "Readback has not produced a reflection record." : "Not executed")}</strong>
          <small>{reflection ? `Observed ${formatDateTime(reflection.observedAt)}` : `${target.evidenceChunkIds.length} evidence chunks bound to plan`}</small>
        </div>
      </div>

      {metadata.length > 0 ? (
        <div className="action-readback-metadata" aria-label="Readback metadata">
          {metadata.map((item) => <span key={item}>{item}</span>)}
        </div>
      ) : null}

      <details className="target-diff">
        <summary>Exact planned diff</summary>
        <div>
          <section>
            <span>Before</span>
            <pre>{target.diff.before ?? "No prior value"}</pre>
          </section>
          <section>
            <span>After</span>
            <pre>{target.diff.after}</pre>
          </section>
        </div>
      </details>

      <span className={`target-status ${status}`}>
        {status === "verified" ? <CheckCircle2 size={12} /> : status === "executed" ? <RefreshCw size={12} /> : <LockKeyhole size={12} />}
        {status.replaceAll("_", " ")}
      </span>
    </article>
  );
}

function TargetIcon({ connection, legacy }: { connection?: SourceConnection; legacy: boolean }) {
  if (connection?.kind === "sqlite") return <Database size={17} />;
  if (connection?.kind === "git") return <GitBranch size={17} />;
  if (connection?.kind === "filesystem") return <Braces size={17} />;
  return legacy ? <Braces size={17} /> : <HelpCircle size={17} />;
}

function connectorIdentity(unavailable: boolean, connection?: SourceConnection): { label: string; tone: "real" | "legacy" | "unavailable" } {
  if (unavailable) return { label: "Registry identity unavailable", tone: "unavailable" };
  if (!connection) return { label: "Legacy local simulator", tone: "legacy" };
  const kind = connection.kind === "sqlite" ? "SQLite" : connection.kind === "git" ? "Git" : "Filesystem";
  return { label: `Real connector / ${kind}`, tone: "real" };
}

function plannedPostcondition(target: BusinessActionTarget): string {
  if (target.technicalOperation === "sqlite.record.update") {
    const updates = recordValue(target.parameters.updates);
    const fields = updates ? Object.keys(updates).join(", ") : "allowed fields";
    return `Read back exactly one source row and require exact equality for ${fields}.`;
  }
  if (target.technicalOperation === "git.semantic_contract.commit") {
    return "Read committed content and require the exact planned contract and metric fields.";
  }
  return "Reread the target record and require identity, version, operation, and diff hash equality.";
}

function readbackMetadata(target: BusinessActionTarget, write?: SourceWrite, reflection?: ReflectionResult): string[] {
  const result: string[] = [];
  const sourceVersion = stringValue(write?.payload.connectorSourceVersion);
  if (sourceVersion) result.push(`source version ${shortValue(sourceVersion)}`);

  const connectorMetadata = recordValue(write?.payload.connectorMetadata);
  if (connectorMetadata) {
    for (const key of ["readbackStatus", "table", "keyColumn", "verifiedColumns", "rowsChanged", "noOp", "sourceMutation", "commitSha", "blobSha", "exactContent", "fieldsPassed", "targetClean"]) {
      if (connectorMetadata[key] !== undefined) result.push(`${humanize(key)} ${shortValue(displayValue(connectorMetadata[key]))}`);
    }
  } else {
    for (const key of ["expectedSourceVersion", "expectedHeadSha", "expectedVersion", "relativePath", "keyColumn", "keyValue"]) {
      if (target.parameters[key] !== undefined) result.push(`${humanize(key)} ${shortValue(displayValue(target.parameters[key]))}`);
    }
  }
  if (reflection?.sourceRecordId) result.push(`reflection ${shortValue(reflection.sourceRecordId)}`);
  return result;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(displayValue).join(", ");
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function shortValue(value: string): string {
  return value.length > 48 ? `${value.slice(0, 22)}...${value.slice(-12)}` : value;
}

function humanize(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
