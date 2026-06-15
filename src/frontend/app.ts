import {
  createWalletClient, custom, http, parseEther,
  publicActions, parseAbiItem, keccak256, encodeAbiParameters, parseEventLogs
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";

// ── Contract addresses (vault v3.2 — confidential wrappers + meta-tx) ──────
const VAULT_ADDRESS  = import.meta.env.VITE_VAULT_ADDRESS  || "0x568eB7B8D2467cF7BdEEC799Af2dF86f1a58C4D0";
const WETH_ADDRESS   = import.meta.env.VITE_WETH_ADDRESS   || "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const USDC_ADDRESS   = import.meta.env.VITE_USDC_ADDRESS   || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const CWETH_ADDRESS  = import.meta.env.VITE_CWETH_ADDRESS  || "0x9901b7Ffb491035b4068f167CaEfd6DB038B63de";
const CUSDC_ADDRESS  = import.meta.env.VITE_CUSDC_ADDRESS  || "0xad6a8Ffa9Cd1d3432557fD281bf1C41Cf95ff3EA";

const CHAIN_ID = 11155111n; // Sepolia — entre dans les digests meta-tx (anti-rejeu)

// Service HTTP qui paie le gas des meta-transactions furtives (npm run relayer)
const RELAYER_URL = (globalThis as any).DARKPOOL_RELAYER_URL ?? "http://localhost:9545";
// RPC public : l'adresse furtive signe localement, jamais via MetaMask
const RPC_URL = (globalThis as any).DARKPOOL_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

// ── Module-level state ─────────────────────────────────────────────────────
let walletClient: any;
let handleClient: any;
let userAddress: `0x${string}`;

type Mode = "standard" | "stealth";
let mode: Mode = "standard";

// Identité furtive (P0.4) : clé dérivée d'une signature du wallet principal,
// jamais stockée, jamais financée en ETH — tout passe par le relayer.
let stealthAccount: any = null;
let stealthClient: any = null;
let stealthHandleClient: any = null;

// Latest cached balances for state-aware UI & guide
let last_wWeth = 0n;
let last_wUsdc = 0n;
let last_swWeth = 0n;
let last_swUsdc = 0n;
let last_svWeth = 0n;
let last_svUsdc = 0n;
let last_mwWeth = 0n;
let last_mwUsdc = 0n;

// File de déchiffrement KMS par client : les decrypt() sont sérialisés pour que
// le PREMIER crée et mette en cache l'autorisation EIP-712 (valable 1 h) que les
// suivants réutilisent. Sans cela, des decrypts parallèles sur cache vide
// déclenchent chacun leur propre popup de signature MetaMask.
const kmsQueues = new WeakMap<object, Promise<unknown>>();
function kmsDecrypt(hc: any, handle: string): Promise<{ value: any }> {
  const prev = kmsQueues.get(hc) ?? Promise.resolve();
  const next = prev.then(() => hc.decrypt(handle));
  kmsQueues.set(hc, next.catch(() => {}));
  return next;
}

// ── Minimal ABIs ───────────────────────────────────────────────────────────
const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "owner",   type: "address" }],
    outputs: [{ name: "",        type: "uint256" }]
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs:  [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "",        type: "bool" }]
  }
] as const;

const CTOKEN_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "account", type: "address" }],
    outputs: [{ name: "",        type: "bytes32" }]
  },
  {
    name: "wrap",
    type: "function",
    stateMutability: "nonpayable",
    inputs:  [{ name: "amount", type: "uint256" }],
    outputs: []
  },
  {
    name: "transferEncrypted",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to",             type: "address" },
      { name: "amountExternal", type: "bytes32" },
      { name: "amountProof",    type: "bytes"   }
    ],
    outputs: [{ name: "", type: "bytes32" }]
  },
  {
    name: "requestUnwrap",
    type: "function",
    stateMutability: "nonpayable",
    inputs:  [{ name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    name: "finalizeUnwrap",
    type: "function",
    stateMutability: "nonpayable",
    inputs:  [{ name: "requestId", type: "uint256" }, { name: "decryptionProof", type: "bytes" }],
    outputs: []
  },
  {
    name: "isOperator",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "holder", type: "address" }, { name: "operator", type: "address" }],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    name: "metaNonces",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "holder", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    name: "UnwrapRequested",
    type: "event",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true  },
      { name: "user",      type: "address", indexed: true  },
      { name: "amount",    type: "uint256", indexed: false },
      { name: "okHandle",  type: "bytes32", indexed: false }
    ]
  }
] as const;

const VAULT_ABI = [
  {
    name: "availableBalanceOf",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "user", type: "address" }, { name: "token", type: "address" }],
    outputs: [{ name: "",     type: "bytes32" }]
  },
  {
    name: "lockedBalanceOf",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "user", type: "address" }, { name: "token", type: "address" }],
    outputs: [{ name: "",     type: "bytes32" }]
  },
  {
    name: "metaNonces",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "user", type: "address" }],
    outputs: [{ name: "",     type: "uint256" }]
  },
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs:  [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: []
  },
  {
    name: "requestWithdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs:  [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: []
  },
  {
    name: "submitOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn",           type: "address" },
      { name: "tokenOut",          type: "address" },
      { name: "amountInExternal",  type: "bytes32" },
      { name: "amountInProof",     type: "bytes"   },
      { name: "minAmountOutExternal", type: "bytes32" },
      { name: "minAmountOutProof",    type: "bytes"   }
    ],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    name: "cancelOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs:  [{ name: "orderId", type: "uint256" }],
    outputs: []
  },
  {
    name: "nextOrderId",
    type: "function",
    stateMutability: "view",
    inputs:  [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    name: "orders",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "orderId", type: "uint256" }],
    outputs: [
      { name: "owner",              type: "address" },
      { name: "tokenIn",            type: "address" },
      { name: "tokenOut",           type: "address" },
      { name: "amountInHandle",     type: "bytes32" },
      { name: "minAmountOutHandle", type: "bytes32" },
      { name: "lockedAmountHandle", type: "bytes32" },
      { name: "solvencyOkHandle",   type: "bytes32" },
      { name: "isSettled",          type: "bool" }
    ]
  }
] as const;

const ZERO_HANDLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

// ── Token metadata ─────────────────────────────────────────────────────────
const TOKEN_META: Record<string, { symbol: string; decimals: number }> = {
  [WETH_ADDRESS.toLowerCase()]:  { symbol: "WETH",  decimals: 18 },
  [USDC_ADDRESS.toLowerCase()]:  { symbol: "USDC",  decimals: 6  },
  [CWETH_ADDRESS.toLowerCase()]: { symbol: "cWETH", decimals: 18 },
  [CUSDC_ADDRESS.toLowerCase()]: { symbol: "cUSDC", decimals: 6  }
};

function tokenSymbol(addr: string): string {
  return TOKEN_META[addr.toLowerCase()]?.symbol ?? shortAddr(addr);
}

// ── Utilities ──────────────────────────────────────────────────────────────
function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function log(
  msg: string,
  type: "system" | "info" | "success" | "warn" | "error" = "info"
) {
  const console = document.getElementById("consoleLogs");
  if (!console) return;
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  line.innerText = `[${new Date().toLocaleTimeString("en-GB")}] ${msg}`;
  console.appendChild(line);
  console.scrollTop = console.scrollHeight;
}

function setText(id: string, text: string) {
  const el = document.getElementById(id);
  if (el) el.innerText = text;
}

function formatToken(amount: bigint, decimals: number, precision = 4): string {
  const raw = Number(amount) / Math.pow(10, decimals);
  return raw.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: precision
  });
}

function parseAmount(symbol: string, raw: string): bigint {
  return symbol === "WETH" ? parseEther(raw) : BigInt(Math.floor(Number(raw) * 1e6));
}

