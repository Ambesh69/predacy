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
  state: "locked" | "queued" | "batched" | "settled" | "cancelled";
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
  localStorage.setItem(STORAGE_KEY, await encryptPrivateNotes(wallet, signature, notes));
}

export async function loadPrivateNotes(wallet: string, signature: Hex): Promise<PrivateNoteRecord[]> {
  if (typeof window === "undefined") return [];
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored ? decryptPrivateNotes(wallet, signature, stored) : [];
}

export function exportPrivateNoteBackup(): string | null {
  return typeof window === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
}

export async function importPrivateNoteBackup(wallet: string, signature: Hex, backup: string): Promise<number> {
  const notes = await decryptPrivateNotes(wallet, signature, backup);
  localStorage.setItem(STORAGE_KEY, backup);
  return notes.length;
}

export function exportPrivateVaultBackup(): string | null {
  if (typeof window === "undefined") return null;
  const notes = localStorage.getItem(STORAGE_KEY);
  const orders = localStorage.getItem(ORDER_STORAGE_KEY);
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
  if (parsed.notes) localStorage.setItem(STORAGE_KEY, parsed.notes);
  else localStorage.removeItem(STORAGE_KEY);
  if (parsed.orders) localStorage.setItem(ORDER_STORAGE_KEY, parsed.orders);
  else localStorage.removeItem(ORDER_STORAGE_KEY);
  return { notes: notes.length, orders: orders.length };
}

export async function loadPrivateOrders(wallet: string, signature: Hex): Promise<PrivateOrderRecord[]> {
  if (typeof window === "undefined") return [];
  const stored = localStorage.getItem(ORDER_STORAGE_KEY);
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
  localStorage.setItem(ORDER_STORAGE_KEY, await encryptPrivateValue(wallet, signature, orders));
}
