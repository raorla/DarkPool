import * as http from "http";
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Relayer du client furtif (P0.4).
 *
 * Reçoit des meta-transactions signées hors-chaîne par des adresses furtives et les
 * soumet on-chain en payant le gas. Les contrats vérifient eux-mêmes la signature,
 * le nonce et la preuve de handle : le relayer n'est qu'un transporteur sans pouvoir
 * (un digest altéré ou rejoué revert on-chain).
 *
 * Garde-fous :
 *  - cibles restreintes au vault et aux ConfidentialTokens whitelistés (le relayer
 *    n'est pas un robinet à gas universel) ;
 *  - estimation de gas préalable : une meta-tx invalide est rejetée en HTTP 400
 *    sans dépenser de gas.
 */

const PROVIDER_URL = process.env.SEPOLIA_PROVIDER_URL || "";
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY || "";
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "";
// Liste d'adresses de ConfidentialTokens séparées par des virgules (cWETH, cUSDC, ...)
const CTOKEN_ADDRESSES = (process.env.CTOKEN_ADDRESSES || "")
  .split(",")
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);
const PORT = Number(process.env.RELAYER_PORT || 8545 + 1000);

if (!PROVIDER_URL || !RELAYER_PRIVATE_KEY || !VAULT_ADDRESS) {
  console.error("Missing required environment variables (SEPOLIA_PROVIDER_URL, RELAYER_PRIVATE_KEY, VAULT_ADDRESS).");
  process.exit(1);
}

const VAULT_ABI = [
  "function depositConfidentialFor(address owner, address cToken, bytes32 amountExternal, bytes amountProof, uint256 nonce, bytes signature) external",
  "function withdrawConfidentialFor(address owner, address cToken, bytes32 amountExternal, bytes amountProof, uint256 nonce, bytes signature) external",
  "function submitOrderFor(address owner, address tokenIn, address tokenOut, bytes32 amountInExternal, bytes amountInProof, bytes32 minAmountOutExternal, bytes minAmountOutProof, uint256 nonce, bytes signature) external returns (uint256)",
];

const CTOKEN_ABI = [
  "function setOperatorWithSig(address holder, address operator, bool approved, uint256 nonce, bytes signature) external",
  "function transferEncryptedWithSig(address holder, address to, bytes32 amountExternal, bytes amountProof, uint256 nonce, bytes signature) external returns (bytes32)",
  "function requestUnwrapWithSig(address holder, uint256 amount, uint256 nonce, bytes signature) external returns (uint256)",
  "function finalizeUnwrap(uint256 requestId, bytes decryptionProof) external",
];

const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, relayerWallet);

function cTokenContract(address: string): ethers.Contract {
  if (!CTOKEN_ADDRESSES.includes(String(address).toLowerCase())) {
    throw new Error(`ConfidentialToken non whitelisté: ${address}`);
  }
  return new ethers.Contract(address, CTOKEN_ABI, relayerWallet);
}

/** Construit l'appel de contrat correspondant à l'action relayée. */
function buildCall(action: string, p: any): { contract: ethers.Contract; method: string; args: unknown[] } {
  switch (action) {
    case "setOperator":
      return {
        contract: cTokenContract(p.cToken),
        method: "setOperatorWithSig",
        args: [p.holder, p.operator, Boolean(p.approved), BigInt(p.nonce), p.signature],
      };
    case "transferEncrypted":
      return {
        contract: cTokenContract(p.cToken),
        method: "transferEncryptedWithSig",
        args: [p.holder, p.to, p.amountHandle, p.amountProof, BigInt(p.nonce), p.signature],
      };
    case "requestUnwrap":
      return {
        contract: cTokenContract(p.cToken),
        method: "requestUnwrapWithSig",
        args: [p.holder, BigInt(p.amount), BigInt(p.nonce), p.signature],
      };
    case "finalizeUnwrap":
      // Pas de signature : la preuve de décryption de la gateway KMS est auto-portante
      return {
        contract: cTokenContract(p.cToken),
        method: "finalizeUnwrap",
        args: [BigInt(p.requestId), p.decryptionProof],
      };
    case "depositConfidential":
      cTokenContract(p.cToken); // vérifie la whitelist
      return {
        contract: vault,
        method: "depositConfidentialFor",
        args: [p.owner, p.cToken, p.amountHandle, p.amountProof, BigInt(p.nonce), p.signature],
      };
    case "withdrawConfidential":
      cTokenContract(p.cToken);
      return {
        contract: vault,
        method: "withdrawConfidentialFor",
        args: [p.owner, p.cToken, p.amountHandle, p.amountProof, BigInt(p.nonce), p.signature],
      };
    case "submitOrder":
      return {
        contract: vault,
        method: "submitOrderFor",
        args: [
          p.owner, p.tokenIn, p.tokenOut,
          p.amountInHandle, p.amountInProof,
          p.minAmountOutHandle, p.minAmountOutProof,
          BigInt(p.nonce), p.signature,
        ],
      };
    default:
      throw new Error(`Action inconnue: ${action}`);
  }
}

async function handleRelay(body: any): Promise<{ txHash: string }> {
  const { action, params } = body || {};
  if (!action || !params) throw new Error("Corps attendu: { action, params }");

  const { contract, method, args } = buildCall(action, params);

  // Pré-validation gratuite : une signature/nonce/preuve invalide revert ici.
  await contract[method].estimateGas(...args);

  const tx = await contract[method](...args);
  console.log(`[RELAYER] ${action} -> ${tx.hash}`);
  await tx.wait();
  return { txHash: tx.hash };
}

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  // Le frontend (vite, autre origine) consomme le relayer directement depuis le navigateur
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.end(JSON.stringify({ ok: true, relayer: relayerWallet.address }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/relay") {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    try {
      const result = await handleRelay(JSON.parse(raw));
      res.end(JSON.stringify(result));
    } catch (error: any) {
      const message = (error?.shortMessage || error?.message || String(error)).slice(0, 300);
      console.error(`[RELAYER] Rejet: ${message}`);
      res.statusCode = 400;
      res.end(JSON.stringify({ error: message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[RELAYER] Adresse: ${relayerWallet.address}`);
  console.log(`[RELAYER] Vault:   ${VAULT_ADDRESS}`);
  console.log(`[RELAYER] cTokens: ${CTOKEN_ADDRESSES.join(", ") || "(aucun)"}`);
  console.log(`[RELAYER] En écoute sur http://localhost:${PORT}/relay`);
});
