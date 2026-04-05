import type {
  TreeResponse,
  NodeRecord,
  CreateNodeBody,
  UpdateNodeBody,
  MoveNodeBody,
  DeleteResponse,
  SearchResponse,
} from '@bulletflowy/shared';

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    if (res.status === 401) {
      // Session expired — reload to show login
      window.location.reload();
      throw new Error('Session expired');
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function fetchTree(includeCompleted: boolean): Promise<TreeResponse> {
  return request(`/tree?includeCompleted=${includeCompleted}`);
}

export function createNode(body: CreateNodeBody): Promise<NodeRecord> {
  return request('/nodes', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function updateNode(id: string, body: UpdateNodeBody): Promise<NodeRecord> {
  return request(`/nodes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function splitNode(id: string, textBefore: string, textAfter: string, newId?: string): Promise<{ original: NodeRecord; created: NodeRecord }> {
  return request(`/nodes/${id}/split`, {
    method: 'POST',
    body: JSON.stringify({ textBefore, textAfter, newId }),
  });
}

export function deleteNode(id: string): Promise<DeleteResponse> {
  return request(`/nodes/${id}`, { method: 'DELETE' });
}

export function moveNode(id: string, body: MoveNodeBody): Promise<NodeRecord> {
  return request(`/nodes/${id}/move`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function searchNodes(q: string, includeCompleted: boolean): Promise<SearchResponse> {
  return request(`/search?q=${encodeURIComponent(q)}&includeCompleted=${includeCompleted}`);
}

export async function importOpml(file: File, mode: 'replace' | 'merge'): Promise<{ importedCount: number }> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${BASE}/import/opml?mode=${mode}`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function exportOpml(): string {
  return `${BASE}/export/opml`;
}

export async function importTxt(file: File, mode: 'replace' | 'merge'): Promise<{ importedCount: number }> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${BASE}/import/txt?mode=${mode}`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function exportTxt(): string {
  return `${BASE}/export/txt`;
}
