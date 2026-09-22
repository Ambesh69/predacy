import type { Hex } from "viem";

export interface PrivateNoteRecord {
  commitment: Hex;
  assetId: Hex;
  amount: string;
  publicKey: Hex;
  secret: Hex;
  leafIndex?: string;
  marketId?: Hex;
  side?: "YES" | "NO";
  positionTokenId?: string;
  state: "pending" | "spendable" | "locked" | "spent";
  createdAt: number;
}

export interface PrivateOrderRecord {
  orderCommitment: Hex;
  receiptToken: Hex;
  inputNote: Hex;
  deposit: string;
  limitPrice: string;
  marketId: Hex;
  positionTokenId: string;
  collateralAsset: Hex;
  positionAsset: Hex;
  orderSecret: Hex;
  orderLeafIndex: string;
  refundSecret: Hex;
  refundPublicKey: Hex;
  positionSecret: Hex;
  positionPublicKey: Hex;
  state: "funding" | "funded" | "locking" | "locked" | "queued" | "batched" | "settled" | "cancelled";
  spent?: string;
  shares?: string;
  refund?: string;
  refundWithdrawn?: boolean;
  positionWithdrawn?: boolean;
  createdAt: number;
}

interface EncryptedNoteVault {
  version: 1;
  wallet: string;
  iv: string;
  ciphertext: string;
}

interface PrivateVaultBackup {
  version: 2;
  notes: string | null;
  orders: string | null;
  exportedAt: number;
}

const STORAGE_KEY = "predacy_private_notes_v13";
const ORDER_STORAGE_KEY = "predacy_private_orders_v13";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function storageKey(base: string, wallet: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("Invalid private vault wallet");
  return `${base}:${wallet.toLowerCase()}`;
}

function storedValue(base: string, wallet: string): string | null {
  const current = localStorage.getItem(storageKey(base, wallet));
  if (current) return current;
  const legacy = localStorage.getItem(base);
  // Read the old single-wallet vault without deleting it or exposing it to another wallet.
  return legacy && JSON.parse(legacy).wallet === wallet.toLowerCase() ? legacy : null;
}

async function withVaultLock<T>(wallet: string, action: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    throw new Error("Private vault writes require browser Web Locks support");
  }
  return navigator.locks.request(storageKey("predacy_private_vault_write_v13", wallet), action);
}

function mergeNotes(existing: PrivateNoteRecord[], incoming: PrivateNoteRecord[]): PrivateNoteRecord[] {
  const merged = new Map(existing.map((note) => [note.commitment.toLowerCase(), note]));
  const rank = { pending: 0, spendable: 1, locked: 2, spent: 3 };
  for (const note of incoming) {
    const prior = merged.get(note.commitment.toLowerCase());
    if (prior && ["assetId", "amount", "publicKey", "secret"].some((key) =>
      String(prior[key as keyof PrivateNoteRecord]).toLowerCase() !== String(note[key as keyof PrivateNoteRecord]).toLowerCase())) {
      throw new Error("Conflicting recovery data for the same private note");
    }
    merged.set(note.commitment.toLowerCase(), prior ? { ...prior, ...note,
      leafIndex: note.leafIndex ?? prior.leafIndex,
      state: rank[prior.state] > rank[note.state] ? prior.state : note.state } : note);
  }
  return [...merged.values()];
}

