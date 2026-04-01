import type Database from 'better-sqlite3';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';

// In-memory challenge store (ephemeral, 5-minute TTL)
const challenges = new Map<string, { challenge: string; expiresAt: number }>();

function storeChallenge(key: string, challenge: string): void {
  challenges.set(key, { challenge, expiresAt: Date.now() + 5 * 60 * 1000 });
}

function consumeChallenge(key: string): string | null {
  const entry = challenges.get(key);
  challenges.delete(key);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.challenge;
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of challenges) {
    if (entry.expiresAt < now) challenges.delete(key);
  }
}, 60 * 1000);

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  backed_up: number;
}

function getRpConfig() {
  const rpID = process.env.RP_ID ?? 'localhost';
  const rpName = process.env.RP_NAME ?? 'Bulletflowy';
  const origin = process.env.ORIGIN ?? `http://${rpID}:3001`;
  return { rpID, rpName, origin };
}

export async function getRegistrationOptions(
  db: Database.Database,
  userId: string,
  username: string
) {
  const { rpID, rpName } = getRpConfig();

  const existingPasskeys = db.prepare(
    'SELECT id, transports FROM passkeys WHERE user_id = ?'
  ).all(userId) as { id: string; transports: string | null }[];

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: username,
    userID: new TextEncoder().encode(userId),
    attestationType: 'none',
    excludeCredentials: existingPasskeys.map(p => ({
      id: p.id,
      transports: p.transports ? JSON.parse(p.transports) : undefined,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  storeChallenge(`reg:${userId}`, options.challenge);
  return options;
}

export async function verifyRegistration(
  db: Database.Database,
  userId: string,
  response: RegistrationResponseJSON
) {
  const { rpID, origin } = getRpConfig();
  const expectedChallenge = consumeChallenge(`reg:${userId}`);
  if (!expectedChallenge) throw new Error('Challenge expired or missing');

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Passkey registration failed');
  }

  const { credential, credentialBackedUp } = verification.registrationInfo;

  db.prepare(
    'INSERT INTO passkeys (id, user_id, public_key, counter, transports, backed_up) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    credential.id,
    userId,
    Buffer.from(credential.publicKey),
    credential.counter,
    credential.transports ? JSON.stringify(credential.transports) : null,
    credentialBackedUp ? 1 : 0
  );

  return { verified: true };
}

export async function getAuthenticationOptions(db: Database.Database) {
  const { rpID } = getRpConfig();

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
  });

  // Key by challenge itself since we don't know the user yet
  storeChallenge(`auth:${options.challenge}`, options.challenge);
  return options;
}

export async function verifyAuthentication(
  db: Database.Database,
  response: AuthenticationResponseJSON
) {
  const { rpID, origin } = getRpConfig();

  const credentialId = response.id;
  const passkey = db.prepare(
    'SELECT * FROM passkeys WHERE id = ?'
  ).get(credentialId) as PasskeyRow | undefined;

  if (!passkey) throw new Error('Passkey not found');

  // Find the challenge — try the response's challenge
  const clientData = JSON.parse(
    Buffer.from(response.response.clientDataJSON, 'base64url').toString()
  );
  const expectedChallenge = consumeChallenge(`auth:${clientData.challenge}`);
  if (!expectedChallenge) throw new Error('Challenge expired or missing');

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: passkey.id,
      publicKey: new Uint8Array(passkey.public_key),
      counter: passkey.counter,
      transports: passkey.transports
        ? (JSON.parse(passkey.transports) as AuthenticatorTransportFuture[])
        : undefined,
    },
  });

  if (!verification.verified) throw new Error('Passkey authentication failed');

  // Update counter
  db.prepare('UPDATE passkeys SET counter = ? WHERE id = ?')
    .run(verification.authenticationInfo.newCounter, credentialId);

  return { verified: true, userId: passkey.user_id };
}
