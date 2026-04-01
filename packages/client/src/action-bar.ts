import { searchNodes } from './api.js';
import { zoomTo } from './tree-renderer.js';
import { setDark, setLight } from './theme.js';
import type { SearchResult } from '@bulletflowy/shared';

// ── Command registry ──

interface Command {
  name: string;
  description: string;
  execute: () => void;
}

const commands: Command[] = [
  {
    name: '/shortcuts',
    description: 'Show keyboard shortcuts',
    execute: showShortcutsModal,
  },
  {
    name: '/delete-all',
    description: 'Delete all nodes (keep root)',
    execute: async () => {
      await fetch('/api/nodes', { method: 'DELETE' });
      window.dispatchEvent(new CustomEvent('bulletflowy:reload'));
    },
  },
  {
    name: '/export',
    description: 'Export as OPML',
    execute: () => {
      window.open('/api/export/opml', '_blank');
    },
  },
  {
    name: '/export-txt',
    description: 'Export as plain text',
    execute: () => {
      window.open('/api/export/txt', '_blank');
    },
  },
  {
    name: '/import',
    description: 'Import OPML or TXT file',
    execute: () => {
      (document.getElementById('import-file') as HTMLInputElement).click();
    },
  },
  {
    name: '/dark',
    description: 'Switch to dark mode',
    execute: setDark,
  },
  {
    name: '/light',
    description: 'Switch to light mode',
    execute: setLight,
  },
];

// ── State ──

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let selectedIndex = 0;

// ── Init ──

export function initActionBar() {
  const input = document.getElementById('search-input') as HTMLInputElement;
  const resultsEl = document.getElementById('search-results')!;

  input.placeholder = 'Search or type / for commands...';

  input.addEventListener('input', () => onInput(input, resultsEl));
  input.addEventListener('keydown', (e) => onKeyDown(e, input, resultsEl));
  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('#search-input') &&
        !(e.target as HTMLElement).closest('#search-results')) {
      hideResults(resultsEl);
    }
  });
}

export function focusActionBar() {
  const input = document.getElementById('search-input') as HTMLInputElement;
  input.focus();
  input.select();
}

// ── Input handling ──

function onInput(input: HTMLInputElement, resultsEl: HTMLElement) {
  const raw = input.value;

  if (debounceTimer) clearTimeout(debounceTimer);

  if (!raw.trim()) {
    hideResults(resultsEl);
    return;
  }

  if (raw.startsWith('/')) {
    // Command mode — show matching commands immediately
    showCommandSuggestions(raw, resultsEl);
    return;
  }

  // Search mode — debounced
  debounceTimer = setTimeout(async () => {
    try {
      const response = await searchNodes(raw.trim());
      renderSearchResults(response.results, resultsEl, input);
    } catch {
      // ignore
    }
  }, 200);
}

function onKeyDown(e: KeyboardEvent, input: HTMLInputElement, resultsEl: HTMLElement) {
  const items = resultsEl.querySelectorAll('.action-bar-item');
  if (items.length === 0 && e.key !== 'Tab') return;

  const raw = input.value;

  // Tab: autocomplete command
  if (e.key === 'Tab' && raw.startsWith('/') && items.length > 0) {
    e.preventDefault();
    const match = getSelectedCommand(resultsEl);
    if (match) {
      input.value = match;
      showCommandSuggestions(match, resultsEl);
    }
    return;
  }

  // Arrow navigation in dropdown
  if (e.key === 'ArrowDown' && items.length > 0) {
    e.preventDefault();
    selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
    highlightItem(items);
    return;
  }

  if (e.key === 'ArrowUp' && items.length > 0) {
    e.preventDefault();
    selectedIndex = Math.max(selectedIndex - 1, 0);
    highlightItem(items);
    return;
  }

  // Enter: execute command or navigate to search result
  if (e.key === 'Enter' && items.length > 0) {
    e.preventDefault();
    const active = resultsEl.querySelector('.action-bar-item.active') as HTMLElement | null;
    active?.click();
    return;
  }
}

// ── Command suggestions ──

