const BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  'https://8xp3bsquj9x9pyjzc3jjbdm55jrnh76x.app.specular.dev';
const REQUEST_TIMEOUT_MS = 25000;

function withTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId),
  };
}

function formatApiError(path: string, status: number, text: string) {
  const body = String(text || '').trim();
  const fallback = body ? body.slice(0, 160) : 'No response body';
  return new Error(`API ${status} ${path}: ${fallback}`);
}

async function parseResponse<T>(path: string, res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    console.error(`[API ERROR] ${res.status} ${path}:`, text.slice(0, 300));
    throw formatApiError(path, res.status, text);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`API invalid JSON ${path}: ${text.slice(0, 160) || 'empty response'}`);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const { signal, clear } = withTimeoutSignal(REQUEST_TIMEOUT_MS);
  console.log(`[API GET] ${BASE_URL}${path}`);
  try {
    const res = await fetch(`${BASE_URL}${path}`, { signal });
    const data = await parseResponse<T>(path, res);
    console.log(`[API GET OK] ${path}`, data);
    return data;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`API timeout ${path} after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clear();
  }
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const { signal, clear } = withTimeoutSignal(REQUEST_TIMEOUT_MS);
  console.log(`[API POST] ${BASE_URL}${path}`, body);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const data = await parseResponse<T>(path, res);
    console.log(`[API POST OK] ${path}`, data);
    return data;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`API timeout ${path} after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clear();
  }
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const { signal, clear } = withTimeoutSignal(REQUEST_TIMEOUT_MS);
  console.log(`[API PUT] ${BASE_URL}${path}`, body);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const data = await parseResponse<T>(path, res);
    console.log(`[API PUT OK] ${path}`, data);
    return data;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`API timeout ${path} after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clear();
  }
}

export async function apiDelete<T>(path: string): Promise<T> {
  const { signal, clear } = withTimeoutSignal(REQUEST_TIMEOUT_MS);
  console.log(`[API DELETE] ${BASE_URL}${path}`);
  try {
    const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE', signal });
    const data = await parseResponse<T>(path, res);
    console.log(`[API DELETE OK] ${path}`, data);
    return data;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`API timeout ${path} after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clear();
  }
}