/** Retry pour la synchronisation de la gateway KMS (ACL fraîchement minées). */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (attempt >= attempts) throw e;
      log(`${label}: KMS gateway not synced yet, retry ${attempt}/${attempts}…`, "info");
      await new Promise(r => setTimeout(r, 10_000));
    }
  }
}

function setBusy(btn: HTMLButtonElement | null, busyLabel: string | null) {
  if (!btn) return;
  if (busyLabel !== null) {
    if (!btn.dataset.idleHtml) btn.dataset.idleHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `⟳ ${busyLabel}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.idleHtml) btn.innerHTML = btn.dataset.idleHtml;
  }
}

// ── Stealth identity (P0.4) ────────────────────────────────────────────────
// Dérivation déterministe : keccak256 de la signature EIP-191 du wallet principal.
// ECDSA est déterministe (RFC 6979) — re-signer le même message redonne la même clé.
// Doit rester strictement identique à src/client/stealth.ts.
const STEALTH_DERIVATION_MESSAGE = (index: number) =>
  `DarkPool Nox — stealth key derivation v1 (index ${index})`;

async function ensureStealthIdentity(): Promise<boolean> {
  if (stealthHandleClient) return true;
  if (!walletClient) {
    log("Connect your wallet first.", "warn");
    return false;
  }
  try {
    log("Deriving stealth identity — please sign the derivation message…", "info");
    const signature = await walletClient.signMessage({
      account: userAddress,
      message: STEALTH_DERIVATION_MESSAGE(0)
    });
    stealthAccount = privateKeyToAccount(keccak256(signature));
    stealthClient = createWalletClient({
      account: stealthAccount,
      chain: sepolia,
      transport: http(RPC_URL)
    }).extend(publicActions);

    log(`Stealth address: ${stealthAccount.address}`, "success");
    log("Derived locally from your signature — never stored, never funded with ETH.", "info");

    log("Initialising stealth Nox Handle client…", "info");
    stealthHandleClient = await createViemHandleClient(stealthClient);
    log("Stealth Handle client ready (signs locally, no popups).", "success");

    // Le relayer paie le gas de toutes les actions furtives : vérifier qu'il répond
    try {
      const health = await fetch(`${RELAYER_URL}/health`).then(r => r.json());
      log(`Relayer online: ${shortAddr(health.relayer)} (${RELAYER_URL})`, "success");
    } catch {
      log(`Relayer unreachable at ${RELAYER_URL} — gasless actions will fail. Start it with "npm run relayer".`, "warn");
    }

    const chip = document.getElementById("stealthChip");
    if (chip) {
      chip.classList.remove("hidden");
      chip.title = stealthAccount.address;
    }
    const stAddrEl = document.getElementById("stealthAddrText") as HTMLAnchorElement | null;
    if (stAddrEl) {
      stAddrEl.innerText = shortAddr(stealthAccount.address);
      stAddrEl.title     = stealthAccount.address;
      stAddrEl.href      = `https://sepolia.etherscan.io/address/${stealthAccount.address}`;
    }
    return true;
  } catch (err: any) {
    stealthAccount = stealthClient = stealthHandleClient = null;
    log(`Stealth derivation failed: ${err.message || err}`, "error");
    return false;
  }
}

// ── Meta-tx digests + relayer client ───────────────────────────────────────
// Reflètent exactement l'abi.encode des contrats (cf. src/client/stealth.ts).
function metaDigest(types: string[], values: unknown[]): `0x${string}` {
  return keccak256(encodeAbiParameters(types.map(t => ({ type: t })), values));
}

const digestSetOperator = (cToken: string, holder: string, operator: string, approved: boolean, nonce: bigint) =>
  metaDigest(
    ["uint256", "address", "string", "address", "address", "bool", "uint256"],
    [CHAIN_ID, cToken, "setOperator", holder, operator, approved, nonce]
  );

const digestTransferEncrypted = (cToken: string, holder: string, to: string, amountHandle: string, nonce: bigint) =>
  metaDigest(
    ["uint256", "address", "string", "address", "address", "bytes32", "uint256"],
    [CHAIN_ID, cToken, "transferEncrypted", holder, to, amountHandle, nonce]
  );

const digestRequestUnwrap = (cToken: string, holder: string, amount: bigint, nonce: bigint) =>
  metaDigest(
    ["uint256", "address", "string", "address", "uint256", "uint256"],
    [CHAIN_ID, cToken, "requestUnwrap", holder, amount, nonce]
  );

const digestDepositConfidential = (owner: string, cToken: string, amountHandle: string, nonce: bigint) =>
  metaDigest(
    ["uint256", "address", "string", "address", "address", "bytes32", "uint256"],
    [CHAIN_ID, VAULT_ADDRESS, "depositConfidential", owner, cToken, amountHandle, nonce]
  );

const digestWithdrawConfidential = (owner: string, cToken: string, amountHandle: string, nonce: bigint) =>
  metaDigest(
    ["uint256", "address", "string", "address", "address", "bytes32", "uint256"],
    [CHAIN_ID, VAULT_ADDRESS, "withdrawConfidential", owner, cToken, amountHandle, nonce]
  );

const digestSubmitOrder = (owner: string, tokenIn: string, tokenOut: string, aHandle: string, mHandle: string, nonce: bigint) =>
  metaDigest(
    ["uint256", "address", "string", "address", "address", "address", "bytes32", "bytes32", "uint256"],
    [CHAIN_ID, VAULT_ADDRESS, "submitOrder", owner, tokenIn, tokenOut, aHandle, mHandle, nonce]
  );

/** Signature EIP-191 du digest par l'adresse furtive — locale, sans popup. */
const signDigest = (digest: `0x${string}`) =>
  stealthAccount.signMessage({ message: { raw: digest } });

