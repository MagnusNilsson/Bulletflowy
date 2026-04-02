import { fetchTree, importOpml, exportOpml, importTxt, exportTxt } from './api.js';
import { state } from './state.js';
import { renderTree, setOnTreeChanged, zoomTo, collapseAll } from './tree-renderer.js';
import { initKeyboard } from './keyboard.js';
import { initActionBar } from './action-bar.js';
import { initTheme } from './theme.js';
import { checkAuth, setOnAuthenticated, logout, registerPasskey } from './auth.js';
import { showSaveError } from './save-indicator.js';
import './style.css';

async function loadTree(render = true) {
  try {
    const data = await fetchTree(state.showCompleted);
    state.root = data.root;
    if (render) renderTree();
  } catch (err: any) {
    showSaveError('Failed to load: ' + err.message);
  }
}

function buildAppUI() {
  const app = document.getElementById('app')!;
  // Clear auth screen if present
  while (app.firstChild) app.removeChild(app.firstChild);

  // Rebuild app structure
  const toolbar = document.createElement('header');
  toolbar.id = 'toolbar';

  const toolbarLeft = document.createElement('div');
  toolbarLeft.className = 'toolbar-left';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.id = 'search-input';
  searchInput.placeholder = 'Search or type / for commands...';
  searchInput.autocomplete = 'off';
  toolbarLeft.appendChild(searchInput);
  toolbar.appendChild(toolbarLeft);

  const toolbarRight = document.createElement('div');
  toolbarRight.className = 'toolbar-right';

  const showCompletedLabel = document.createElement('label');
  showCompletedLabel.className = 'toggle-completed';
  const showCompletedCheckbox = document.createElement('input');
  showCompletedCheckbox.type = 'checkbox';
  showCompletedCheckbox.id = 'show-completed';
  showCompletedLabel.appendChild(showCompletedCheckbox);
  showCompletedLabel.appendChild(document.createTextNode(' Show completed'));
  toolbarRight.appendChild(showCompletedLabel);

  const darkBtn = document.createElement('button');
  darkBtn.id = 'dark-mode-btn';
  darkBtn.title = 'Toggle dark mode';
  darkBtn.textContent = 'Dark';
  toolbarRight.appendChild(darkBtn);

  const importBtn = document.createElement('button');
  importBtn.id = 'import-btn';
  importBtn.title = 'Import OPML';
  importBtn.textContent = 'Import';
  toolbarRight.appendChild(importBtn);

  const exportBtn = document.createElement('button');
  exportBtn.id = 'export-btn';
  exportBtn.title = 'Export OPML';
  exportBtn.textContent = 'Export';
  toolbarRight.appendChild(exportBtn);

  const importFile = document.createElement('input');
  importFile.type = 'file';
  importFile.id = 'import-file';
  importFile.accept = '.opml,.txt';
  importFile.hidden = true;
  toolbarRight.appendChild(importFile);

  const passkeyBtn = document.createElement('button');
  passkeyBtn.id = 'passkey-btn';
  passkeyBtn.title = 'Add a passkey to your account';
  passkeyBtn.textContent = 'Add Passkey';
  toolbarRight.appendChild(passkeyBtn);

  const logoutBtn = document.createElement('button');
  logoutBtn.id = 'logout-btn';
  logoutBtn.textContent = 'Logout';
  toolbarRight.appendChild(logoutBtn);

  toolbar.appendChild(toolbarRight);
  app.appendChild(toolbar);

  const breadcrumbs = document.createElement('nav');
  breadcrumbs.id = 'breadcrumbs';
  app.appendChild(breadcrumbs);

  const searchResults = document.createElement('div');
  searchResults.id = 'search-results';
  searchResults.className = 'hidden';
  app.appendChild(searchResults);

  const treeContainer = document.createElement('div');
  treeContainer.id = 'tree-container';
  app.appendChild(treeContainer);

  const saveIndicator = document.createElement('div');
  saveIndicator.id = 'save-indicator';
  saveIndicator.className = 'hidden';
  saveIndicator.textContent = 'Saved';
  app.appendChild(saveIndicator);
}

function init() {
  buildAppUI();

  // Tree change callback (reload from server)
  const onTreeChanged = () => loadTree();
  setOnTreeChanged(onTreeChanged);

  // Keyboard
  initKeyboard();

  // Action bar (search + commands)
  initActionBar();

  // Show completed toggle
  const showCompletedEl = document.getElementById('show-completed') as HTMLInputElement;
  showCompletedEl.addEventListener('change', () => {
    state.showCompleted = showCompletedEl.checked;
    loadTree();
  });

  // Dark mode
  initTheme();

  // Passkey registration
  document.getElementById('passkey-btn')!.addEventListener('click', async () => {
    const ok = await registerPasskey();
    if (ok) alert('Passkey registered successfully!');
  });

  // Logout
  document.getElementById('logout-btn')!.addEventListener('click', () => logout());

  window.addEventListener('bulletflowy:reload', () => loadTree());

  // Import
  const importBtn = document.getElementById('import-btn')!;
  const importFile = document.getElementById('import-file') as HTMLInputElement;

  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    if (!file) return;

    const mode = confirm(
      'Replace existing data? OK = Replace, Cancel = Merge (add to existing)'
    )
      ? 'replace'
      : 'merge';

    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      const result = ext === 'txt'
        ? await importTxt(file, mode as 'replace' | 'merge')
        : await importOpml(file, mode as 'replace' | 'merge');
      alert(`Imported ${result.importedCount} nodes`);
      await loadTree(false);
      collapseAll();
    } catch (err: any) {
      showSaveError('Import failed: ' + err.message);
    }

    importFile.value = '';
  });

  // Export
  const exportBtn = document.getElementById('export-btn')!;
  exportBtn.addEventListener('click', () => {
    window.open(exportOpml(), '_blank');
  });

  // Restore zoom from URL hash
  const hash = window.location.hash.slice(1);
  if (hash) {
    state.zoomedNodeId = hash;
  }

  // Listen for hash changes
  window.addEventListener('hashchange', () => {
    const newHash = window.location.hash.slice(1);
    state.zoomedNodeId = newHash || null;
    renderTree();
  });

  // Initial load
  loadTree();
}

async function start() {
  setOnAuthenticated(() => init());
  const authenticated = await checkAuth();
  if (authenticated) init();
}

document.addEventListener('DOMContentLoaded', start);