function mergeOrders(existing: PrivateOrderRecord[], incoming: PrivateOrderRecord[]): PrivateOrderRecord[] {
  const merged = new Map(existing.map((order) => [order.orderCommitment.toLowerCase(), order]));
  const rank = { funding: 0, funded: 1, locking: 2, locked: 3, queued: 4, batched: 5, settled: 6, cancelled: 6 };
  const immutable: Array<keyof PrivateOrderRecord> = ["receiptToken", "inputNote", "deposit", "limitPrice", "marketId",
    "positionTokenId", "collateralAsset", "positionAsset", "orderSecret", "refundSecret", "refundPublicKey",
    "positionSecret", "positionPublicKey"];
  for (const order of incoming) {
    const prior = merged.get(order.orderCommitment.toLowerCase());
    if (prior && immutable.some((key) => String(prior[key]).toLowerCase() !== String(order[key]).toLowerCase())) {
      throw new Error("Conflicting recovery data for the same private order");
    }
    const latest = prior && rank[prior.state] > rank[order.state] ? prior : order;
    merged.set(order.orderCommitment.toLowerCase(), prior ? { ...prior, ...latest,
      refundWithdrawn: prior.refundWithdrawn || order.refundWithdrawn,
      positionWithdrawn: prior.positionWithdrawn || order.positionWithdrawn } : order);
  }
  return [...merged.values()];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64ToBuffer(value: string): ArrayBuffer {
  const bytes = base64ToBytes(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function vaultKey(wallet: string, signature: Hex): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(
    `Predacy private note vault v1\n${wallet.toLowerCase()}\n${signature.toLowerCase()}`,
  ));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function validateNotes(notes: PrivateNoteRecord[]): void {
  const bytes32 = /^0x[0-9a-fA-F]{64}$/;
  if (!Array.isArray(notes) || notes.some((note) => !bytes32.test(note.commitment) ||
      !bytes32.test(note.assetId) || !bytes32.test(note.publicKey) || !bytes32.test(note.secret) ||
      !/^\d+$/.test(note.amount) || (note.positionTokenId !== undefined && !/^\d+$/.test(note.positionTokenId)) ||
      !["pending", "spendable", "locked", "spent"].includes(note.state) ||
      Number(note.amount) < 0 || !Number.isSafeInteger(note.createdAt))) {
    throw new Error("Private note vault contains invalid data");
  }
}

function validateOrders(orders: PrivateOrderRecord[]): void {
  const bytes32 = /^0x[0-9a-fA-F]{64}$/;
  const decimal = /^\d+$/;
  if (!Array.isArray(orders) || orders.some((order) =>
    !bytes32.test(order.orderCommitment) || !bytes32.test(order.receiptToken) ||
    !bytes32.test(order.inputNote) || !bytes32.test(order.marketId) || !bytes32.test(order.collateralAsset) ||
    !bytes32.test(order.positionAsset) || !bytes32.test(order.orderSecret) ||
    !bytes32.test(order.refundSecret) || !bytes32.test(order.refundPublicKey) ||
    !bytes32.test(order.positionSecret) || !bytes32.test(order.positionPublicKey) ||
    !decimal.test(order.deposit) || !decimal.test(order.limitPrice) || !decimal.test(order.positionTokenId) ||
    !decimal.test(order.orderLeafIndex) ||
    !["funding", "funded", "locking", "locked", "queued", "batched", "settled", "cancelled"].includes(order.state) ||
    (order.spent !== undefined && !decimal.test(order.spent)) ||
    (order.shares !== undefined && !decimal.test(order.shares)) ||
    (order.refund !== undefined && !decimal.test(order.refund)) || !Number.isSafeInteger(order.createdAt))) {
    throw new Error("Private order vault contains invalid data");
  }
}

async function encryptPrivateValue(wallet: string, signature: Hex, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await vaultKey(wallet, signature);
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM", iv, additionalData: encoder.encode(wallet.toLowerCase()),
  }, key, encoder.encode(JSON.stringify(value)));
  return JSON.stringify({
    version: 1, wallet: wallet.toLowerCase(), iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  } satisfies EncryptedNoteVault);
}

async function decryptPrivateValue<T>(wallet: string, signature: Hex, encodedVault: string): Promise<T> {
  const vault = JSON.parse(encodedVault) as EncryptedNoteVault;
  if (vault.version !== 1 || vault.wallet !== wallet.toLowerCase() || !vault.iv || !vault.ciphertext) {
    throw new Error("Private backup belongs to a different wallet or version");
  }
  const key = await vaultKey(wallet, signature);
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM", iv: base64ToBuffer(vault.iv), additionalData: encoder.encode(wallet.toLowerCase()),
  }, key, base64ToBuffer(vault.ciphertext));
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export async function encryptPrivateNotes(
  wallet: string,
  signature: Hex,
  notes: PrivateNoteRecord[],
): Promise<string> {
  validateNotes(notes);
  return encryptPrivateValue(wallet, signature, notes);
}

export async function decryptPrivateNotes(
  wallet: string,
  signature: Hex,
  encodedVault: string,
): Promise<PrivateNoteRecord[]> {
  const notes = await decryptPrivateValue<PrivateNoteRecord[]>(wallet, signature, encodedVault);
  validateNotes(notes);
  return notes;
}