/** Envoie une meta-tx signée au relayer (qui paie le gas) et attend le minage. */
async function relayAndWait(label: string, action: string, params: Record<string, unknown>): Promise<string> {
  log(`${label} — relaying (gasless)…`, "info");
  let body: any;
  try {
    const res = await fetch(`${RELAYER_URL}/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, params }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
    });
    body = await res.json();
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  } catch (err: any) {
    throw new Error(`Relayer: ${err.message || err}`);
  }
  log(`${label} — relayed. Tx: ${body.txHash}`, "success");
  await walletClient.waitForTransactionReceipt({ hash: body.txHash });
  return body.txHash;
}

const vaultMetaNonce = (owner: string): Promise<bigint> =>
  walletClient.readContract({
    address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "metaNonces", args: [owner]
  });

const cTokenMetaNonce = (cToken: string, holder: string): Promise<bigint> =>
  walletClient.readContract({
    address: cToken, abi: CTOKEN_ABI, functionName: "metaNonces", args: [holder]
  });

/** Autorise (une fois) le vault à déplacer le solde wrapper furtif — gasless. */
async function ensureVaultOperator(cToken: string) {
  const isOp = await walletClient.readContract({
    address: cToken, abi: CTOKEN_ABI, functionName: "isOperator",
    args: [stealthAccount.address, VAULT_ADDRESS]
  });
  if (isOp) return;
  log("One-time setup: authorising the vault as operator of your stealth wrapper…", "info");
  const nonce = await cTokenMetaNonce(cToken, stealthAccount.address);
  const signature = await signDigest(
    digestSetOperator(cToken, stealthAccount.address, VAULT_ADDRESS, true, nonce)
  );
  await relayAndWait("Operator authorisation", "setOperator", {
    cToken, holder: stealthAccount.address, operator: VAULT_ADDRESS,
    approved: true, nonce, signature
  });
}

// ── Privacy mode switch ────────────────────────────────────────────────────
async function setMode(next: Mode) {
  if (next === mode) return;
  if (next === "stealth" && !(await ensureStealthIdentity())) return;

  mode = next;
  const stealth = mode === "stealth";

  document.getElementById("modeStandardBtn")?.classList.toggle("active", !stealth);
  document.getElementById("modeStealthBtn")?.classList.toggle("active", stealth);
  document.getElementById("vaultStandardBody")?.classList.toggle("hidden", stealth);
  document.getElementById("vaultStealthBody")?.classList.toggle("hidden", !stealth);
  document.getElementById("stealthOrderNote")?.classList.toggle("hidden", !stealth);

  setText("vaultCardSub", stealth ? "Stealth custody · gasless" : "Custody & collateral");
  const vaultDesc = document.getElementById("vaultCardDesc");
  if (vaultDesc) vaultDesc.innerText = stealth
    ? "Fund your stealth address once, then deposit, trade and exit through the relayer — your main wallet never appears on-chain."
    : "Deposit tokens into the vault before placing orders. Funds stay under your control until you withdraw.";

  setText("orderCardSub", stealth ? "Encrypted · signed by stealth · relayed" : "Encrypted limit order");
  const teeBadge = document.getElementById("teeBadgeText");
  if (teeBadge) teeBadge.innerText = stealth ? "TEE + Stealth" : "TEE Protected";

  syncOrderPanelLabels();
  const submitBtn = document.getElementById("submitOrderBtn") as HTMLButtonElement | null;
  if (submitBtn) { delete submitBtn.dataset.idleHtml; submitBtn.innerHTML = submitOrderIdleHtml(); }

  log(stealth
    ? "Stealth mode ON — trading via cWETH/cUSDC, all actions signed by your stealth address and relayed gasless."
    : "Standard mode — trading directly from your main wallet.", "system");

  await refreshBalances();
  await loadUserOrders();
}

// ── Connect Wallet ─────────────────────────────────────────────────────────
async function connectWallet() {
  const eth = (window as any).ethereum;
  if (!eth) {
    log("No Web3 wallet detected. Please install MetaMask.", "error");
    return;
  }

  try {
    log("Requesting wallet access…", "info");
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    userAddress = accounts[0];

    walletClient = createWalletClient({
      chain: sepolia,
      transport: custom(eth)
    }).extend(publicActions);

    // Update UI state
    document.getElementById("heroBanner")?.classList.add("hidden");
    document.getElementById("walletBar")?.classList.remove("hidden");
    const userAddrEl = document.getElementById("userAddressText") as HTMLAnchorElement | null;
    if (userAddrEl) {
      userAddrEl.innerText = shortAddr(userAddress);
      userAddrEl.title     = userAddress;
      userAddrEl.href      = `https://sepolia.etherscan.io/address/${userAddress}`;
    }
    const exitAddrInput = document.getElementById("stealthExitAddressInput") as HTMLInputElement | null;
    if (exitAddrInput) {
      exitAddrInput.value = userAddress;
    }
    document.getElementById("connectWalletBtn")!.innerHTML =
      `<svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="#34d399"/></svg> ${shortAddr(userAddress)}`;

    // Vault address in footer
    const footer = document.getElementById("vaultAddressFooter");
    if (footer) footer.innerText = `Vault: ${VAULT_ADDRESS}`;

    log(`Wallet connected: ${shortAddr(userAddress)}`, "success");

    // Init Nox KMS client
    log("Initialising Nox Handle client (KMS & Gateway)…", "info");
    handleClient = await createViemHandleClient(walletClient);
    log("Nox Handle client ready.", "success");

    // Enable order button
    document.getElementById("submitOrderBtn")!.removeAttribute("disabled");

    await refreshBalances();
    await loadUserOrders();
  } catch (err: any) {
    log(`Connection failed: ${err.message || err}`, "error");
  }
}

// ── Refresh Balances ───────────────────────────────────────────────────────
async function refreshBalances() {
  if (!userAddress || !walletClient) return;

  // Spin the refresh icon
  const btn = document.getElementById("refreshBalancesBtn");
  btn?.classList.add("spin");

  try {
    log("Refreshing balances…", "info");

    const read = (address: string, fn: string, args: any[]) =>
      walletClient.readContract({ address, abi: ERC20_ABI,  functionName: fn, args }) as Promise<bigint>;

    // Les soldes du vault sont des euint256 : on lit le handle puis on le déchiffre
    // via le KMS (seuls le propriétaire et l'enclave ont le droit de le faire).
    const vaultRead = async (hc: any, owner: string, fn: "availableBalanceOf" | "lockedBalanceOf", token: string): Promise<bigint> => {
      const handle = await walletClient.readContract({
        address: VAULT_ADDRESS, abi: VAULT_ABI,
        functionName: fn, args: [owner, token]
      }) as string;
      if (!handle || handle === ZERO_HANDLE) return 0n;
      const r = await kmsDecrypt(hc, handle);
      return BigInt(r.value);
    };

    const mainWrapperRead = async (cToken: string): Promise<bigint> => {
      if (!handleClient) return 0n;
      const handle = await walletClient.readContract({
        address: cToken, abi: CTOKEN_ABI, functionName: "balanceOf",
        args: [userAddress]
      }) as string;
      if (!handle || handle === ZERO_HANDLE) return 0n;
      const r = await kmsDecrypt(handleClient, handle);
      return BigInt(r.value);
    };

    const [wWeth, vWeth, wUsdc, vUsdc, lWeth, lUsdc, mwWeth, mwUsdc] = await Promise.all([
      read(WETH_ADDRESS, "balanceOf", [userAddress]),
      vaultRead(handleClient, userAddress, "availableBalanceOf", WETH_ADDRESS),
      read(USDC_ADDRESS, "balanceOf", [userAddress]),
      vaultRead(handleClient, userAddress, "availableBalanceOf", USDC_ADDRESS),
      vaultRead(handleClient, userAddress, "lockedBalanceOf", WETH_ADDRESS),
      vaultRead(handleClient, userAddress, "lockedBalanceOf", USDC_ADDRESS),
      mainWrapperRead(CWETH_ADDRESS),
      mainWrapperRead(CUSDC_ADDRESS)
    ]);

    last_wWeth = wWeth;
    last_wUsdc = wUsdc;
    last_mwWeth = mwWeth;
    last_mwUsdc = mwUsdc;

    if (lWeth > 0n || lUsdc > 0n) {
      log(`Locked in pending orders: ${formatToken(lWeth, 18)} WETH · ${formatToken(lUsdc, 6, 2)} USDC`, "info");
    }

    const wWethFmt = formatToken(wWeth, 18);
    const vWethFmt = formatToken(vWeth, 18);
    const wUsdcFmt = formatToken(wUsdc, 6, 2);
    const vUsdcFmt = formatToken(vUsdc, 6, 2);

    // Wallet bar (top)
    setText("walletWethText", wWethFmt);
    setText("vaultWethText",  vWethFmt);
    setText("walletUsdcText", wUsdcFmt);
    setText("vaultUsdcText",  vUsdcFmt);

    // Vault panel (main card)
    setText("walletWethText2", wWethFmt);
    setText("vaultWethText2",  vWethFmt);
    setText("walletUsdcText2", wUsdcFmt);
    setText("vaultUsdcText2",  vUsdcFmt);

    // Stealth panel wallet balances
    setText("stWalletWethText", wWethFmt);
    setText("stWalletUsdcText", wUsdcFmt);

    // Identité furtive : soldes wrapper (cToken) + soldes vault chiffrés
    if (stealthHandleClient) {
      const wrapperRead = async (cToken: string): Promise<bigint> => {
        const handle = await walletClient.readContract({
          address: cToken, abi: CTOKEN_ABI, functionName: "balanceOf",
          args: [stealthAccount.address]
        }) as string;
        if (!handle || handle === ZERO_HANDLE) return 0n;
        const r = await kmsDecrypt(stealthHandleClient, handle);
        return BigInt(r.value);
      };

      const [swWeth, svWeth, swUsdc, svUsdc, slWeth, slUsdc] = await Promise.all([
        wrapperRead(CWETH_ADDRESS),
        vaultRead(stealthHandleClient, stealthAccount.address, "availableBalanceOf", CWETH_ADDRESS),
        wrapperRead(CUSDC_ADDRESS),
        vaultRead(stealthHandleClient, stealthAccount.address, "availableBalanceOf", CUSDC_ADDRESS),
        vaultRead(stealthHandleClient, stealthAccount.address, "lockedBalanceOf", CWETH_ADDRESS),
        vaultRead(stealthHandleClient, stealthAccount.address, "lockedBalanceOf", CUSDC_ADDRESS)
      ]);

      if (slWeth > 0n || slUsdc > 0n) {
        log(`Stealth locked in pending orders: ${formatToken(slWeth, 18)} cWETH · ${formatToken(slUsdc, 6, 2)} cUSDC`, "info");
      }

      setText("stWrapWethText",  formatToken(swWeth, 18));
      setText("stVaultWethText", formatToken(svWeth, 18));
      setText("stWrapUsdcText",  formatToken(swUsdc, 6, 2));
      setText("stVaultUsdcText", formatToken(svUsdc, 6, 2));

      last_swWeth = swWeth;
      last_svWeth = svWeth;
      last_swUsdc = swUsdc;
      last_svUsdc = svUsdc;
    } else {
      last_swWeth = 0n;
      last_svWeth = 0n;
      last_swUsdc = 0n;
      last_svUsdc = 0n;
    }

    updateStealthFlowUI();
    log("Balances updated.", "success");
  } catch (err: any) {
    log(`Balance read error: ${err.message || err}`, "error");
  } finally {
    btn?.classList.remove("spin");
  }
}

