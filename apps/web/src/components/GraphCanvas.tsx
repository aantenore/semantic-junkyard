import { useMemo, useState, type KeyboardEvent } from "react";
import type { GraphSnapshot } from "@semantic-junkyard/shared";

interface GraphCanvasProps {
  graph: GraphSnapshot;
}

const palette = ["#0f8a83", "#b56b00", "#2d6cdf", "#6b7280", "#0f766e", "#9a3412"];

export function GraphCanvas({ graph }: GraphCanvasProps) {
  const [filter, setFilter] = useState<"all" | "authoritative" | "accepted" | "proposed">("all");
  const [selection, setSelection] = useState<{ kind: "node" | "edge"; id: string } | null>(null);
  const nodes = graph.nodes.slice(0, 16);
  const width = 520;
  const height = 300;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = 105;
  const positions = new Map(
    nodes.map((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(nodes.length, 1) - Math.PI / 2;
      const localRadius = index === 0 ? 0 : radius + (index % 3) * 20;
      return [
        node.id,
        {
          x: index === 0 ? centerX : centerX + Math.cos(angle) * localRadius,
          y: index === 0 ? centerY : centerY + Math.sin(angle) * localRadius,
          color: palette[index % palette.length]
        }
      ];
    })
  );
  const visibleEdges = graph.edges
    .filter((edge) => positions.has(edge.source) && positions.has(edge.target))
    .filter((edge) => {
      if (filter === "all") return true;
      if (filter === "authoritative") return edge.authoritative === true;
      if (filter === "proposed") return edge.lifecycle === "proposed";
      return edge.authoritative !== true && edge.lifecycle !== "proposed";
    })
    .slice(0, 24);
  const selectedNode = useMemo(
    () => (selection?.kind === "node" ? graph.nodes.find((node) => node.id === selection.id) ?? null : null),
    [graph.nodes, selection]
  );
  const selectedEdge = useMemo(
    () => (selection?.kind === "edge" ? graph.edges.find((edge) => edge.id === selection.id) ?? null : null),
    [graph.edges, selection]
  );

  const selectFromKeyboard = (event: KeyboardEvent<SVGGElement>, kind: "node" | "edge", id: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setSelection({ kind, id });
  };

  return (
    <div className="graph-explorer">
      <div className="graph-legend" role="group" aria-label="Relation authority filter">
        {(["all", "authoritative", "accepted", "proposed"] as const).map((item) => (
          <button type="button" key={item} className={filter === item ? "selected" : ""} aria-pressed={filter === item} onClick={() => setFilter(item)}>
            <span className={`graph-legend-swatch ${item}`} />
            {item}
          </button>
        ))}
      </div>
      <svg className="graph-canvas" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Interactive knowledge graph preview">
        <defs>
          {(["authoritative", "accepted", "proposed"] as const).map((status) => (
            <marker key={status} id={`arrow-${status}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" className={`edge-arrow ${status}`} />
            </marker>
          ))}
        </defs>
        {visibleEdges.map((edge) => {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (!source || !target) return null;
          const status = edge.authoritative ? "authoritative" : edge.lifecycle === "proposed" ? "proposed" : "accepted";
          return (
            <g
              className={`graph-edge ${status} ${selection?.kind === "edge" && selection.id === edge.id ? "selected" : ""}`}
              key={edge.id}
              role="button"
              tabIndex={0}
              aria-label={`${edge.label.replaceAll("_", " ")} relation, ${status}, confidence ${Math.round(edge.confidence * 100)} percent`}
              onClick={() => setSelection({ kind: "edge", id: edge.id })}
              onKeyDown={(event) => selectFromKeyboard(event, "edge", edge.id)}
            >
              <line className="edge-hit-target" x1={source.x} y1={source.y} x2={target.x} y2={target.y} />
              <line className="edge-line" x1={source.x} y1={source.y} x2={target.x} y2={target.y} markerEnd={`url(#arrow-${status})`} />
              <text x={(source.x + target.x) / 2} y={(source.y + target.y) / 2 - 5} textAnchor="middle" className="edge-label">
                {edge.label.replaceAll("_", " ").toLowerCase()}
              </text>
            </g>
          );
        })}
        {nodes.map((node, index) => {
          const position = positions.get(node.id);
          if (!position) return null;
          const w = Math.min(132, Math.max(76, node.label.length * 7 + 22));
          return (
            <g
              className={selection?.kind === "node" && selection.id === node.id ? "graph-node selected" : "graph-node"}
              key={node.id}
              transform={`translate(${position.x - w / 2} ${position.y - 23})`}
              role="button"
              tabIndex={0}
              aria-label={`${node.label}, ${node.type}, confidence ${Math.round(node.confidence * 100)} percent`}
              onClick={() => setSelection({ kind: "node", id: node.id })}
              onKeyDown={(event) => selectFromKeyboard(event, "node", node.id)}
            >
              <rect width={w} height="46" rx="8" fill={index === 0 ? "#e8fbf8" : "#ffffff"} stroke={position.color} strokeWidth="1.4" />
              <text x={w / 2} y="19" textAnchor="middle" className="node-label">
                {node.label.length > 18 ? `${node.label.slice(0, 16)}…` : node.label}
              </text>
              <text x={w / 2} y="34" textAnchor="middle" className="node-type">
                {node.type}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="graph-selection" aria-live="polite">
        {selectedEdge ? (
          <><strong>{selectedEdge.label.replaceAll("_", " ")}</strong><span>{selectedEdge.authoritative ? "authoritative source fact" : selectedEdge.lifecycle ?? "accepted"} / {Math.round(selectedEdge.confidence * 100)}% confidence</span><code>{selectedEdge.evidenceChunkId ?? "no evidence chunk"}</code></>
        ) : selectedNode ? (
          <><strong>{selectedNode.label}</strong><span>{selectedNode.type} / degree {selectedNode.degree} / {Math.round(selectedNode.confidence * 100)}% confidence</span><code>{selectedNode.id}</code></>
        ) : (
          <><strong>Authority-aware graph</strong><span>Select a node or relation to inspect its confidence, lifecycle, and evidence identity.</span></>
        )}
      </div>
    </div>
  );
}