export async function savePrivateNotes(wallet: string, signature: Hex, notes: PrivateNoteRecord[]): Promise<void> {
  if (typeof window === "undefined") throw new Error("Private notes are available only in the wallet client");
  validateNotes(notes);
  await withVaultLock(wallet, async () => {
    const merged = mergeNotes(await loadPrivateNotes(wallet, signature), notes);
    localStorage.setItem(storageKey(STORAGE_KEY, wallet), await encryptPrivateNotes(wallet, signature, merged));
  });
}

export async function loadPrivateNotes(wallet: string, signature: Hex): Promise<PrivateNoteRecord[]> {
  if (typeof window === "undefined") return [];
  const stored = storedValue(STORAGE_KEY, wallet);
  return stored ? decryptPrivateNotes(wallet, signature, stored) : [];
}

export function exportPrivateNoteBackup(wallet: string): string | null {
  return typeof window === "undefined" ? null : storedValue(STORAGE_KEY, wallet);
}

export async function importPrivateNoteBackup(wallet: string, signature: Hex, backup: string): Promise<number> {
  const notes = await decryptPrivateNotes(wallet, signature, backup);
  await savePrivateNotes(wallet, signature, notes);
  return notes.length;
}

export function exportPrivateVaultBackup(wallet: string): string | null {
  if (typeof window === "undefined") return null;
  const notes = storedValue(STORAGE_KEY, wallet);
  const orders = storedValue(ORDER_STORAGE_KEY, wallet);
  if (!notes && !orders) return null;
  return JSON.stringify({ version: 2, notes, orders, exportedAt: Date.now() } satisfies PrivateVaultBackup);
}

export async function importPrivateVaultBackup(
  wallet: string,
  signature: Hex,
  backup: string,
): Promise<{ notes: number; orders: number }> {
  if (typeof window === "undefined") throw new Error("Private vault backups are available only in the wallet client");
  const parsed = JSON.parse(backup) as Partial<PrivateVaultBackup>;
  if (parsed.version !== 2 || (typeof parsed.notes !== "string" && parsed.notes !== null) ||
      (typeof parsed.orders !== "string" && parsed.orders !== null)) {
    throw new Error("Private vault backup has an unsupported format");
  }
  const notes = parsed.notes ? await decryptPrivateNotes(wallet, signature, parsed.notes) : [];
  const orders = parsed.orders
    ? await decryptPrivateValue<PrivateOrderRecord[]>(wallet, signature, parsed.orders)
    : [];
  validateOrders(orders);
  await withVaultLock(wallet, async () => {
    const mergedNotes = mergeNotes(await loadPrivateNotes(wallet, signature), notes);
    const mergedOrders = mergeOrders(await loadPrivateOrders(wallet, signature), orders);
    // Validate and encrypt both sets before changing storage; never delete newer secrets on import.
    const encryptedNotes = await encryptPrivateNotes(wallet, signature, mergedNotes);
    const encryptedOrders = await encryptPrivateValue(wallet, signature, mergedOrders);
    localStorage.setItem(storageKey(STORAGE_KEY, wallet), encryptedNotes);
    localStorage.setItem(storageKey(ORDER_STORAGE_KEY, wallet), encryptedOrders);
  });
  return { notes: notes.length, orders: orders.length };
}

export async function loadPrivateOrders(wallet: string, signature: Hex): Promise<PrivateOrderRecord[]> {
  if (typeof window === "undefined") return [];
  const stored = storedValue(ORDER_STORAGE_KEY, wallet);
  if (!stored) return [];
  const orders = await decryptPrivateValue<PrivateOrderRecord[]>(wallet, signature, stored);
  validateOrders(orders);
  return orders;
}

export async function savePrivateOrders(
  wallet: string,
  signature: Hex,
  orders: PrivateOrderRecord[],
): Promise<void> {
  if (typeof window === "undefined") throw new Error("Private orders are available only in the wallet client");
  validateOrders(orders);
  await withVaultLock(wallet, async () => {
    const merged = mergeOrders(await loadPrivateOrders(wallet, signature), orders);
    localStorage.setItem(storageKey(ORDER_STORAGE_KEY, wallet), await encryptPrivateValue(wallet, signature, merged));
  });
}