// ── Deposit (standard, ERC-20 public) ──────────────────────────────────────
async function handleDeposit() {
  if (!userAddress || !walletClient) {
    log("Connect your wallet first.", "warn");
    return;
  }

  const symbol   = (document.getElementById("actionTokenSelect") as HTMLSelectElement).value;
  const token    = symbol === "WETH" ? WETH_ADDRESS : USDC_ADDRESS;
  const rawAmt   = (document.getElementById("actionAmountInput") as HTMLInputElement).value;

  if (!rawAmt || Number(rawAmt) <= 0) {
    log("Enter a valid deposit amount.", "warn");
    return;
  }

  const amount = parseAmount(symbol, rawAmt);

  try {
    log(`Approving vault to spend ${rawAmt} ${symbol}…`, "info");
    const approveTx = await walletClient.writeContract({
      address: token, abi: ERC20_ABI, functionName: "approve",
      args: [VAULT_ADDRESS, amount], account: userAddress, chain: sepolia
    });
    log(`Approval sent (${approveTx}). Waiting for confirmation…`, "info");

    log(`Depositing ${rawAmt} ${symbol} into the vault…`, "info");
    const depositTx = await walletClient.writeContract({
      address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "deposit",
      args: [token, amount], account: userAddress, chain: sepolia
    });
    log(`Deposit submitted. Tx: ${depositTx}`, "success");
    setTimeout(refreshBalances, 5000);
  } catch (err: any) {
    log(`Deposit failed: ${err.message || err}`, "error");
  }
}

// ── Withdraw (standard, via l'enclave) ─────────────────────────────────────
async function handleWithdraw() {
  if (!userAddress || !walletClient) {
    log("Connect your wallet first.", "warn");
    return;
  }

  const symbol  = (document.getElementById("actionTokenSelect") as HTMLSelectElement).value;
  const token   = symbol === "WETH" ? WETH_ADDRESS : USDC_ADDRESS;
  const rawAmt  = (document.getElementById("actionAmountInput") as HTMLInputElement).value;

  if (!rawAmt || Number(rawAmt) <= 0) {
    log("Enter a valid withdrawal amount.", "warn");
    return;
  }

  const amount = parseAmount(symbol, rawAmt);

  try {
    log(`Requesting withdrawal of ${rawAmt} ${symbol}…`, "info");
    const tx = await walletClient.writeContract({
      address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "requestWithdraw",
      args: [token, amount], account: userAddress, chain: sepolia
    });
    log(`Withdrawal requested. Tx: ${tx}`, "success");
    log("The enclave verifies your encrypted balance, then releases the funds (~30s).", "info");
    setTimeout(refreshBalances, 30000);
  } catch (err: any) {
    log(`Withdrawal failed: ${err.message || err}`, "error");
  }
}

