import { ethers } from "ethers";

/**
 * Client de Trading Furtif (P0.4).
 *
 * - Dérivation déterministe d'adresses jetables (stealth addresses) depuis le wallet
 *   principal : la clé furtive est récupérable à tout moment en re-signant le même
 *   message, elle n'est jamais stockée nulle part.
 * - Construction et signature des meta-transactions (EIP-191 sur un digest liant
 *   chainid + contrat + action + paramètres + nonce) consommées par le relayer :
 *   l'adresse furtive n'a JAMAIS besoin d'ETH et le wallet principal n'apparaît
 *   jamais on-chain côté trading.
 *
 * Combinaison P0.3 + P0.4 :
 *   wrap (public, wallet principal)
 *     -> transfert confidentiel cToken vers l'adresse furtive (montant masqué)
 *     -> dépôt / ordres / retraits relayés signés par l'adresse furtive (gasless)
 */

const STEALTH_DERIVATION_MESSAGE = (index: number) =>
  `DarkPool Nox — stealth key derivation v1 (index ${index})`;

/**
 * Dérive un wallet furtif déterministe : keccak256 de la signature du wallet principal.
 * ECDSA est déterministe (RFC 6979) — re-signer le même message redonne la même clé.
 */
export async function deriveStealthWallet(
  mainWallet: ethers.Signer,
  index = 0,
  provider?: ethers.Provider
): Promise<ethers.Wallet> {
  const signature = await mainWallet.signMessage(STEALTH_DERIVATION_MESSAGE(index));
  const privateKey = ethers.keccak256(ethers.getBytes(signature));
  return new ethers.Wallet(privateKey, provider);
}

// ─── Digests meta-tx (doivent refléter exactement l'abi.encode des contrats) ───

const coder = ethers.AbiCoder.defaultAbiCoder();

function digest(types: string[], values: unknown[]): string {
  return ethers.keccak256(coder.encode(types, values));
}

/** ConfidentialToken.setOperatorWithSig */
export function digestSetOperator(
  chainId: bigint, cToken: string, holder: string, operator: string, approved: boolean, nonce: bigint
): string {
  return digest(
    ["uint256", "address", "string", "address", "address", "bool", "uint256"],
    [chainId, cToken, "setOperator", holder, operator, approved, nonce]
  );
}

/** ConfidentialToken.transferEncryptedWithSig */
export function digestTransferEncrypted(
  chainId: bigint, cToken: string, holder: string, to: string, amountHandle: string, nonce: bigint
): string {
  return digest(
    ["uint256", "address", "string", "address", "address", "bytes32", "uint256"],
    [chainId, cToken, "transferEncrypted", holder, to, amountHandle, nonce]
  );
}

/** ConfidentialToken.requestUnwrapWithSig */
export function digestRequestUnwrap(
  chainId: bigint, cToken: string, holder: string, amount: bigint, nonce: bigint
): string {
  return digest(
    ["uint256", "address", "string", "address", "uint256", "uint256"],
    [chainId, cToken, "requestUnwrap", holder, amount, nonce]
  );
}

/** DarkPoolVault.depositConfidentialFor */
export function digestDepositConfidential(
  chainId: bigint, vault: string, owner: string, cToken: string, amountHandle: string, nonce: bigint
): string {
  return digest(
    ["uint256", "address", "string", "address", "address", "bytes32", "uint256"],
    [chainId, vault, "depositConfidential", owner, cToken, amountHandle, nonce]
  );
}

/** DarkPoolVault.withdrawConfidentialFor */
export function digestWithdrawConfidential(
  chainId: bigint, vault: string, owner: string, cToken: string, amountHandle: string, nonce: bigint
): string {
  return digest(
    ["uint256", "address", "string", "address", "address", "bytes32", "uint256"],
    [chainId, vault, "withdrawConfidential", owner, cToken, amountHandle, nonce]
  );
}

/** DarkPoolVault.submitOrderFor */
export function digestSubmitOrder(
  chainId: bigint, vault: string, owner: string, tokenIn: string, tokenOut: string,
  amountInHandle: string, minAmountOutHandle: string, nonce: bigint
): string {
  return digest(
    ["uint256", "address", "string", "address", "address", "address", "bytes32", "bytes32", "uint256"],
    [chainId, vault, "submitOrder", owner, tokenIn, tokenOut, amountInHandle, minAmountOutHandle, nonce]
  );
}

/** Signature EIP-191 d'un digest meta-tx. */
export async function signMetaDigest(wallet: ethers.Signer, digestHex: string): Promise<string> {
  return wallet.signMessage(ethers.getBytes(digestHex));
}

// ─── Client HTTP du relayer ────────────────────────────────────────────────

export type RelayAction =
  | "setOperator"
  | "transferEncrypted"
  | "requestUnwrap"
  | "finalizeUnwrap"
  | "depositConfidential"
  | "withdrawConfidential"
  | "submitOrder";

export interface RelayRequest {
  action: RelayAction;
  params: Record<string, unknown>;
}

export class RelayerClient {
  constructor(private readonly baseUrl: string) {}

  /** Envoie une meta-transaction signée au relayer, retourne le hash de transaction. */
  async relay(request: RelayRequest): Promise<{ txHash: string }> {
    const res = await fetch(`${this.baseUrl}/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    });
    const body: any = await res.json();
    if (!res.ok) {
      throw new Error(`Relayer error (${res.status}): ${body?.error || "unknown"}`);
    }
    return body;
  }
}
