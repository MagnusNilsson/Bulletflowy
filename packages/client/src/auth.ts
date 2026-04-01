import type { MeResponse, AuthResponse } from '@bulletflowy/shared';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

const BASE = '/api';

async function authRequest<T>(path: string, body?: unknown): Promise<T> {
  const options: RequestInit = { method: body ? 'POST' : 'GET' };
  if (body) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, options);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

let onAuthenticated: (() => void) | null = null;

export function setOnAuthenticated(cb: () => void) {
  onAuthenticated = cb;
}

export async function checkAuth(): Promise<boolean> {
  const data = await authRequest<MeResponse>('/auth/me');
  if (data.user) return true;
  showAuthScreen(data.setupRequired);
  return false;
}

export async function logout() {
  await authRequest('/auth/logout', {});
  showAuthScreen(false);
}

function showAuthScreen(setupRequired: boolean) {
  const app = document.getElementById('app')!;
  // Clear all children safely
  while (app.firstChild) app.removeChild(app.firstChild);

  const container = document.createElement('div');
  container.className = 'auth-container';

  const card = document.createElement('div');
  card.className = 'auth-card';

  const title = document.createElement('h1');
  title.textContent = 'Bulletflowy';
  card.appendChild(title);

  const subtitle = document.createElement('p');
  subtitle.className = 'auth-subtitle';
  subtitle.textContent = setupRequired ? 'Create your account to get started' : 'Sign in to continue';
  card.appendChild(subtitle);

  const errorEl = document.createElement('div');
  errorEl.className = 'auth-error hidden';
  card.appendChild(errorEl);

  function showError(msg: string) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  }

  const form = document.createElement('form');
  form.addEventListener('submit', e => e.preventDefault());

  const usernameInput = document.createElement('input');
  usernameInput.type = 'text';
  usernameInput.placeholder = 'Username';
  usernameInput.className = 'auth-input';
  usernameInput.autocomplete = 'username';
  usernameInput.required = true;
  form.appendChild(usernameInput);

  const passwordInput = document.createElement('input');
  passwordInput.type = 'password';
  passwordInput.placeholder = 'Password';
  passwordInput.className = 'auth-input';
  passwordInput.autocomplete = setupRequired ? 'new-password' : 'current-password';
  passwordInput.required = true;
  form.appendChild(passwordInput);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'auth-btn auth-btn-primary';
  submitBtn.textContent = setupRequired ? 'Create Account' : 'Sign In';
  form.appendChild(submitBtn);

  form.addEventListener('submit', async () => {
    errorEl.classList.add('hidden');
    submitBtn.disabled = true;
    try {
      const endpoint = setupRequired ? '/auth/register' : '/auth/login';
      await authRequest<AuthResponse>(endpoint, {
        username: usernameInput.value,
        password: passwordInput.value,
      });
      onAuthenticated?.();
    } catch (err: any) {
      showError(err.message);
    } finally {
      submitBtn.disabled = false;
    }
  });

  card.appendChild(form);

  // Passkey login button (only if not setup mode)
  if (!setupRequired) {
    const divider = document.createElement('div');
    divider.className = 'auth-divider';
    divider.textContent = 'or';
    card.appendChild(divider);

    const passkeyBtn = document.createElement('button');
    passkeyBtn.className = 'auth-btn auth-btn-secondary';
    passkeyBtn.textContent = 'Sign in with passkey';
    passkeyBtn.addEventListener('click', async () => {
      errorEl.classList.add('hidden');
      try {
        const options = await authRequest<any>('/auth/passkey/login-options', {});
        const credential = await startAuthentication({ optionsJSON: options });
        await authRequest<AuthResponse>('/auth/passkey/login-verify', credential);
        onAuthenticated?.();
      } catch (err: any) {
        showError(err.message);
      }
    });
    card.appendChild(passkeyBtn);
  }

  container.appendChild(card);
  app.appendChild(container);
  usernameInput.focus();
}

export async function registerPasskey(): Promise<boolean> {
  try {
    const options = await authRequest<any>('/auth/passkey/register-options', {});
    const credential = await startRegistration({ optionsJSON: options });
    await authRequest('/auth/passkey/register-verify', credential);
    return true;
  } catch (err: any) {
    alert('Passkey registration failed: ' + err.message);
    return false;
  }
}
