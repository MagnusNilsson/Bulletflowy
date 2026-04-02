export interface NodeRecord {
  id: string;
  parentId: string | null;
  position: string;
  text: string;
  description: string | null;
  status: 'active' | 'completed';
  createdAt: string;
  updatedAt: string;
}

export interface TreeNode {
  id: string;
  text: string;
  description: string | null;
  status: 'active' | 'completed';
  children: TreeNode[];
}

export interface TreeResponse {
  root: TreeNode;
}

export interface CreateNodeBody {
  id?: string;
  parentId: string;
  text: string;
  description?: string | null;
  position?: string;
  afterId?: string;
  beforeId?: string;
}

export interface SplitNodeBody {
  textBefore: string;
  textAfter: string;
  newId?: string;
}

export interface UpdateNodeBody {
  text?: string;
  description?: string | null;
  parentId?: string;
  position?: string;
  afterId?: string;
  beforeId?: string;
  status?: 'active' | 'completed';
}

export interface MoveNodeBody {
  direction: 'up' | 'down' | 'indent' | 'outdent';
}

export interface DeleteResponse {
  deletedCount: number;
}

export interface SearchResult {
  id: string;
  text: string;
  description: string | null;
  status: 'active' | 'completed';
  breadcrumbs: { id: string; text: string }[];
}

export interface SearchResponse {
  results: SearchResult[];
}

// Auth types

export interface User {
  id: string;
  username: string;
  createdAt: string;
}

export interface AuthResponse {
  user: User;
}

export interface MeResponse {
  user: User | null;
  setupRequired: boolean;
}
