export class TinyAgentError extends Error {
  public readonly details?: unknown;

  constructor(
    public readonly code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "TinyAgentError";
    this.details = details;
  }
}
