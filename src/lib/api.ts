export class ApiError extends Error {
  status: number;
  code?: string;
  retryAfterSeconds?: number;
  rateLimitSource?: string;
  quotaExhausted?: boolean;

  constructor(
    message: string,
    status: number,
    code?: string,
    meta?: { retryAfterSeconds?: number; rateLimitSource?: string; quotaExhausted?: boolean }
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = meta?.retryAfterSeconds;
    this.rateLimitSource = meta?.rateLimitSource;
    this.quotaExhausted = meta?.quotaExhausted;
  }
}

let memoryAuthToken: string | null = null;

export function setAuthToken(token: string | null): void {
  memoryAuthToken = token;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function resolveApiBase(
  raw: unknown,
  currentLocation: { protocol: string; hostname: string; origin: string } | undefined =
    typeof window !== 'undefined' ? window.location : undefined
): { baseUrl: string; configError?: string } {
  if (typeof raw !== 'string') return { baseUrl: '' };
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return { baseUrl: '' };

  const cleaned = trimmed.replace(/\/+$/, '').replace(/\/api$/i, '');
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return {
      baseUrl: '',
      configError: 'VITE_API_BASE_URL is malformed. Expected a full https:// or http:// backend URL.',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      baseUrl: '',
      configError: 'VITE_API_BASE_URL must use https:// or http://.',
    };
  }

  // Never allow a deployed production site on a public hostname to call localhost/127.0.0.1
  if (currentLocation && !isLocalHostname(currentLocation.hostname) && isLocalHostname(parsed.hostname)) {
    return { baseUrl: '' };
  }

  if (
    currentLocation &&
    currentLocation.protocol === 'https:' &&
    parsed.protocol === 'http:' &&
    !isLocalHostname(parsed.hostname)
  ) {
    return {
      baseUrl: '',
      configError: 'VITE_API_BASE_URL must use https:// when the website is served over HTTPS.',
    };
  }

  return { baseUrl: parsed.origin + parsed.pathname.replace(/\/+$/, '') };
}

function getApiBaseConfig(): { baseUrl: string; configError?: string } {
  return resolveApiBase(import.meta.env?.VITE_API_BASE_URL);
}

function looksLikeHtml(text: string, contentType: string): boolean {
  const lowerType = contentType.toLowerCase();
  if (lowerType.includes('text/html') || lowerType.includes('application/xhtml+xml')) {
    return true;
  }
  const head = text.trimStart().slice(0, 120);
  return /^(?:<!--[\s\S]*?-->\s*)?<(?:!doctype\s+html|html|head|body)\b/i.test(head);
}

function defaultCodeForStatus(status: number): string | undefined {
  if (status === 401) return 'AUTH_ERROR';
  if (status === 403) return 'FORBIDDEN_ERROR';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 503) return 'SERVICE_UNAVAILABLE';
  if (status === 504) return 'TIMEOUT_ERROR';
  if (status >= 500) return 'SERVER_ERROR';
  return undefined;
}

function parseRetryAfterHeader(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const num = Number(trimmed);
  if (Number.isFinite(num) && num > 0) return Math.ceil(num);
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const diffSec = Math.ceil((dateMs - Date.now()) / 1000);
    return diffSec > 0 ? diffSec : undefined;
  }
  return undefined;
}

