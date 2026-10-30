/**
 * The subset of Express's request/response objects the handlers use.
 */
interface ApiRequest {
  query: Record<string, unknown>;
}

interface ApiResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  send(body: unknown): unknown;
}

export type ApiHandler = (
  req: ApiRequest,
  res: ApiResponse,
) => void | Promise<void>;
