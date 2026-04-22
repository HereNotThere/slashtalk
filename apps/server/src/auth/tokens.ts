/** Generate a random API key (UUID v4) */
export function generateApiKey(): string {
  return crypto.randomUUID();
}

/** SHA-256 hash a token string (for storing hashed keys/tokens) */
export async function hashToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Encrypt a GitHub token using AES-256-GCM */
export async function encryptGithubToken(
  plaintext: string,
  encryptionKey: string
): Promise<string> {
  const keyBytes = hexToBytes(encryptionKey);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    "AES-GCM",
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );
  // Format: hex(iv):hex(ciphertext)
  return bytesToHex(iv) + ":" + bytesToHex(new Uint8Array(ciphertext));
}

/** Decrypt a GitHub token using AES-256-GCM */
export async function decryptGithubToken(
  encrypted: string,
  encryptionKey: string
): Promise<string> {
  const [ivHex, ciphertextHex] = encrypted.split(":");
  const keyBytes = hexToBytes(encryptionKey);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    "AES-GCM",
    false,
    ["decrypt"]
  );
  const ivBytes = hexToBytes(ivHex);
  const ctBytes = hexToBytes(ciphertextHex);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes.buffer as ArrayBuffer },
    key,
    ctBytes.buffer as ArrayBuffer
  );
  return new TextDecoder().decode(decrypted);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
