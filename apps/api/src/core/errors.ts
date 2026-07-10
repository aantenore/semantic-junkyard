export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 403 | 404 | 409 | 422 | 503 = 400,
    public readonly details?: unknown
  ) {
    super(message);
  }
}
