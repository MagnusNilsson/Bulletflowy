let hideTimeout: ReturnType<typeof setTimeout> | null = null;

const el = () => document.getElementById('save-indicator')!;

export function showSaved() {
  const indicator = el();
  indicator.textContent = 'Saved';
  indicator.classList.remove('hidden', 'error');
  if (hideTimeout) clearTimeout(hideTimeout);
  hideTimeout = setTimeout(() => {
    indicator.classList.add('hidden');
  }, 1500);
}

export function showSaveError(msg: string) {
  const indicator = el();
  indicator.textContent = msg;
  indicator.classList.remove('hidden');
  indicator.classList.add('error');
  if (hideTimeout) clearTimeout(hideTimeout);
  hideTimeout = setTimeout(() => {
    indicator.classList.add('hidden');
  }, 4000);
}