function extractApiError(
  data: Record<string, unknown>,
  fallbackStatus: number,
  retryAfterHeader?: number
): {
  message: string;
  code?: string;
  retryAfterSeconds?: number;
  rateLimitSource?: string;
  quotaExhausted?: boolean;
} {
  const nestedError = data.error;
  const obj = nestedError && typeof nestedError === 'object' ? (nestedError as Record<string, unknown>) : undefined;

  const rawRetry =
    typeof obj?.retryAfterSeconds === 'number'
      ? obj.retryAfterSeconds
      : typeof data.retryAfterSeconds === 'number'
      ? data.retryAfterSeconds
      : retryAfterHeader;
  const retryAfterSeconds =
    typeof rawRetry === 'number' && Number.isFinite(rawRetry) && rawRetry > 0 ? Math.ceil(rawRetry) : undefined;

  const rateLimitSource =
    typeof obj?.rateLimitSource === 'string'
      ? obj.rateLimitSource
      : typeof data.rateLimitSource === 'string'
      ? data.rateLimitSource
      : undefined;

  const quotaExhausted =
    typeof obj?.quotaExhausted === 'boolean'
      ? obj.quotaExhausted
      : typeof data.quotaExhausted === 'boolean'
      ? data.quotaExhausted
      : undefined;

  if (obj) {
    const msg = typeof obj.message === 'string' && obj.message.trim() ? obj.message : undefined;
    const code =
      typeof obj.code === 'string'
        ? obj.code
        : typeof data.code === 'string'
        ? data.code
        : defaultCodeForStatus(fallbackStatus);
    if (msg) return { message: msg, code, retryAfterSeconds, rateLimitSource, quotaExhausted };
  }
  if (typeof nestedError === 'string' && nestedError.trim()) {
    return {
      message: nestedError,
      code: typeof data.code === 'string' ? data.code : defaultCodeForStatus(fallbackStatus),
      retryAfterSeconds,
      rateLimitSource,
      quotaExhausted,
    };
  }
  if (typeof data.message === 'string' && data.message.trim()) {
    return {
      message: data.message,
      code: typeof data.code === 'string' ? data.code : defaultCodeForStatus(fallbackStatus),
      retryAfterSeconds,
      rateLimitSource,
      quotaExhausted,
    };
  }
  return {
    message:
      fallbackStatus === 404
        ? 'The requested API route was not found on the backend server.'
        : `Request failed with status ${fallbackStatus}. Please try again.`,
    code: typeof data.code === 'string' ? data.code : defaultCodeForStatus(fallbackStatus),
    retryAfterSeconds,
    rateLimitSource,
    quotaExhausted,
  };
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const { baseUrl, configError } = getApiBaseConfig();
  if (configError) {
    throw new ApiError(configError, 0, 'INVALID_API_URL');
  }

  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    'X-Requested-With': 'BuddyElderAI',
  };
  if (memoryAuthToken) {
    headers['Authorization'] = `Bearer ${memoryAuthToken}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const targetUrl = baseUrl ? `${baseUrl}${normalizedPath}` : normalizedPath;
  const timeoutMs = options.timeoutMs ?? 35_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(targetUrl, {
      method,
      credentials: 'include',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(
        'The Buddy Elder AI server took too long to respond. Please tap Retry in a moment.',
        504,
        'TIMEOUT_ERROR'
      );
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new ApiError(
        'You appear to be offline. Please check your internet connection and try again.',
        0,
        'NETWORK_OFFLINE'
      );
    }
    const browserOrigin = typeof window !== 'undefined' ? window.location.origin : '';
    const isCrossOrigin = Boolean(baseUrl && (!browserOrigin || !baseUrl.startsWith(browserOrigin)));
    if (isCrossOrigin) {
      throw new ApiError(
        `Could not connect to the configured backend server (${baseUrl}). Verify that the backend is running, VITE_API_BASE_URL is correct, and ALLOWED_ORIGINS includes ${browserOrigin || 'this site origin'}.`,
        0,
        'CORS_OR_BACKEND_ERROR'
      );
    }
    throw new ApiError(
      'The Buddy Elder AI backend server is unavailable. Locally, run npm run dev (port 3000); in production, verify your /api backend deployment or VITE_API_BASE_URL.',
      0,
      'BACKEND_UNAVAILABLE'
    );
  } finally {
    clearTimeout(timer);
  }

  const contentType = res.headers.get('content-type') || '';
  const rawText = await res.text();
  const trimmed = rawText.trim();

  let data: Record<string, unknown> = {};
  let parsedJson = false;

  if (
    trimmed.length > 0 &&
    (contentType.toLowerCase().includes('application/json') || trimmed.startsWith('{') || trimmed.startsWith('['))
  ) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      } else {
        data = { value: parsed };
      }
      parsedJson = true;
    } catch {
      parsedJson = false;
    }
  }

  if (!parsedJson) {
    if (looksLikeHtml(rawText, contentType)) {
      throw new ApiError(
        `The backend API returned an HTML page instead of JSON (HTTP ${res.status || 502} on ${normalizedPath}). Locally, run npm run dev (port 3000); if frontend and backend are hosted separately, set VITE_API_BASE_URL to your live Express server URL.`,
        res.status || 502,
        'INVALID_RESPONSE'
      );
    }
    if (!res.ok) {
      throw new ApiError(
        trimmed || `Request failed with status ${res.status}.`,
        res.status,
        defaultCodeForStatus(res.status)
      );
    }
    if (res.status !== 204 && trimmed.length > 0) {
      throw new ApiError(
        'The server returned an unexpected response format. Please try again in a moment.',
        res.status || 502,
        'INVALID_RESPONSE'
      );
    }
  }

  if (!res.ok || data.success === false) {
    const headerRetry = parseRetryAfterHeader(res.headers.get('retry-after'));
    const errInfo = extractApiError(data, res.status || 500, headerRetry);
    throw new ApiError(errInfo.message, res.status || 500, errInfo.code, {
      retryAfterSeconds: errInfo.retryAfterSeconds,
      rateLimitSource: errInfo.rateLimitSource,
      quotaExhausted: errInfo.quotaExhausted,
    });
  }

  return data as T;
}
