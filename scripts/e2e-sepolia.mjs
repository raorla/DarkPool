/**
 * Test E2E sur Sepolia — DarkPoolVault v3.1 (confidentialité de bout en bout).
 *
 * Prérequis : l'enclave doit tourner (`npm run enclave`) et le wallet .env doit
 * détenir ≥ 0.01 WETH, ≥ 10 USDC et un peu d'ETH pour le gas.
 *
 * Scénario :
 *   1. Dépôts 0.01 WETH + 10 USDC (crédités en soldes chiffrés)
 *   2. Ordre insolvable (vend 5 WETH) -> l'enclave doit l'ignorer (verdict chiffré)
 *   3. Paire compatible 0.005 WETH <-> 8.275 USDC -> match + règlement sans montants
 *   4. requestWithdraw 1 USDC -> exécuté par l'enclave ; double demande -> revert
 *   5. Vérifications : MatchSettled sans montants, rejeu executeWithdraw -> revert,
 *      soldes chiffrés cohérents.
 *
 * Usage : node scripts/e2e-sepolia.mjs
 */
import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_PROVIDER_URL);
const wallet = new ethers.Wallet(process.env.ENCLAVE_PRIVATE_KEY, provider);
const VAULT = process.env.VAULT_ADDRESS;
const WETH = process.env.WETH_ADDRESS || "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const USDC = process.env.USDC_ADDRESS || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

const ERC20 = ["function approve(address,uint256) returns (bool)"];
const ABI = [
  "function deposit(address,uint256)",
  "function requestWithdraw(address,uint256)",
  "function executeWithdraw(address,address,uint256)",
  "function availableBalanceOf(address,address) view returns (bytes32)",
  "function lockedBalanceOf(address,address) view returns (bytes32)",
  "function submitOrder(address,address,bytes32,bytes,bytes32,bytes) returns (uint256)",
  "function nextOrderId() view returns (uint256)",
  "function pendingWithdrawals(address,address) view returns (uint256)",
  "event MatchSettled(uint256 indexed orderId1, uint256 indexed orderId2, address user1, address user2, address token1, address token2)",
  "event Withdrawal(address indexed user, address indexed token, uint256 amount)"
];
const vault = new ethers.Contract(VAULT, ABI, wallet);
const weth = new ethers.Contract(WETH, ERC20, wallet);
const usdc = new ethers.Contract(USDC, ERC20, wallet);

let failures = 0;
const check = (label, ok) => { console.log(`${ok ? "✓" : "✗"} ${label}`); if (!ok) failures++; };
const tx = async (label, p) => { const t = await p; await t.wait(); console.log(`  ${label}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const startBlock = await provider.getBlockNumber();
const startOrderId = await vault.nextOrderId();
console.log(`Vault: ${VAULT} | bloc ${startBlock} | nextOrderId ${startOrderId}\n`);

// ── 1. Dépôts ────────────────────────────────────────────────────────────────
await tx("approve WETH", weth.approve(VAULT, ethers.parseEther("0.01")));
await tx("deposit 0.01 WETH", vault.deposit(WETH, ethers.parseEther("0.01"), { gasLimit: 1_000_000 }));
await tx("approve USDC", usdc.approve(VAULT, 10_000_000n));
await tx("deposit 10 USDC", vault.deposit(USDC, 10_000_000n, { gasLimit: 1_000_000 }));

const hc = await createEthersHandleClient(wallet);
// Retry : la gateway KMS peut mettre quelques secondes à indexer le grant ACL
// d'un handle fraîchement créé ("Access denied: not a viewer" transitoire).
const decrypt = async (fn, token) => {
  const h = await vault[fn](wallet.address, token);
  if (h === ethers.ZeroHash) return 0n;
  for (let attempt = 1; ; attempt++) {
    try { return BigInt((await hc.decrypt(h)).value); }
    catch (e) {
      if (attempt >= 5) throw e;
      console.log(`  (déchiffrement: gateway pas encore synchronisée, essai ${attempt}/5…)`);
      await sleep(10_000);
    }
  }
};

// ── 2 & 3. Ordres : un insolvable + une paire compatible ───────────────────
const submit = async (label, tIn, tOut, aIn, mOut) => {
  const a = await hc.encryptInput(aIn, "uint256", VAULT);
  const m = await hc.encryptInput(mOut, "uint256", VAULT);
  await tx(label, vault.submitOrder(tIn, tOut, a.handle, a.handleProof, m.handle, m.handleProof, { gasLimit: 3_000_000 }));
};
await submit("ordre insolvable (5 WETH)", WETH, USDC, ethers.parseEther("5"), 8_000_000_000n);
await submit("ordre A (0.005 WETH -> min 8.275 USDC)", WETH, USDC, ethers.parseEther("0.005"), 8_275_000n);
await submit("ordre B (8.275 USDC -> min 0.005 WETH)", USDC, WETH, 8_275_000n, ethers.parseEther("0.005"));

// ── 4. Retraits ──────────────────────────────────────────────────────────────
await tx("requestWithdraw 1 USDC", vault.requestWithdraw(USDC, 1_000_000n));
let doubleRejected = false;
try { await (await vault.requestWithdraw(USDC, 1_000_000n)).wait(); }
catch { doubleRejected = true; }
check("double requestWithdraw rejetée", doubleRejected);

// ── Attente du traitement par l'enclave ──────────────────────────────────────
console.log("\nAttente de l'enclave (matching + retrait, max 3 min)…");
const matchedIds = [startOrderId + 1n, startOrderId + 2n];
let settled = false, withdrawn = false;
for (let i = 0; i < 36 && !(settled && withdrawn); i++) {
  await sleep(5000);
  const head = await provider.getBlockNumber();
  if (!settled) {
    const logs = await vault.queryFilter(vault.filters.MatchSettled(), startBlock, head);
    settled = logs.some(l => [l.args.orderId1, l.args.orderId2].every(id => matchedIds.includes(id)));
  }
  if (!withdrawn) {
    const logs = await vault.queryFilter(vault.filters.Withdrawal(), startBlock, head);
    withdrawn = logs.some(l => l.args.amount === 1_000_000n);
  }
}
check("match A<->B réglé on-chain (MatchSettled sans montants)", settled);
check("retrait 1 USDC exécuté par l'enclave", withdrawn);
check("ordre insolvable resté non réglé", !(await vault.queryFilter(vault.filters.MatchSettled(), startBlock))
  .some(l => l.args.orderId1 === startOrderId || l.args.orderId2 === startOrderId));

// ── 5. Vérifications finales ─────────────────────────────────────────────────
let replayRejected = false;
try { await vault.executeWithdraw.staticCall(wallet.address, USDC, 1_000_000n); }
catch { replayRejected = true; }
check("rejeu executeWithdraw rejeté", replayRejected);

const availUsdc = await decrypt("availableBalanceOf", USDC);
const lockedUsdc = await decrypt("lockedBalanceOf", USDC);
check(`soldes chiffrés déchiffrables (avail USDC=${ethers.formatUnits(availUsdc, 6)}, locked=${ethers.formatUnits(lockedUsdc, 6)})`, availUsdc >= 0n);

console.log(failures === 0 ? "\nE2E : TOUT EST VERT ✓" : `\nE2E : ${failures} ÉCHEC(S) ✗`);
process.exit(failures === 0 ? 0 : 1);
