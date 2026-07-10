import { SourceSystemSchema, type SourceSystem } from "@semantic-junkyard/shared";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const SourceSystemsSchema = z.array(SourceSystemSchema).min(1).superRefine((systems, context) => {
  const systemIds = new Set<string>();
  const capabilityIds = new Set<string>();
  systems.forEach((system, systemIndex) => {
    if (systemIds.has(system.id)) {
      context.addIssue({ code: "custom", path: [systemIndex, "id"], message: "Source system IDs must be unique." });
    }
    systemIds.add(system.id);
    system.capabilities.forEach((capability, capabilityIndex) => {
      if (capability.systemId !== system.id) {
        context.addIssue({
          code: "custom",
          path: [systemIndex, "capabilities", capabilityIndex, "systemId"],
          message: "Capability systemId must match its containing source system."
        });
      }
      if (capabilityIds.has(capability.id)) {
        context.addIssue({ code: "custom", path: [systemIndex, "capabilities", capabilityIndex, "id"], message: "Capability IDs must be unique." });
      }
      capabilityIds.add(capability.id);
    });
  });
});

export const defaultSourceSystems: SourceSystem[] = [
  {
    id: "source.data-catalog",
    name: "Data Catalog",
    kind: "catalog",
    description: "Governed catalog adapter for business descriptions, metric definitions, tags, and ownership metadata.",
    capabilities: [
      {
        id: "catalog.update_metric_definition",
        systemId: "source.data-catalog",
        label: "Update metric definition",
        businessCapability: "metric.align_definition",
        technicalOperation: "catalog.metric.upsert_description",
        risk: "low",
        autonomous: true,
        requiresApproval: false,
        reversible: true,
        description: "Writes a governed metric description and supporting semantic evidence into the catalog source."
      },
      {
        id: "catalog.update_asset_description",
        systemId: "source.data-catalog",
        label: "Update asset context",
        businessCapability: "asset.annotate_context",
        technicalOperation: "catalog.asset.upsert_description",
        risk: "low",
        autonomous: true,
        requiresApproval: false,
        reversible: true,
        description: "Writes business context on a catalog asset without changing source data."
      }
    ]
  },
  {
    id: "source.openmetadata",
    name: "OpenMetadata Mirror",
    kind: "metadata-api",
    description: "Metadata API adapter shape for lineage and semantic relationship publication.",
    capabilities: [
      {
        id: "openmetadata.publish_lineage",
        systemId: "source.openmetadata",
        label: "Publish lineage edge",
        businessCapability: "lineage.publish_dependency",
        technicalOperation: "openmetadata.lineage.upsert_edge",
        risk: "medium",
        autonomous: true,
        requiresApproval: false,
        reversible: true,
        description: "Publishes a reversible metadata lineage edge that can be reread as source truth."
      }
    ]
  },
  {
    id: "source.dbt-repo",
    name: "dbt Semantic Repository",
    kind: "git",
    description: "Git-backed semantic model adapter that creates reviewable contract and test proposals.",
    capabilities: [
      {
        id: "dbt.create_contract_pr",
        systemId: "source.dbt-repo",
        label: "Create dbt contract PR",
        businessCapability: "contract.propose_change",
        technicalOperation: "git.pull_request.create",
        risk: "medium",
        autonomous: true,
        requiresApproval: false,
        reversible: true,
        description: "Creates a source-side pull request proposal instead of silently changing production models."
      }
    ]
  },
  {
    id: "source.ticketing",
    name: "Governance Ticketing",
    kind: "ticketing",
    description: "Ticketing adapter for owner review, approval, and business accountability.",
    capabilities: [
      {
        id: "ticketing.create_owner_review",
        systemId: "source.ticketing",
        label: "Create owner review task",
        businessCapability: "governance.request_owner_review",
        technicalOperation: "ticket.create",
        risk: "low",
        autonomous: true,
        requiresApproval: false,
        reversible: true,
        description: "Creates an owner review task with evidence, target systems, and verification state."
      }
    ]
  }
];

export function loadSourceSystems(configPath?: string): SourceSystem[] {
  const candidate = configPath?.trim();
  if (!candidate) return structuredClone(SourceSystemsSchema.parse(defaultSourceSystems));

  const resolvedPath = path.resolve(candidate);
  const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as unknown;
  return structuredClone(SourceSystemsSchema.parse(parsed));
}
