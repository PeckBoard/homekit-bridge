/** Error codes from BRIDGE_API.md, with the HTTP status each maps to. */
export const ERROR_STATUS = {
  unauthorized: 401,
  bad_request: 400,
  not_found: 404,
  not_paired: 404,
  already_paired: 409,
  pair_failed: 502,
  bad_setup_code: 400,
  unreachable: 502,
  read_only: 400,
  invalid_value: 400,
  timeout: 504,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class ApiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

/** Network-level failures (refused, unreachable, reset) → `unreachable`. */
export function isNetworkError(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return (
    typeof code === "string" &&
    /^(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EADDRNOTAVAIL)$/.test(code)
  );
}

/** Races `p` against a timeout. hap-controller never rejects a request whose
 * socket dies mid-flight, so every accessory call goes through this. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApiError("timeout", `${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
