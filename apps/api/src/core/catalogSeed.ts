import type { CatalogSnapshot } from "@semantic-junkyard/shared";

export const defaultCatalogSnapshot: CatalogSnapshot = {
  assets: [
    {
      id: "asset_customer_events",
      kind: "dataset",
      name: "customer_events",
      domain: "growth",
      owner: "data-platform",
      description: "Event stream for account signup, activation, subscription, and retention analysis.",
      sensitivity: "confidential",
      freshness: "fresh",
      qualityScore: 0.89,
      uri: "warehouse://growth/customer_events",
      metadata: { sourceSystem: "warehouse", pii: true, osiCompatible: true }
    },
    {
      id: "asset_billing_pipeline",
      kind: "pipeline",
      name: "billing_pipeline",
      domain: "finance",
      owner: "finance-data",
      description: "Pipeline that transforms invoices, payments, retries, and failed payment events.",
      sensitivity: "internal",
      freshness: "fresh",
      qualityScore: 0.82,
      uri: "dagster://finance/billing_pipeline",
      metadata: { openLineage: true }
    },
    {
      id: "asset_revenue_mart",
      kind: "table",
      name: "revenue_mart",
      domain: "finance",
      owner: "analytics-engineering",
      description: "Curated revenue model used by finance dashboards and metric definitions.",
      sensitivity: "confidential",
      freshness: "aging",
      qualityScore: 0.76,
      uri: "warehouse://finance/revenue_mart",
      metadata: { dbtModel: "mart_revenue" }
    },
    {
      id: "asset_semantic_contract_finance",
      kind: "semantic_contract",
      name: "finance_semantic_contract",
      domain: "finance",
      owner: "finance-data",
      description: "Versioned finance domain contract for metrics, dimensions, allowed joins, and policies.",
      sensitivity: "internal",
      freshness: "fresh",
      qualityScore: 0.93,
      uri: "osi://finance/v1.0.0",
      metadata: { standard: "Open Semantic Interchange style" }
    }
  ],
  metrics: [
    {
      id: "metric_net_revenue",
      name: "net_revenue",
      label: "Net Revenue",
      description: "Recognized revenue after refunds, discounts, credits, and failed payment reversals.",
      expression: "sum(invoice_amount - refunds - credits)",
      dimensions: ["billing_period", "plan", "region", "customer_segment"],
      owner: "finance-data",
      domain: "finance",
      contractVersion: "1.0.0",
      metadata: { metricFlowCompatible: true }
    },
    {
      id: "metric_failed_payment_rate",
      name: "failed_payment_rate",
      label: "Failed Payment Rate",
      description: "Ratio of failed payment attempts to all payment attempts in the billing pipeline.",
      expression: "failed_payment_attempts / payment_attempts",
      dimensions: ["payment_provider", "plan", "retry_policy"],
      owner: "finance-data",
      domain: "finance",
      contractVersion: "1.0.0",
      metadata: { qualityGuardrail: "requires retry_policy dimension" }
    }
  ],
  policies: [
    {
      id: "policy_mask_pii",
      name: "Mask personal identifiers",
      effect: "mask",
      appliesTo: ["email", "phone", "address", "customer_id"],
      condition: "actor.clearance < confidential",
      rationale: "Agents should not expose direct identifiers unless the actor has confidential clearance.",
      metadata: { policyEngine: "local-abac" }
    },
    {
      id: "policy_deny_secrets",
      name: "Deny secrets and credentials",
      effect: "deny",
      appliesTo: ["api_key", "secret", "password", "token"],
      condition: "always",
      rationale: "Secrets are never returned through semantic retrieval.",
      metadata: { policyEngine: "local-abac" }
    }
  ],
  lineage: [
    {
      id: "lineage_billing_to_revenue",
      fromAssetId: "asset_billing_pipeline",
      toAssetId: "asset_revenue_mart",
      type: "WRITES",
      confidence: 0.91,
      metadata: { source: "OpenLineage-compatible seed" }
    },
    {
      id: "lineage_contract_governs_revenue",
      fromAssetId: "asset_semantic_contract_finance",
      toAssetId: "asset_revenue_mart",
      type: "GOVERNS",
      confidence: 0.95,
      metadata: { source: "semantic contract" }
    }
  ],
  ontologyClasses: [
    {
      id: "ontology_asset",
      label: "Data Asset",
      description: "A governed technical or knowledge asset that an agent may discover.",
      parentId: null,
      constraints: ["must have owner", "must have sensitivity", "must expose freshness"]
    },
    {
      id: "ontology_metric",
      label: "Metric",
      description: "A governed business measure with expression, dimensions, and contract version.",
      parentId: "ontology_asset",
      constraints: ["must have expression", "must have owner", "must have contractVersion"]
    },
    {
      id: "ontology_evidence",
      label: "Evidence",
      description: "Source-spanned artifact that grounds an entity, relation, claim, or answer.",
      parentId: null,
      constraints: ["must have sourceId", "must have span or URI", "must have extractor version"]
    }
  ],
  contracts: [
    {
      id: "contract_finance_v1",
      name: "Finance Semantic Contract",
      version: "1.0.0",
      domain: "finance",
      status: "active",
      assets: [],
      metrics: [],
      policies: [],
      ontologyClasses: [],
      metadata: {
        format: "semantic-junkyard",
        interchangeTarget: "Open Semantic Interchange JSON/YAML"
      }
    }
  ]
};
