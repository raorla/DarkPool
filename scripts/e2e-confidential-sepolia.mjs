/**
 * Test E2E sur Sepolia — flux confidentiels P0.3/P0.4 (vault v3.2 + ConfidentialToken).
 *
 * Scénario furtif complet :
 *   1. Le wallet principal wrap 0.01 WETH -> cWETH (entrée publique, incompressible)
 *   2. Transfert confidentiel de 0.01 cWETH vers l'adresse furtive (montant masqué)
 *   3. L'adresse furtive (ZÉRO ETH, tout est relayé) :
 *      - setOperatorWithSig : autorise le vault sur le wrapper
 *      - depositConfidentialFor : dépôt chiffré dans le vault
 *      - submitOrderFor : vend 0.005 cWETH contre >= 8.275 cUSDC
 *   4. Contrepartie (wallet principal, flux direct) : wrap USDC, dépôt confidentiel,
 *      ordre inverse -> l'enclave matche et règle sans révéler de montants
 *   5. L'adresse furtive sort ses gains, toujours sans gas :
 *      - withdrawConfidentialFor : retrait SYNCHRONE chiffré vers le wrapper
 *      - requestUnwrapWithSig + finalizeUnwrap : sortie vers l'USDC public, preuve de
 *        décryption de la gateway KMS vérifiée on-chain (Nox.publicDecrypt)
 *   6. Vérifications : soldes chiffrés cohérents, l'adresse furtive n'a jamais eu d'ETH
 *
 * Prérequis :
 *   - `npm run build` (le script importe les helpers compilés de src/client/stealth.ts)
 *   - vault v3.2 + wrappers déployés : `npx hardhat run scripts/deploy.ts --network sepolia`
 *     (avec WETH_ADDRESS/USDC_ADDRESS dans le .env), puis VAULT_ADDRESS, CWETH_ADDRESS,
 *     CUSDC_ADDRESS dans le .env
 *   - l'enclave tourne (`npm run enclave`) avec le nouveau VAULT_ADDRESS
 *   - le wallet .env (ENCLAVE_PRIVATE_KEY) détient >= 0.01 WETH, >= 10 USDC + ETH de gas
 *   - optionnel : RELAYER_URL pour passer par le service HTTP (`npm run relayer`) ;
 *     sinon le script soumet lui-même les meta-tx (RELAYER_PRIVATE_KEY ou wallet principal)
 *
 * Usage : node scripts/e2e-confidential-sepolia.mjs
 */
import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import * as dotenv from "dotenv";
import {
  deriveStealthWallet,
  digestSetOperator,
  digestTransferEncrypted,
  digestRequestUnwrap,
  digestDepositConfidential,
  digestWithdrawConfidential,
  digestSubmitOrder,
  signMetaDigest,
  RelayerClient,
} from "../dist-server/client/stealth.js";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_PROVIDER_URL);
const wallet = new ethers.Wallet(process.env.ENCLAVE_PRIVATE_KEY, provider); // wallet principal financé
const relayerWallet = process.env.RELAYER_PRIVATE_KEY
  ? new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider)
  : wallet;
const relayerHttp = process.env.RELAYER_URL ? new RelayerClient(process.env.RELAYER_URL) : null;

const VAULT = process.env.VAULT_ADDRESS;
const CWETH = process.env.CWETH_ADDRESS;
const CUSDC = process.env.CUSDC_ADDRESS;
const WETH = process.env.WETH_ADDRESS || "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const USDC = process.env.USDC_ADDRESS || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
if (!VAULT || !CWETH || !CUSDC) {
  console.error("VAULT_ADDRESS, CWETH_ADDRESS et CUSDC_ADDRESS sont requis dans le .env (vault v3.2 + wrappers).");
  process.exit(1);
}

