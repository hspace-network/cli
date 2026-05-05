const DEFAULT_TIMEOUT_MS = 10_000;

interface ErrorBody {
  error?: string;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      throw new HttpError("Request to node timed out.", 0);
    }
    throw new HttpError("Could not reach node. Is it online?", 0);
  }
  clearTimeout(timer);

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* response had no body */
  }

  if (!res.ok) {
    const body = (payload ?? {}) as ErrorBody;
    throw new HttpError(body.error ?? `Node responded with ${res.status}.`, res.status);
  }

  return payload as T;
}

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