function showCommandSuggestions(raw: string, resultsEl: HTMLElement) {
  const query = raw.toLowerCase();
  const matches = commands.filter(c => c.name.startsWith(query));

  while (resultsEl.firstChild) resultsEl.removeChild(resultsEl.firstChild);

  if (matches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'action-bar-item';
    empty.textContent = 'No matching commands';
    resultsEl.appendChild(empty);
  } else {
    selectedIndex = 0;
    for (let i = 0; i < matches.length; i++) {
      const cmd = matches[i];
      const el = document.createElement('div');
      el.className = 'action-bar-item' + (i === 0 ? ' active' : '');
      el.dataset.command = cmd.name;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'action-bar-cmd-name';
      nameSpan.textContent = cmd.name;
      el.appendChild(nameSpan);

      const descSpan = document.createElement('span');
      descSpan.className = 'action-bar-cmd-desc';
      descSpan.textContent = cmd.description;
      el.appendChild(descSpan);

      el.addEventListener('click', () => {
        const input = document.getElementById('search-input') as HTMLInputElement;
        input.value = '';
        hideResults(resultsEl);
        cmd.execute();
      });

      resultsEl.appendChild(el);
    }
  }

  resultsEl.classList.remove('hidden');
  document.getElementById('tree-container')!.style.display = '';
}

function getSelectedCommand(resultsEl: HTMLElement): string | null {
  const active = resultsEl.querySelector('.action-bar-item.active') as HTMLElement | null;
  return active?.dataset.command ?? null;
}

function highlightItem(items: NodeListOf<Element>) {
  items.forEach((el, i) => {
    el.classList.toggle('active', i === selectedIndex);
  });
}

// ── Search results ──

function renderSearchResults(results: SearchResult[], container: HTMLElement, input: HTMLInputElement) {
  while (container.firstChild) container.removeChild(container.firstChild);

  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'action-bar-item';
    empty.textContent = 'No results found';
    container.appendChild(empty);
  } else {
    selectedIndex = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const el = document.createElement('div');
      el.className = 'action-bar-item' + (i === 0 ? ' active' : '');

      const textDiv = document.createElement('div');
      textDiv.className = 'action-bar-result-text';
      textDiv.textContent = result.text;
      el.appendChild(textDiv);

      if (result.breadcrumbs.length > 0) {
        const crumbDiv = document.createElement('div');
        crumbDiv.className = 'action-bar-result-breadcrumb';
        crumbDiv.textContent = result.breadcrumbs.map(b => b.text).join(' > ');
        el.appendChild(crumbDiv);
      }

      el.addEventListener('click', () => {
        input.value = '';
        hideResults(container);
        zoomTo(result.id);
      });

      container.appendChild(el);
    }
  }

  container.classList.remove('hidden');
  document.getElementById('tree-container')!.style.display = 'none';
}

// ── Utilities ──

function hideResults(resultsEl: HTMLElement) {
  resultsEl.classList.add('hidden');
  while (resultsEl.firstChild) resultsEl.removeChild(resultsEl.firstChild);
  document.getElementById('tree-container')!.style.display = '';
}

// ── Shortcuts modal ──

const SHORTCUTS = [
  ['Cmd+K / Ctrl+K', 'Focus action bar'],
  ['Escape', 'Close action bar & return to last node'],
  ['Enter', 'Create new sibling node'],
  ['Tab', 'Indent node'],
  ['Shift+Tab', 'Outdent node'],
  ['\u2191 / \u2193', 'Move focus up / down'],
  ['Alt+\u2191 / Alt+\u2193', 'Move node up / down'],
  ['Cmd+\u2191 / Ctrl+\u2191', 'Go to first node'],
  ['Cmd+\u2193 / Ctrl+\u2193', 'Go to last node'],
  ['Cmd+Enter / Ctrl+Enter', 'Toggle complete'],
  ['Cmd+. / Ctrl+.', 'Collapse / expand current'],
  ['Cmd+Shift+. / Ctrl+Shift+.', 'Collapse all'],
  ['Cmd+Shift+, / Ctrl+Shift+,', 'Expand all'],
  ['Backspace (empty)', 'Delete node'],
];

function showShortcutsModal() {
  // Remove existing
  document.getElementById('shortcuts-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'shortcuts-modal';
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const title = document.createElement('h2');
  title.textContent = 'Keyboard Shortcuts';
  modal.appendChild(title);

  const table = document.createElement('table');
  table.className = 'shortcuts-table';

  for (const [key, desc] of SHORTCUTS) {
    const tr = document.createElement('tr');

    const tdKey = document.createElement('td');
    tdKey.className = 'shortcut-key';
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    tdKey.appendChild(kbd);
    tr.appendChild(tdKey);

    const tdDesc = document.createElement('td');
    tdDesc.className = 'shortcut-desc';
    tdDesc.textContent = desc;
    tr.appendChild(tdDesc);

    table.appendChild(tr);
  }

  modal.appendChild(table);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => overlay.remove());
  modal.appendChild(closeBtn);

  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', handler);
    }
  });

  document.body.appendChild(overlay);
}
