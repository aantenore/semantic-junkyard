export function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function decodeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