// ── Stealth flows (P0.3 + P0.4) ────────────────────────────────────────────
function updateStealthFlowUI() {
  const symbol = (document.getElementById("stealthTokenSelect") as HTMLSelectElement)?.value || "WETH";
  const cSymbol = symbol === "WETH" ? "cWETH" : "cUSDC";

  // Get current balances based on selection
  let w = 0n;
  let sw = 0n;
  let sv = 0n;
  let mw = 0n;

  if (symbol === "WETH") {
    w = last_wWeth;
    sw = last_swWeth;
    sv = last_svWeth;
    mw = last_mwWeth;
  } else {
    w = last_wUsdc;
    sw = last_swUsdc;
    sv = last_svUsdc;
    mw = last_mwUsdc;
  }

  // Get elements
  const stealthFundBtn = document.getElementById("stealthFundBtn") as HTMLButtonElement | null;
  const stealthDepositBtn = document.getElementById("stealthDepositBtn") as HTMLButtonElement | null;
  const stealthWithdrawBtn = document.getElementById("stealthWithdrawBtn") as HTMLButtonElement | null;
  const stealthExitBtn = document.getElementById("stealthExitBtn") as HTMLButtonElement | null;
  const stealthUnwrapBtn = document.getElementById("stealthUnwrapBtn") as HTMLButtonElement | null;
  const stMainWrapBalText = document.getElementById("stMainWrapBalText");

  const step1 = document.getElementById("stealthStep1");
  const step2 = document.getElementById("stealthStep2");
  const step3 = document.getElementById("stealthStep3");
  const orderPanel = document.querySelector(".panel-order") as HTMLElement | null;
  const helpTipText = document.getElementById("stealthHelpTipText");

  // Reset highlight states
  step1?.classList.remove("step-active");
  step2?.classList.remove("step-active");
  step3?.classList.remove("step-active");
  orderPanel?.classList.remove("step-active");

  // If not connected or no stealth Account initialized
  if (!userAddress || !stealthAccount) {
    if (stealthFundBtn) { stealthFundBtn.disabled = true; stealthFundBtn.title = "Connect wallet and switch to stealth mode first."; }
    if (stealthDepositBtn) { stealthDepositBtn.disabled = true; stealthDepositBtn.title = "Connect wallet and switch to stealth mode first."; }
    if (stealthWithdrawBtn) { stealthWithdrawBtn.disabled = true; stealthWithdrawBtn.title = "Connect wallet and switch to stealth mode first."; }
    if (stealthExitBtn) { stealthExitBtn.disabled = true; stealthExitBtn.title = "Connect wallet and switch to stealth mode first."; }
    if (stealthUnwrapBtn) { stealthUnwrapBtn.disabled = true; stealthUnwrapBtn.title = "Connect wallet and switch to stealth mode first."; }
    if (stMainWrapBalText) stMainWrapBalText.innerText = "Main Wrapper: —";
    if (helpTipText) {
      helpTipText.innerHTML = "Please <strong>connect your wallet</strong> and switch to <strong>Stealth Mode</strong> to initialize your confidential identity.";
    }
    return;
  }

  // Handle Button disabled/enabled states
  if (stealthFundBtn) {
    if (w === 0n) {
      stealthFundBtn.disabled = true;
      stealthFundBtn.title = `Your main wallet has 0 ${symbol}. Obtain public ${symbol} to fund stealth.`;
    } else {
      stealthFundBtn.disabled = false;
      stealthFundBtn.title = `Wrap ${symbol} and send confidentially to stealth wrapper.`;
    }
  }

  if (stealthDepositBtn) {
    if (sw === 0n) {
      stealthDepositBtn.disabled = true;
      stealthDepositBtn.title = `Your stealth wrapper has 0 ${cSymbol}. Run Step 1 (Fund) first.`;
    } else {
      stealthDepositBtn.disabled = false;
      stealthDepositBtn.title = `Deposit ${cSymbol} from wrapper into Dark Pool Vault (gasless).`;
    }
  }

  if (stealthExitBtn) {
    if (sw === 0n) {
      stealthExitBtn.disabled = true;
      stealthExitBtn.title = `Your stealth wrapper has 0 ${cSymbol}. Deposit or withdraw to wrapper first.`;
    } else {
      stealthExitBtn.disabled = false;
      stealthExitBtn.title = `Send ${cSymbol} from stealth wrapper to another wallet (gasless).`;
    }
  }

  if (stealthWithdrawBtn) {
    if (sv === 0n) {
      stealthWithdrawBtn.disabled = true;
      stealthWithdrawBtn.title = `Your vault balance is 0 ${cSymbol}.`;
    } else {
      stealthWithdrawBtn.disabled = false;
      stealthWithdrawBtn.title = `Withdraw ${cSymbol} from Dark Pool Vault back to stealth wrapper (gasless).`;
    }
  }

  if (stMainWrapBalText) {
    stMainWrapBalText.innerText = `Main Wrapper: ${formatToken(mw, symbol === "WETH" ? 18 : 6, 2)} ${cSymbol}`;
  }

  if (stealthUnwrapBtn) {
    if (mw === 0n) {
      stealthUnwrapBtn.disabled = true;
      stealthUnwrapBtn.title = `Your main wallet has 0 ${cSymbol} to unwrap.`;
    } else {
      stealthUnwrapBtn.disabled = false;
      stealthUnwrapBtn.title = `Unwrap ${cSymbol} held by your main wallet (pays gas).`;
    }
  }

  // Active step & tip logic
  if (w === 0n && sw === 0n && sv === 0n) {
    if (helpTipText) {
      helpTipText.innerHTML = `Your public main wallet, stealth wrapper, and vault are empty. Obtain some public <strong>${symbol}</strong> first to begin.`;
    }
    step1?.classList.add("step-active");
  } else if (sw > 0n) {
    if (helpTipText) {
      helpTipText.innerHTML = `You have confidential <strong>${cSymbol}</strong> in your stealth wrapper. Deposit them into the vault (<strong>Step 2</strong>) to unlock trading.`;
    }
    step2?.classList.add("step-active");
  } else if (w > 0n && sv === 0n) {
    if (helpTipText) {
      helpTipText.innerHTML = `You have public <strong>${symbol}</strong> in your main wallet. Wrap and send them to your stealth address (<strong>Step 1</strong>) to start.`;
    }
    step1?.classList.add("step-active");
  } else if (sv > 0n) {
    if (helpTipText) {
      helpTipText.innerHTML = `Your <strong>${cSymbol}</strong> is secured in the Dark Pool Vault. You can now place confidential limit orders below. To withdraw, use <strong>Step 2 (Withdraw)</strong>.`;
    }
    orderPanel?.classList.add("step-active");
  } else {
    if (helpTipText) {
      helpTipText.innerHTML = `Fund your stealth address (<strong>Step 1</strong>) or deposit wrapper tokens (<strong>Step 2</strong>) to use the dark pool.`;
    }
    step1?.classList.add("step-active");
  }
}

function stealthSelection(): { symbol: string; cSymbol: string; underlying: string; cToken: string; amount: bigint; raw: string } | null {
  const symbol = (document.getElementById("stealthTokenSelect") as HTMLSelectElement).value;
  const raw    = (document.getElementById("stealthAmountInput") as HTMLInputElement).value;
  if (!raw || Number(raw) <= 0) {
    log("Enter a valid amount.", "warn");
    return null;
  }
  return {
    symbol,
    cSymbol:    symbol === "WETH" ? "cWETH" : "cUSDC",
    underlying: symbol === "WETH" ? WETH_ADDRESS  : USDC_ADDRESS,
    cToken:     symbol === "WETH" ? CWETH_ADDRESS : CUSDC_ADDRESS,
    amount:     parseAmount(symbol, raw),
    raw
  };
}

/**
 * Étape 1 — Financement (wallet principal, paie le gas) :
 * approve -> wrap (entrée publique incompressible) -> transfert confidentiel
 * vers l'adresse furtive (le montant disparaît du radar à partir d'ici).
 */
async function handleStealthFund() {
  const sel = stealthSelection();
  if (!sel || !stealthHandleClient) return;
  const btn = document.getElementById("stealthFundBtn") as HTMLButtonElement;
  setBusy(btn, "Wrapping…");

  try {
    log(`Approving ${sel.cSymbol} wrapper to spend ${sel.raw} ${sel.symbol}…`, "info");
    const approveTx = await walletClient.writeContract({
      address: sel.underlying, abi: ERC20_ABI, functionName: "approve",
      args: [sel.cToken, sel.amount], account: userAddress, chain: sepolia
    });
    await walletClient.waitForTransactionReceipt({ hash: approveTx });

    log(`Wrapping ${sel.raw} ${sel.symbol} -> ${sel.cSymbol} (public entry, last visible step)…`, "info");
    const wrapTx = await walletClient.writeContract({
      address: sel.cToken, abi: CTOKEN_ABI, functionName: "wrap",
      args: [sel.amount], account: userAddress, chain: sepolia
    });
    await walletClient.waitForTransactionReceipt({ hash: wrapTx });

    setBusy(btn, "Encrypting…");
    log(`Encrypting transfer amount for the confidential hop…`, "info");
    const { handle, handleProof } = await handleClient.encryptInput(sel.amount, "uint256", sel.cToken);

    setBusy(btn, "Sending…");
    log(`Confidential transfer ${sel.cSymbol} -> stealth ${shortAddr(stealthAccount.address)} (amount hidden)…`, "info");
    const transferTx = await walletClient.writeContract({
      address: sel.cToken, abi: CTOKEN_ABI, functionName: "transferEncrypted",
      args: [stealthAccount.address, handle, handleProof],
      account: userAddress, chain: sepolia
    });
    await walletClient.waitForTransactionReceipt({ hash: transferTx });

    log(`Stealth account funded with ${sel.raw} ${sel.cSymbol} — invisible on-chain from now on.`, "success");
    await refreshBalances();
  } catch (err: any) {
    log(`Stealth funding failed: ${err.message || err}`, "error");
  } finally {
    setBusy(btn, null);
  }
}

/** Étape 2a — Dépôt chiffré dans le vault, signé par le furtif, relayé (gasless). */
async function handleStealthDeposit() {
  const sel = stealthSelection();
  if (!sel || !stealthHandleClient) return;
  const btn = document.getElementById("stealthDepositBtn") as HTMLButtonElement;
  setBusy(btn, "Depositing…");

  try {
    await ensureVaultOperator(sel.cToken);

    log(`Encrypting deposit amount (${sel.raw} ${sel.cSymbol})…`, "info");
    const { handle, handleProof } = await stealthHandleClient.encryptInput(sel.amount, "uint256", VAULT_ADDRESS);

    const nonce = await vaultMetaNonce(stealthAccount.address);
    const signature = await signDigest(
      digestDepositConfidential(stealthAccount.address, sel.cToken, handle, nonce)
    );
    await relayAndWait("Confidential deposit", "depositConfidential", {
      owner: stealthAccount.address, cToken: sel.cToken,
      amountHandle: handle, amountProof: handleProof, nonce, signature
    });

    log(`Deposited into the vault — amount, balance and sender all hidden.`, "success");
    await refreshBalances();
  } catch (err: any) {
    log(`Confidential deposit failed: ${err.message || err}`, "error");
  } finally {
    setBusy(btn, null);
  }
}

