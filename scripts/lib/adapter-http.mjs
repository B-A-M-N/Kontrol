// Bounded JSON admission for the shipped HTTP adapters. Authentication is
// performed by each route before this helper is called for protected bodies.
export const ADAPTER_HTTP_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

export function truncateUtf8Tail(value, maxBytes) {
  const text = String(value ?? "");
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) return text;
  let start = Math.max(0, encoded.byteLength - maxBytes);
  while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

export class AdapterHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AdapterHttpError";
    this.status = status;
    this.code = code;
  }
}

export async function readJsonBody(req, limitBytes = ADAPTER_HTTP_BODY_LIMIT_BYTES) {
  const rawLength = req.headers["content-length"];
  const contentLength = rawLength === undefined ? undefined : Number(Array.isArray(rawLength) ? rawLength[0] : rawLength);
  if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
    throw new AdapterHttpError(400, "invalid_content_length", "Invalid Content-Length");
  }
  if (contentLength !== undefined && contentLength > limitBytes) {
    req.resume();
    throw new AdapterHttpError(413, "request_too_large", "Request body is too large");
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > limitBytes) {
      req.resume();
      throw new AdapterHttpError(413, "request_too_large", "Request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AdapterHttpError(400, "invalid_json", "Malformed JSON request body");
  }
}

export function writeAdapterError(res, error) {
  const status = error?.status ?? 500;
  const code = error?.code ?? "internal_error";
  const message = error?.message ?? "Internal server error";
  res.writeHead(status, { "Content-Type": "application/json", Connection: status === 413 ? "close" : "keep-alive" });
  res.end(JSON.stringify({ error: { code, message } }));
}
