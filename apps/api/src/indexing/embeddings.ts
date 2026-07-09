import { tokenize } from "../core/text.js";

export const VECTOR_DIMENSIONS = 128;

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function embedText(text: string): number[] {
  const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  for (const token of tokenize(text)) {
    const hash = hashToken(token);
    const index = hash % VECTOR_DIMENSIONS;
    const sign = hash % 2 === 0 ? 1 : -1;
    vector[index] += sign * (1 + Math.log(token.length));
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

export function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