/** Étape 2b — Retrait chiffré SYNCHRONE du vault vers le wrapper furtif (gasless). */
async function handleStealthWithdraw() {
  const sel = stealthSelection();
  if (!sel || !stealthHandleClient) return;
  const btn = document.getElementById("stealthWithdrawBtn") as HTMLButtonElement;
  setBusy(btn, "Withdrawing…");

  try {
    log(`Encrypting withdrawal amount (${sel.raw} ${sel.cSymbol})…`, "info");
    const { handle, handleProof } = await stealthHandleClient.encryptInput(sel.amount, "uint256", VAULT_ADDRESS);

    const nonce = await vaultMetaNonce(stealthAccount.address);
    const signature = await signDigest(
      digestWithdrawConfidential(stealthAccount.address, sel.cToken, handle, nonce)
    );
    await relayAndWait("Confidential withdrawal", "withdrawConfidential", {
      owner: stealthAccount.address, cToken: sel.cToken,
      amountHandle: handle, amountProof: handleProof, nonce, signature
    });

    log("Withdrawn synchronously — coverage checked on encrypted values, nothing revealed.", "success");
    log("If your encrypted balance was insufficient, 0 was withdrawn (by design, no leak).", "info");
    await refreshBalances();
  } catch (err: any) {
    log(`Confidential withdrawal failed: ${err.message || err}`, "error");
  } finally {
    setBusy(btn, null);
  }
}

/** Étape 3a — Rapatriement confidentiel wrapper furtif -> wallet principal (gasless). */
async function handleStealthExit() {
  const sel = stealthSelection();
  if (!sel || !stealthHandleClient) return;
  const btn = document.getElementById("stealthExitBtn") as HTMLButtonElement;

  const destInput = document.getElementById("stealthExitAddressInput") as HTMLInputElement | null;
  const dest = destInput?.value?.trim() || userAddress;

  if (!dest || !/^0x[a-fA-F0-9]{40}$/.test(dest)) {
    log("Please enter a valid Ethereum recipient address.", "warn");
    return;
  }

  setBusy(btn, "Sending…");

  try {
    log(`Encrypting transfer amount (${sel.raw} ${sel.cSymbol}) to ${shortAddr(dest)}…`, "info");
    const { handle, handleProof } = await stealthHandleClient.encryptInput(sel.amount, "uint256", sel.cToken);

    const nonce = await cTokenMetaNonce(sel.cToken, stealthAccount.address);
    const signature = await signDigest(
      digestTransferEncrypted(sel.cToken, stealthAccount.address, dest, handle, nonce)
    );
    await relayAndWait("Confidential exit transfer", "transferEncrypted", {
      cToken: sel.cToken, holder: stealthAccount.address, to: dest,
      amountHandle: handle, amountProof: handleProof, nonce, signature
    });

    log(`${sel.cSymbol} sent confidentially to ${shortAddr(dest)} — amount hidden. Run "Unwrap" from that address to convert to ${sel.symbol}.`, "success");
    await refreshBalances();
  } catch (err: any) {
    log(`Exit transfer failed: ${err.message || err}`, "error");
  } finally {
    setBusy(btn, null);
  }
}

/**
 * Étape 3b — Unwrap (wallet principal, paie le gas) : requestUnwrap débite le solde
 * chiffré et publie un verdict 1 bit ; la preuve de décryption de la gateway KMS est
 * vérifiée on-chain par finalizeUnwrap. Seul le verdict est révélé, jamais le solde.
 */
async function handleStealthUnwrap() {
  const sel = stealthSelection();
  if (!sel || !handleClient) return;
  const btn = document.getElementById("stealthUnwrapBtn") as HTMLButtonElement;
  setBusy(btn, "Unwrapping…");

  try {
    log(`Requesting unwrap of ${sel.raw} ${sel.cSymbol} -> ${sel.symbol} (main wallet)…`, "info");
    const reqTx = await walletClient.writeContract({
      address: sel.cToken, abi: CTOKEN_ABI, functionName: "requestUnwrap",
      args: [sel.amount], account: userAddress, chain: sepolia
    });
    const receipt = await walletClient.waitForTransactionReceipt({ hash: reqTx });

    const [reqEvent] = parseEventLogs({ abi: CTOKEN_ABI, eventName: "UnwrapRequested", logs: receipt.logs });
    if (!reqEvent) throw new Error("UnwrapRequested event not found in receipt");
    const { requestId, okHandle } = (reqEvent as any).args;

    log("Fetching the public decryption proof from the KMS gateway (verdict bit only)…", "info");
    const { value, decryptionProof }: { value: any; decryptionProof: string } =
      await withRetry("publicDecrypt", () => handleClient.publicDecrypt(okHandle));
    const covered = value === true || value === 1n || value === "true" || value === 1;

    if (!covered) {
      log("Unwrap rejected: encrypted balance does not cover this amount (nothing was debited).", "warn");
      return;
    }

    log("Verdict: covered. Finalising with the KMS proof (verified on-chain)…", "info");
    const finTx = await walletClient.writeContract({
      address: sel.cToken, abi: CTOKEN_ABI, functionName: "finalizeUnwrap",
      args: [requestId, decryptionProof], account: userAddress, chain: sepolia
    });
    await walletClient.waitForTransactionReceipt({ hash: finTx });

    log(`Unwrapped ${sel.raw} ${sel.symbol} back to your wallet.`, "success");
    await refreshBalances();
  } catch (err: any) {
    log(`Unwrap failed: ${err.message || err}`, "error");
  } finally {
    setBusy(btn, null);
  }
}

// ── Submit Confidential Order ──────────────────────────────────────────────
function orderTokens(sellSymbol: string): { tokenIn: string; tokenOut: string } {
  const stealth = mode === "stealth";
  const weth = stealth ? CWETH_ADDRESS : WETH_ADDRESS;
  const usdc = stealth ? CUSDC_ADDRESS : USDC_ADDRESS;
  return sellSymbol === "WETH"
    ? { tokenIn: weth, tokenOut: usdc }
    : { tokenIn: usdc, tokenOut: weth };
}

function submitOrderIdleHtml(): string {
  return `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <polyline points="9 12 11 14 15 10"/>
    </svg>
    ${mode === "stealth" ? "Submit Stealth Order · Gasless" : "Submit Encrypted Order"}`;
}