const ERC20 = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const WETH_ABI = [
  "function deposit() payable",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const CTOKEN_ABI = [
  "function wrap(uint256)",
  "function transferEncrypted(address,bytes32,bytes) returns (bytes32)",
  "function setOperator(address,bool)",
  "function setOperatorWithSig(address,address,bool,uint256,bytes)",
  "function requestUnwrapWithSig(address,uint256,uint256,bytes) returns (uint256)",
  "function finalizeUnwrap(uint256,bytes)",
  "function balanceOf(address) view returns (bytes32)",
  "function isOperator(address,address) view returns (bool)",
  "function metaNonces(address) view returns (uint256)",
  "function nextUnwrapId() view returns (uint256)",
  "function unwrapRequests(uint256) view returns (address user, uint256 amount, bytes32 ok, bool finalized)",
];
const VAULT_ABI = [
  "function depositConfidential(address,bytes32,bytes)",
  "function depositConfidentialFor(address,address,bytes32,bytes,uint256,bytes)",
  "function withdrawConfidentialFor(address,address,bytes32,bytes,uint256,bytes)",
  "function submitOrder(address,address,bytes32,bytes,bytes32,bytes) returns (uint256)",
  "function submitOrderFor(address,address,address,bytes32,bytes,bytes32,bytes,uint256,bytes) returns (uint256)",
  "function availableBalanceOf(address,address) view returns (bytes32)",
  "function metaNonces(address) view returns (uint256)",
  "function nextOrderId() view returns (uint256)",
  "event MatchSettled(uint256 indexed orderId1, uint256 indexed orderId2, address user1, address user2, address token1, address token2)",
];

const weth = new ethers.Contract(WETH, WETH_ABI, wallet);
const usdc = new ethers.Contract(USDC, ERC20, wallet);
const cweth = new ethers.Contract(CWETH, CTOKEN_ABI, wallet);
const cusdc = new ethers.Contract(CUSDC, CTOKEN_ABI, wallet);
const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);

