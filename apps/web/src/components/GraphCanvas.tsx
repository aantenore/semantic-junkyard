import type { GraphSnapshot } from "@semantic-junkyard/shared";

interface GraphCanvasProps {
  graph: GraphSnapshot;
}

const palette = ["#0f8a83", "#b56b00", "#2d6cdf", "#6b7280", "#0f766e", "#9a3412"];

export function GraphCanvas({ graph }: GraphCanvasProps) {
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
  const visibleEdges = graph.edges.filter((edge) => positions.has(edge.source) && positions.has(edge.target)).slice(0, 24);

  return (
    <svg className="graph-canvas" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Knowledge graph preview">
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="#9aa7b5" />
        </marker>
      </defs>
      {visibleEdges.map((edge) => {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) return null;
        return (
          <g key={edge.id}>
            <line x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke="#c8d1dc" strokeWidth="1.4" markerEnd="url(#arrow)" />
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
          <g key={node.id} transform={`translate(${position.x - w / 2} ${position.y - 23})`}>
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
  );
}