async function handleOrderSubmit() {
  if (!userAddress || !handleClient) {
    log("Connect your wallet first.", "warn");
    return;
  }

  const sellSymbol  = (document.getElementById("orderTokenInSelect") as HTMLSelectElement).value;
  const buySymbol   = sellSymbol === "WETH" ? "USDC" : "WETH";
  const { tokenIn, tokenOut } = orderTokens(sellSymbol);

  const rawIn  = (document.getElementById("orderAmountInInput")     as HTMLInputElement).value;
  const rawMin = (document.getElementById("orderMinAmountOutInput") as HTMLInputElement).value;

  if (!rawIn || Number(rawIn) <= 0 || !rawMin || Number(rawMin) <= 0) {
    log("Invalid order parameters.", "warn");
    return;
  }

  const amountIn  = parseAmount(sellSymbol, rawIn);
  const minAmtOut = parseAmount(buySymbol, rawMin);

  const stealth = mode === "stealth";
  const hc = stealth ? stealthHandleClient : handleClient;

  // Disable button during processing
  const btn = document.getElementById("submitOrderBtn") as HTMLButtonElement;
  btn.disabled = true;
  btn.innerHTML = "⟳ Encrypting…";

  try {
    // Encrypt sell amount — applicationContract MUST be VAULT_ADDRESS because
    // validateInputProof checks the consuming contract. Les preuves encodent leur
    // créateur : en mode furtif, elles DOIVENT venir du client furtif.
    log(`Encrypting sell amount: ${rawIn} ${tokenSymbol(tokenIn)}`, "info");
    const { handle: amountInHandle, handleProof: amountInProof } =
      await hc.encryptInput(amountIn, "uint256", VAULT_ADDRESS);

    log(`Encrypting minimum receive: ${rawMin} ${tokenSymbol(tokenOut)}`, "info");
    const { handle: minAmtOutHandle, handleProof: minAmtOutProof } =
      await hc.encryptInput(minAmtOut, "uint256", VAULT_ADDRESS);

    log("Confidential handles ready.", "success");
    log(` · Sell handle:    ${amountInHandle}`, "info");
    log(` · Min-out handle: ${minAmtOutHandle}`, "info");

    btn.innerHTML = "⟳ Broadcasting…";

    if (stealth) {
      const nonce = await vaultMetaNonce(stealthAccount.address);
      const signature = await signDigest(
        digestSubmitOrder(stealthAccount.address, tokenIn, tokenOut, amountInHandle, minAmtOutHandle, nonce)
      );
      await relayAndWait("Stealth order", "submitOrder", {
        owner: stealthAccount.address, tokenIn, tokenOut,
        amountInHandle, amountInProof, minAmountOutHandle: minAmtOutHandle,
        minAmountOutProof: minAmtOutProof, nonce, signature
      });
      log("Order submitted by your stealth address — your main wallet never appeared on-chain.", "success");
    } else {
      log("Submitting confidential order on-chain…", "info");
      const tx = await walletClient.writeContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "submitOrder",
        args: [tokenIn, tokenOut, amountInHandle, amountInProof, minAmtOutHandle, minAmtOutProof],
        account: userAddress,
        chain: sepolia,
        // v3 : la soumission exécute la vérification de solvabilité chiffrée
        // (le, select, sub, add + grants ACL) — chaque op est un appel externe au NoxCompute
        gas: 3000000n
      });
      log(`Order submitted on-chain. Tx: ${tx}`, "success");
    }

    log("The Nox enclave will now match this order confidentially.", "info");

    // Refresh
    await loadUserOrders();
    await refreshBalances();
  } catch (err: any) {
    log(`Order submission failed: ${err.message || err}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = submitOrderIdleHtml();
  }
}

// ── Order history (events) ─────────────────────────────────────────────────
const VAULT_DEPLOY_BLOCK = 11043866n;

// v3 : MatchSettled ne contient AUCUN montant — le règlement est confidentiel
const MATCH_SETTLED_EVENT = parseAbiItem(
  "event MatchSettled(uint256 indexed orderId1, uint256 indexed orderId2, address user1, address user2, address token1, address token2)"
);
const ORDER_CANCELLED_EVENT = parseAbiItem(
  "event OrderCancelled(uint256 indexed orderId, address indexed owner)"
);

async function fetchOrderHistory(): Promise<{ filled: Set<string>; cancelled: Set<string> }> {
  const filled = new Set<string>();
  const cancelled = new Set<string>();
  const latest = await walletClient.getBlockNumber() as bigint;

  // Public RPCs cap getLogs ranges, so scan in chunks from the vault deploy block
  for (let from = VAULT_DEPLOY_BLOCK; from <= latest; from += 45_000n) {
    const to = from + 44_999n > latest ? latest : from + 44_999n;
    const [matchLogs, cancelLogs] = await Promise.all([
      walletClient.getLogs({ address: VAULT_ADDRESS, event: MATCH_SETTLED_EVENT, fromBlock: from, toBlock: to }),
      walletClient.getLogs({ address: VAULT_ADDRESS, event: ORDER_CANCELLED_EVENT, fromBlock: from, toBlock: to })
    ]);
    for (const l of matchLogs) {
      const { orderId1, orderId2 } = l.args as any;
      filled.add(orderId1.toString());
      filled.add(orderId2.toString());
    }
    for (const l of cancelLogs) cancelled.add((l.args as any).orderId.toString());
  }
  return { filled, cancelled };
}

function tokenDecimals(addr: string): number {
  return TOKEN_META[addr.toLowerCase()]?.decimals ?? 18;
}

function fmtAmount(amount: bigint, token: string): string {
  const d = tokenDecimals(token);
  return `${formatToken(amount, d, d === 6 ? 2 : 6)} ${tokenSymbol(token)}`;
}

// ── Load User Orders ───────────────────────────────────────────────────────
// Pending orders keep their handles here so "Reveal" can decrypt on demand
const revealData = new Map<number, {
  amountInHandle: string; minAmountOutHandle: string;
  tokenIn: string; tokenOut: string; isStealth: boolean;
}>();

async function loadUserOrders() {
  const container = document.getElementById("ordersContainer");
  if (!container || !walletClient) return;

  container.innerHTML = `
    <div class="empty-state">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <p>Loading orders…</p>
    </div>`;

  try {
    const [total, history] = await Promise.all([
      walletClient.readContract({
        address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "nextOrderId"
      }) as Promise<bigint>,
      fetchOrderHistory()
    ]);

    // Les ordres du wallet principal ET de l'identité furtive (si dérivée)
    const myOwners = new Map<string, boolean>([[userAddress.toLowerCase(), false]]);
    if (stealthAccount) myOwners.set(stealthAccount.address.toLowerCase(), true);

    const mine: Array<{
      id: bigint; tokenIn: string; tokenOut: string;
      amountInHandle: string; minAmountOutHandle: string; isSettled: boolean; isStealth: boolean;
    }> = [];

    for (let i = 0n; i < total; i++) {
      const o = await walletClient.readContract({
        address: VAULT_ADDRESS, abi: VAULT_ABI,
        functionName: "orders", args: [i]
      }) as readonly [string, string, string, string, string, string, string, boolean];

      const [owner, tokenIn, tokenOut, amountInHandle, minAmountOutHandle, , , isSettled] = o;
      const ownerKey = owner.toLowerCase();
      if (myOwners.has(ownerKey)) {
        mine.push({
          id: i, tokenIn, tokenOut, amountInHandle, minAmountOutHandle, isSettled,
          isStealth: myOwners.get(ownerKey)!
        });
      }
    }

    if (mine.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
            <rect x="9" y="3" width="6" height="4" rx="1"/>
          </svg>
          <p>No orders found for this wallet${stealthAccount ? " or its stealth address" : ""}.</p>
        </div>`;
      return;
    }

    revealData.clear();

    container.innerHTML = mine.map(o => {
      const idStr = o.id.toString();
      const isFilled = history.filled.has(idStr);
      const isCancelled = history.cancelled.has(idStr);
      const status = isFilled ? "filled" : isCancelled ? "cancelled" : "pending";

      // v3 : les montants ne sont JAMAIS publiés, même après règlement.
      // Le propriétaire garde son droit KMS et peut déchiffrer ses propres ordres.
      revealData.set(Number(o.id), {
        amountInHandle: o.amountInHandle, minAmountOutHandle: o.minAmountOutHandle,
        tokenIn: o.tokenIn, tokenOut: o.tokenOut, isStealth: o.isStealth
      });

      const statusBadge = {
        filled:    `<span class="order-status status-settled">Filled</span>`,
        cancelled: `<span class="order-status status-cancelled">Cancelled</span>`,
        pending:   `<span class="order-status status-pending">Pending</span>`
      }[status];

      const stealthBadge = o.isStealth
        ? `<span class="order-stealth-badge" title="Submitted by your stealth address — your main wallet never appeared on-chain">
             <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
               <path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 0-8 8v12l3-3 2.5 3 2.5-3 2.5 3 2.5-3 3 3V10a8 8 0 0 0-8-8z"/>
             </svg>
             Stealth
           </span>` : "";

      const body = `
        <div class="order-amounts" id="orderAmounts-${idStr}">
          <div class="order-handle-row">
            <span class="handle-label">Encrypted amounts${status === "filled" ? " · settled confidentially" : ""}</span>
            <span class="handle-value" title="${o.amountInHandle}">${o.amountInHandle.slice(0, 22)}…</span>
          </div>
          <button class="btn-reveal" onclick="handleRevealOrder(${idStr})" title="Decrypt with your KMS rights — only you can see this">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="11" width="18" height="11" rx="2"/>
              <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
            </svg>
            Reveal amounts
          </button>
        </div>`;

      // cancelOrder exige msg.sender == owner : pas de variante relayée, donc
      // pas d'annulation gasless possible pour un ordre furtif (l'adresse n'a pas d'ETH).
      const footer = status !== "pending" ? "" : o.isStealth
        ? `<div class="order-stealth-note">Cancel unavailable for stealth orders (requires gas from the stealth address)</div>`
        : `
        <button class="btn-cancel" onclick="handleCancelOrder(${idStr})">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          Cancel Order
        </button>`;

      return `
      <div class="order-card ${status !== "pending" ? "order-settled" : ""}">
        <div class="order-top">
          <span class="order-id">Order #${idStr}</span>
          <span class="order-badges">${stealthBadge}${statusBadge}</span>
        </div>
        <div class="order-pair-row">
          <span class="order-tok-in">${tokenSymbol(o.tokenIn)}</span>
          <span class="order-arrow">→</span>
          <span class="order-tok-out">${tokenSymbol(o.tokenOut)}</span>
        </div>
        ${body}
        ${footer}
      </div>`;
    }).join("");

  } catch (err: any) {
    container.innerHTML = `<div class="empty-state"><p>Error loading orders.</p></div>`;
    log(`Failed to load orders: ${err.message}`, "error");
  }
}