let failures = 0;
const check = (label, ok) => { console.log(`${ok ? "✓" : "✗"} ${label}`); if (!ok) failures++; };
const tx = async (label, p) => { const t = await p; await t.wait(); console.log(`  ${label}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Retry pour la synchronisation de la gateway KMS (ACL fraîchement minées). */
async function withRetry(label, fn, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (attempt >= attempts) throw e;
      console.log(`  (${label}: gateway pas encore synchronisée, essai ${attempt}/${attempts}…)`);
      await sleep(10_000);
    }
  }
}

const { chainId } = await provider.getNetwork();
const stealth = await deriveStealthWallet(wallet, 0, provider);
console.log(`Vault v3.2 : ${VAULT}`);
console.log(`Wallet principal : ${wallet.address}`);
console.log(`Adresse furtive  : ${stealth.address} (dérivée, jamais financée en ETH)`);
console.log(`Relayer          : ${relayerHttp ? process.env.RELAYER_URL : relayerWallet.address}\n`);

// Clients de chiffrement KMS : le principal ET le furtif (les preuves encodent leur créateur)
const hcMain = await createEthersHandleClient(wallet);
const hcStealth = await createEthersHandleClient(stealth);

/** Soumet une meta-tx : via le relayer HTTP si configuré, sinon directement. */
async function relay(label, action, params, direct) {
  if (relayerHttp) {
    const { txHash } = await relayerHttp.relay({ action, params });
    await provider.waitForTransaction(txHash);
    console.log(`  ${label} (relayé via HTTP: ${txHash})`);
  } else {
    await tx(`${label} (relayé)`, direct());
  }
}

const decryptHandle = (hc, h) =>
  h === ethers.ZeroHash ? 0n : withRetry("déchiffrement", async () => BigInt((await hc.decrypt(h)).value));

const SELL_WETH = ethers.parseEther("0.0005");
const FUND_WETH = ethers.parseEther("0.001");
const SELL_USDC = 100_000n; // 0.1 cUSDC (6 décimales)

const startBlock = await provider.getBlockNumber();
const startOrderId = await vault.nextOrderId();

// En cas de manque de WETH public, convertir automatiquement l'ETH natif en WETH
const wethBalance = await weth.balanceOf(wallet.address);
if (wethBalance < FUND_WETH) {
  const amountToDeposit = FUND_WETH - wethBalance;
  console.log(`Solde WETH insuffisant (${ethers.formatEther(wethBalance)} WETH).`);
  await tx(`Conversion de ${ethers.formatEther(amountToDeposit)} ETH -> WETH (WETH.deposit)`,
    weth.deposit({ value: amountToDeposit })
  );
}

// ── 1. Wrap public (wallet principal) ───────────────────────────────────────
await tx("approve WETH -> cWETH", weth.approve(CWETH, FUND_WETH));
await tx(`wrap ${ethers.formatEther(FUND_WETH)} WETH -> cWETH`, cweth.wrap(FUND_WETH));

// ── 2. Transfert confidentiel vers l'adresse furtive ────────────────────────
{
  const a = await hcMain.encryptInput(FUND_WETH, "uint256", CWETH);
  await tx(`transfert confidentiel ${ethers.formatEther(FUND_WETH)} cWETH -> furtif (montant masqué)`,
    cweth.transferEncrypted(stealth.address, a.handle, a.handleProof));
  const bal = await decryptHandle(hcStealth, await cweth.balanceOf(stealth.address));
  check("solde cWETH furtif crédité (déchiffré via KMS)", bal >= FUND_WETH);
}

// ── 3. Flux furtif relayé : opérateur + dépôt + ordre ───────────────────────
{
  const nonce = await cweth.metaNonces(stealth.address);
  const sig = await signMetaDigest(stealth, digestSetOperator(chainId, CWETH, stealth.address, VAULT, true, nonce));
  await relay("setOperatorWithSig (vault opérateur du cWETH furtif)", "setOperator",
    { cToken: CWETH, holder: stealth.address, operator: VAULT, approved: true, nonce, signature: sig },
    () => cweth.connect(relayerWallet).setOperatorWithSig(stealth.address, VAULT, true, nonce, sig));
  check("vault opérateur du wrapper furtif", await cweth.isOperator(stealth.address, VAULT));
}
{
  const a = await hcStealth.encryptInput(FUND_WETH, "uint256", VAULT);
  const nonce = await vault.metaNonces(stealth.address);
  const sig = await signMetaDigest(stealth, digestDepositConfidential(chainId, VAULT, stealth.address, CWETH, a.handle, nonce));
  await relay(`depositConfidentialFor ${ethers.formatEther(FUND_WETH)} cWETH`, "depositConfidential",
    { owner: stealth.address, cToken: CWETH, amountHandle: a.handle, amountProof: a.handleProof, nonce, signature: sig },
    () => vault.connect(relayerWallet).depositConfidentialFor(stealth.address, CWETH, a.handle, a.handleProof, nonce, sig));
  const avail = await decryptHandle(hcStealth, await vault.availableBalanceOf(stealth.address, CWETH));
  check(`solde vault chiffré du furtif >= ${ethers.formatEther(FUND_WETH)} cWETH`, avail >= FUND_WETH);
}
{
  const a = await hcStealth.encryptInput(SELL_WETH, "uint256", VAULT);
  const m = await hcStealth.encryptInput(SELL_USDC, "uint256", VAULT);
  const nonce = await vault.metaNonces(stealth.address);
  const sig = await signMetaDigest(stealth,
    digestSubmitOrder(chainId, VAULT, stealth.address, CWETH, CUSDC, a.handle, m.handle, nonce));
  await relay(`submitOrderFor (vend ${ethers.formatEther(SELL_WETH)} cWETH, min ${ethers.formatUnits(SELL_USDC, 6)} cUSDC)`, "submitOrder",
    { owner: stealth.address, tokenIn: CWETH, tokenOut: CUSDC, amountInHandle: a.handle, amountInProof: a.handleProof,
      minAmountOutHandle: m.handle, minAmountOutProof: m.handleProof, nonce, signature: sig },
    () => vault.connect(relayerWallet).submitOrderFor(stealth.address, CWETH, CUSDC,
      a.handle, a.handleProof, m.handle, m.handleProof, nonce, sig));
}

// ── 4. Contrepartie (wallet principal, flux direct non relayé) ──────────────
await tx("approve USDC -> cUSDC", usdc.approve(CUSDC, SELL_USDC));
await tx(`wrap ${ethers.formatUnits(SELL_USDC, 6)} USDC -> cUSDC`, cusdc.wrap(SELL_USDC));
await tx("setOperator (vault) sur cUSDC", cusdc.setOperator(VAULT, true));
{
  const a = await hcMain.encryptInput(SELL_USDC, "uint256", VAULT);
  await tx(`depositConfidential ${ethers.formatUnits(SELL_USDC, 6)} cUSDC`, vault.depositConfidential(CUSDC, a.handle, a.handleProof));
  const aIn = await hcMain.encryptInput(SELL_USDC, "uint256", VAULT);
  const mOut = await hcMain.encryptInput(SELL_WETH, "uint256", VAULT);
  await tx(`submitOrder inverse (vend ${ethers.formatUnits(SELL_USDC, 6)} cUSDC, min ${ethers.formatEther(SELL_WETH)} cWETH)`,
    vault.submitOrder(CUSDC, CWETH, aIn.handle, aIn.handleProof, mOut.handle, mOut.handleProof));
}

// ── Attente du règlement par l'enclave ───────────────────────────────────────
console.log("\nAttente de l'enclave (matching, max 3 min)…");
const matchedIds = [startOrderId, startOrderId + 1n];
let settled = false;
for (let i = 0; i < 36 && !settled; i++) {
  await sleep(5000);
  const logs = await vault.queryFilter(vault.filters.MatchSettled(), startBlock, await provider.getBlockNumber());
  settled = logs.some(l => [l.args.orderId1, l.args.orderId2].every(id => matchedIds.includes(id)));
}
check("match furtif <-> contrepartie réglé (MatchSettled sans montants)", settled);

const gainedCusdc = await decryptHandle(hcStealth, await vault.availableBalanceOf(stealth.address, CUSDC));
check(`le furtif a gagné >= ${ethers.formatUnits(SELL_USDC, 6)} cUSDC dans le vault (déchiffré: ${ethers.formatUnits(gainedCusdc, 6)})`, gainedCusdc >= SELL_USDC);

// ── 5. Sortie furtive sans gas : retrait synchrone + unwrap ─────────────────
{
  const a = await hcStealth.encryptInput(SELL_USDC, "uint256", VAULT);
  const nonce = await vault.metaNonces(stealth.address);
  const sig = await signMetaDigest(stealth, digestWithdrawConfidential(chainId, VAULT, stealth.address, CUSDC, a.handle, nonce));
  await relay(`withdrawConfidentialFor ${ethers.formatUnits(SELL_USDC, 6)} cUSDC (synchrone, sans enclave)`, "withdrawConfidential",
    { owner: stealth.address, cToken: CUSDC, amountHandle: a.handle, amountProof: a.handleProof, nonce, signature: sig },
    () => vault.connect(relayerWallet).withdrawConfidentialFor(stealth.address, CUSDC, a.handle, a.handleProof, nonce, sig));
  const bal = await decryptHandle(hcStealth, await cusdc.balanceOf(stealth.address));
  check(`solde wrapper cUSDC furtif >= ${ethers.formatUnits(SELL_USDC, 6)}`, bal >= SELL_USDC);
}
{
  const unwrapId = await cusdc.nextUnwrapId();
  const nonce = await cusdc.metaNonces(stealth.address);
  const sig = await signMetaDigest(stealth, digestRequestUnwrap(chainId, CUSDC, stealth.address, SELL_USDC, nonce));
  await relay(`requestUnwrapWithSig ${ethers.formatUnits(SELL_USDC, 6)} cUSDC`, "requestUnwrap",
    { cToken: CUSDC, holder: stealth.address, amount: SELL_USDC, nonce, signature: sig },
    () => cusdc.connect(relayerWallet).requestUnwrapWithSig(stealth.address, SELL_USDC, nonce, sig));

  // Preuve de décryption publique du verdict (1 bit), signée par la gateway KMS
  const req = await cusdc.unwrapRequests(unwrapId);
  const { value, decryptionProof } = await withRetry("publicDecrypt", () => hcStealth.publicDecrypt(req.ok));
  check("verdict d'unwrap publiquement déchiffré = couvert", value === true || value === 1n || value === "true");

  await relay("finalizeUnwrap (preuve KMS vérifiée on-chain)", "finalizeUnwrap",
    { cToken: CUSDC, requestId: unwrapId, decryptionProof },
    () => cusdc.connect(relayerWallet).finalizeUnwrap(unwrapId, decryptionProof));
}

// ── 6. Vérifications finales ─────────────────────────────────────────────────
check(`le furtif a reçu >= ${ethers.formatUnits(SELL_USDC, 6)} USDC publics (sortie d'unwrap)`, (await usdc.balanceOf(stealth.address)) >= SELL_USDC);
check("l'adresse furtive n'a JAMAIS détenu d'ETH (gasless de bout en bout)",
  (await provider.getBalance(stealth.address)) === 0n);

console.log(failures === 0 ? "\nE2E CONFIDENTIEL : TOUT EST VERT ✓" : `\nE2E CONFIDENTIEL : ${failures} ÉCHEC(S) ✗`);
process.exit(failures === 0 ? 0 : 1);