// ── Reveal (decrypt) a pending order's own amounts ─────────────────────────
async function handleRevealOrder(orderId: number) {
  const data = revealData.get(orderId);
  const box = document.getElementById(`orderAmounts-${orderId}`);
  if (!data || !box || !handleClient) return;

  // Un ordre furtif n'est déchiffrable que par l'identité furtive (ACL du handle)
  const hc = data.isStealth ? stealthHandleClient : handleClient;
  if (!hc) {
    log("Enable stealth mode first to decrypt this stealth order.", "warn");
    return;
  }

  const btn = box.querySelector(".btn-reveal") as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.innerText = "⟳ Decrypting…"; }

  try {
    log(`Decrypting order #${orderId} via Nox KMS…`, "info");
    const [amountIn, minOut] = await Promise.all([
      kmsDecrypt(hc, data.amountInHandle),
      kmsDecrypt(hc, data.minAmountOutHandle)
    ]);

    box.innerHTML = `
      <div class="order-amount-row">
        <span class="oa-label">Selling</span>
        <span class="oa-value oa-out">${fmtAmount(BigInt(amountIn.value), data.tokenIn)}</span>
      </div>
      <div class="order-amount-row">
        <span class="oa-label">Min. receive</span>
        <span class="oa-value oa-in">${fmtAmount(BigInt(minOut.value), data.tokenOut)}</span>
      </div>
      <div class="order-reveal-note">Decrypted locally — still hidden on-chain</div>`;
    log(`Order #${orderId} decrypted.`, "success");
  } catch (err: any) {
    if (btn) { btn.disabled = false; btn.innerText = "Reveal amounts"; }
    log(`Decryption failed: ${err.message || err}`, "error");
  }
}

// ── Cancel Order ───────────────────────────────────────────────────────────
async function handleCancelOrder(orderId: bigint) {
  if (!walletClient) return;
  try {
    log(`Cancelling order #${orderId}…`, "info");
    const tx = await walletClient.writeContract({
      address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "cancelOrder",
      args: [orderId], account: userAddress, chain: sepolia, gas: 1500000n
    });
    log(`Order #${orderId} cancelled. Tx: ${tx}`, "success");
    log("Your funds remain in the vault. Use Withdraw to retrieve them.", "info");
    setTimeout(() => loadUserOrders(), 3000);
  } catch (err: any) {
    log(`Cancel failed: ${err.message || err}`, "error");
  }
}

// Expose for inline onclick
(window as any).handleCancelOrder = handleCancelOrder;
(window as any).handleRevealOrder = handleRevealOrder;

// ── Order panel labels (depend on mode + sell side) ────────────────────────
function syncOrderPanelLabels() {
  const sellSelect = document.getElementById("orderTokenInSelect") as HTMLSelectElement;
  const isSellWeth = sellSelect.value === "WETH";
  const stealth = mode === "stealth";
  const p = stealth ? "c" : "";

  const tokenOutLabel  = document.getElementById("orderTokenOutLabel");
  const sellTag        = document.getElementById("sellTokenTag");
  const receiveTag     = document.getElementById("receiveTokenTag");

  if (tokenOutLabel) tokenOutLabel.innerText = isSellWeth
    ? (stealth ? "cUSDC — Confidential USDC" : "USDC — USD Coin")
    : (stealth ? "cWETH — Confidential WETH" : "WETH — Wrapped Ether");

  if (sellTag)    sellTag.innerText    = isSellWeth ? `${p}WETH` : `${p}USDC`;
  if (receiveTag) receiveTag.innerText = isSellWeth ? `${p}USDC` : `${p}WETH`;
}

// ── DOM Ready ──────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Show vault address in footer
  const footer = document.getElementById("vaultAddressFooter");
  if (footer) footer.innerText = `Vault: ${VAULT_ADDRESS}`;

  // Wire buttons
  document.getElementById("connectWalletBtn")!  .addEventListener("click", connectWallet);
  document.getElementById("depositBtn")!        .addEventListener("click", handleDeposit);
  document.getElementById("withdrawBtn")!       .addEventListener("click", handleWithdraw);
  document.getElementById("submitOrderBtn")!    .addEventListener("click", handleOrderSubmit);
  document.getElementById("refreshBalancesBtn")?.addEventListener("click", refreshBalances);
  document.getElementById("refreshOrdersBtn")!  .addEventListener("click", loadUserOrders);

  // Privacy mode switch
  document.getElementById("modeStandardBtn")?.addEventListener("click", () => setMode("standard"));
  document.getElementById("modeStealthBtn") ?.addEventListener("click", () => setMode("stealth"));

  // Stealth lifecycle buttons
  document.getElementById("stealthFundBtn")    ?.addEventListener("click", handleStealthFund);
  document.getElementById("stealthDepositBtn") ?.addEventListener("click", handleStealthDeposit);
  document.getElementById("stealthWithdrawBtn")?.addEventListener("click", handleStealthWithdraw);
  document.getElementById("stealthExitBtn")    ?.addEventListener("click", handleStealthExit);
  document.getElementById("stealthUnwrapBtn")  ?.addEventListener("click", handleStealthUnwrap);

  // Dynamic sell/buy token labels
  const sellSelect = document.getElementById("orderTokenInSelect") as HTMLSelectElement;
  sellSelect.addEventListener("change", syncOrderPanelLabels);

  // Stealth token selection change
  document.getElementById("stealthTokenSelect")?.addEventListener("change", updateStealthFlowUI);

  // Initialize stealth flow UI instructions/states
  updateStealthFlowUI();
});
