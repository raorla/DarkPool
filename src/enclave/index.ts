import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import * as dotenv from "dotenv";

dotenv.config();

const PROVIDER_URL = process.env.SEPOLIA_PROVIDER_URL || "";
const ENCLAVE_PRIVATE_KEY = process.env.ENCLAVE_PRIVATE_KEY || "";
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "";

if (!PROVIDER_URL || !ENCLAVE_PRIVATE_KEY || !VAULT_ADDRESS) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

// ABI du DarkPoolVault v3 — règlement confidentiel par références d'ordres
const VAULT_ABI = [
  "event OrderSubmitted(uint256 indexed orderId, address indexed owner, address tokenIn, address tokenOut, bytes32 amountInHandle, bytes32 minAmountOutHandle, bytes32 solvencyOkHandle)",
  "event WithdrawRequested(address indexed user, address indexed token, uint256 amount)",
  "function settleMatches((uint256 orderId1, uint256 orderId2, bytes32 amount1To2External, bytes amount1To2Proof, bytes32 amount2To1External, bytes amount2To1Proof, bool closeOrder1, bool closeOrder2, uint256 salt)[] matches, bytes signature) external",
  "function executeWithdraw(address user, address token, uint256 amount) external",
  "function rejectWithdraw(address user, address token) external",
  "function pendingWithdrawals(address user, address token) view returns (uint256)",
  "function availableBalanceOf(address user, address token) view returns (bytes32)",
  "function orders(uint256 orderId) view returns (address owner, address tokenIn, address tokenOut, bytes32 amountInHandle, bytes32 minAmountOutHandle, bytes32 lockedAmountHandle, bytes32 solvencyOkHandle, bool isSettled)"
];

const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const wallet = new ethers.Wallet(ENCLAVE_PRIVATE_KEY, provider);
const vaultContract = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

let handleClient: any;

interface Order {
  id: number;
  owner: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
  remainingAmountIn: bigint;
}

const privateOrderBook: Order[] = [];
// Ordres déjà traités (évite les doublons si une plage de blocs est re-scannée)
const seenOrderIds = new Set<number>();
// Demandes de retrait déjà traitées (clé tx:logIndex)
const seenWithdrawals = new Set<string>();

function decryptedToBool(value: any): boolean {
  return value === true || value === 1n || value === 1 ||
         value === "true" || value === "1";
}

/**
 * Traite et déchiffre un ordre reçu via l'événement Solidity en utilisant le SDK Nox.
 */
async function processIncomingOrder(
  orderId: bigint,
  owner: string,
  tokenIn: string,
  tokenOut: string,
  amountInHandle: string,
  minAmountOutHandle: string,
  solvencyOkHandle: string
) {
  try {
    if (seenOrderIds.has(Number(orderId))) return;
    seenOrderIds.add(Number(orderId));

    console.log(`[TEE] Nouvel ordre détecté: ID ${orderId.toString()}`);

    // Ignore les ordres déjà réglés ou annulés (cas d'un re-scan après redémarrage)
    const onChain = await vaultContract.orders(orderId);
    if (onChain.isSettled) {
      console.log(`[TEE] Ordre ${orderId.toString()} déjà réglé/annulé, ignoré.`);
      return;
    }

    // Vérification de solvabilité : le contrat a comparé amountIn <= solde SUR CHIFFRÉS,
    // seule l'enclave peut lire le verdict.
    const okResult = await handleClient.decrypt(solvencyOkHandle);
    if (!decryptedToBool(okResult.value)) {
      console.log(`[TEE] Ordre ${orderId.toString()} INSOLVABLE (solde insuffisant au moment de la soumission) — ignoré. Aucun fonds séquestré.`);
      return;
    }

    console.log("[TEE] Déchiffrement des montants via le Nox KMS...");
    const amountInResult = await handleClient.decrypt(amountInHandle);
    const minAmountOutResult = await handleClient.decrypt(minAmountOutHandle);

    const amountIn = BigInt(amountInResult.value);
    const minAmountOut = BigInt(minAmountOutResult.value);

    console.log(`[TEE] Ordre ID ${orderId.toString()} déchiffré off-chain:`);
    console.log(` - Token In : ${tokenIn}`);
    console.log(` - Token Out : ${tokenOut}`);
    console.log(` - Montant In : ${amountIn.toString()}`);
    console.log(` - Min Montant Out : ${minAmountOut.toString()}`);

    privateOrderBook.push({
      id: Number(orderId),
      owner: owner,
      tokenIn: tokenIn,
      tokenOut: tokenOut,
      amountIn: amountIn,
      minAmountOut: minAmountOut,
      remainingAmountIn: amountIn
    });

    await runMatchingEngine();
  } catch (error: any) {
    // Erreur transitoire (KMS/RPC) : on libère l'ID pour retenter au prochain cycle.
    seenOrderIds.delete(Number(orderId));
    console.error(`[TEE] Erreur de traitement de l'ordre ${orderId.toString()} (nouvel essai au prochain cycle):`, (error?.message || String(error)).slice(0, 160));
  }
}

/**
 * Moteur d'appariement en mémoire (Matching Engine).
 */
async function runMatchingEngine() {
  console.log("[TEE] Moteur d'appariement en cours d'exécution...");

  for (let i = 0; i < privateOrderBook.length; i++) {
    for (let j = i + 1; j < privateOrderBook.length; j++) {
      const orderA = privateOrderBook[i];
      const orderB = privateOrderBook[j];

      if (
        orderA.tokenIn.toLowerCase() === orderB.tokenOut.toLowerCase() &&
        orderA.tokenOut.toLowerCase() === orderB.tokenIn.toLowerCase()
      ) {
        // Vérification de compatibilité de prix : minAmountOutA * minAmountOutB <= amountInA * amountInB
        if (
          orderA.minAmountOut * orderB.minAmountOut <= orderA.amountIn * orderB.amountIn
        ) {
          console.log(`[TEE] Match détecté entre l'ordre ${orderA.id} et ${orderB.id}`);

          // Calcul des montants d'exécution en utilisant le prix limite de l'ordre A (maker)
          const maxTokenA_In_from_B = (orderB.remainingAmountIn * orderA.amountIn) / orderA.minAmountOut;

          let execAmt_tokenA_In = orderA.remainingAmountIn;
          if (maxTokenA_In_from_B < execAmt_tokenA_In) {
            execAmt_tokenA_In = maxTokenA_In_from_B;
          }

          if (execAmt_tokenA_In === 0n) {
            continue;
          }

          const execAmt_tokenA_Out = (execAmt_tokenA_In * orderA.minAmountOut) / orderA.amountIn;
          if (execAmt_tokenA_Out === 0n) {
            continue;
          }

          console.log(`[TEE] Quantité exécutée : ${execAmt_tokenA_In.toString()} ${orderA.tokenIn} <=> ${execAmt_tokenA_Out.toString()} ${orderA.tokenOut}`);

          // Mise à jour des montants restants
          orderA.remainingAmountIn -= execAmt_tokenA_In;
          orderB.remainingAmountIn -= execAmt_tokenA_Out;

          const closeOrder1 = (orderA.remainingAmountIn === 0n);
          const closeOrder2 = (orderB.remainingAmountIn === 0n);

          // Retrait du carnet d'ordres s'ils sont entièrement remplis
          if (closeOrder2) {
            privateOrderBook.splice(j, 1);
          }
          if (closeOrder1) {
            privateOrderBook.splice(i, 1);
          }

          // Règlement
          await settleMatchedPair(orderA, orderB, execAmt_tokenA_In, execAmt_tokenA_Out, closeOrder1, closeOrder2);

          // Redémarrage de la boucle pour traiter le reste du carnet
          return runMatchingEngine();
        }
      }
    }
  }
}

/**
 * Signe et soumet le règlement du match.
 */
async function settleMatchedPair(
  orderA: Order,
  orderB: Order,
  amount1To2: bigint,
  amount2To1: bigint,
  closeOrder1: boolean,
  closeOrder2: boolean
) {
  const salt = ethers.toBigInt(ethers.randomBytes(32));
  const network = await provider.getNetwork();
  const chainId = network.chainId;

  console.log(`[TEE] Chiffrement du montant d'exécution 1To2 (${amount1To2.toString()}) via KMS...`);
  const { handle: amount1To2Handle, handleProof: amount1To2Proof } = await handleClient.encryptInput(
    amount1To2,
    "uint256",
    VAULT_ADDRESS
  );

  console.log(`[TEE] Chiffrement du montant d'exécution 2To1 (${amount2To1.toString()}) via KMS...`);
  const { handle: amount2To1Handle, handleProof: amount2To1Proof } = await handleClient.encryptInput(
    amount2To1,
    "uint256",
    VAULT_ADDRESS
  );

  const matchDetails = {
    orderId1: BigInt(orderA.id),
    orderId2: BigInt(orderB.id),
    amount1To2External: amount1To2Handle,
    amount1To2Proof: ethers.getBytes(amount1To2Proof),
    amount2To1External: amount2To1Handle,
    amount2To1Proof: ethers.getBytes(amount2To1Proof),
    closeOrder1: closeOrder1,
    closeOrder2: closeOrder2,
    salt: salt
  };

  const matchesArray = [
    [
      matchDetails.orderId1,
      matchDetails.orderId2,
      matchDetails.amount1To2External,
      matchDetails.amount1To2Proof,
      matchDetails.amount2To1External,
      matchDetails.amount2To1Proof,
      matchDetails.closeOrder1,
      matchDetails.closeOrder2,
      matchDetails.salt
    ]
  ];

  const matchesAbiString = "tuple(uint256 orderId1, uint256 orderId2, bytes32 amount1To2External, bytes amount1To2Proof, bytes32 amount2To1External, bytes amount2To1Proof, bool closeOrder1, bool closeOrder2, uint256 salt)[]";
  const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address", matchesAbiString],
    [chainId, VAULT_ADDRESS, matchesArray]
  );
  const messageHash = ethers.keccak256(encodedData);
  const signature = await wallet.signMessage(ethers.getBytes(messageHash));

  console.log(`[TEE] Signature de règlement générée par l'enclave : ${signature}`);

  try {
    const tx = await vaultContract.settleMatches(matchesArray, signature);
    console.log(`[TEE] Transaction de règlement envoyée. Hash: ${tx.hash}`);
    await tx.wait();
    console.log("[TEE] Règlement partiel validé on-chain !");
  } catch (error) {
    console.error("[TEE] Échec de la soumission de la transaction de règlement:", error);
  }
}

/**
 * Traite une demande de retrait : le contrat ne peut pas comparer un montant public
 * à un solde chiffré, l'enclave déchiffre donc le solde et autorise (ou non) le retrait.
 */
async function processWithdrawRequest(user: string, token: string, amount: bigint, key: string) {
  if (seenWithdrawals.has(key)) return;
  seenWithdrawals.add(key);

  try {
    console.log(`[TEE] Demande de retrait: ${user} -> ${amount.toString()} (token ${token})`);

    // La demande est-elle toujours en attente on-chain ? (consommée par une autre
    // instance, un re-scan, ou annulée par l'utilisateur → on ignore sans retry)
    const pending = await vaultContract.pendingWithdrawals(user, token);
    if (pending !== amount) {
      console.log("[TEE] Demande de retrait déjà consommée ou annulée, ignorée.");
      return;
    }

    const balHandle = await vaultContract.availableBalanceOf(user, token);
    const balance = balHandle === ethers.ZeroHash
      ? 0n
      : BigInt((await handleClient.decrypt(balHandle)).value);

    if (balance < amount) {
      console.log(`[TEE] Retrait REFUSÉ : solde disponible insuffisant (${balance.toString()} < ${amount.toString()}).`);
      const tx = await vaultContract.rejectWithdraw(user, token);
      await tx.wait();
      console.log("[TEE] Rejet enregistré on-chain (demande libérée).");
      return;
    }

    const tx = await vaultContract.executeWithdraw(user, token, amount);
    console.log(`[TEE] Retrait autorisé et exécuté. Hash: ${tx.hash}`);
    await tx.wait();
    console.log("[TEE] Retrait confirmé on-chain.");
  } catch (error: any) {
    const msg = error?.message || "";
    // Demande déjà consommée par une autre instance / un re-scan : sans danger, on ignore.
    if (msg.includes("No matching pending request") || msg.includes("No pending request")) {
      console.log("[TEE] Demande de retrait déjà traitée, ignorée.");
    } else {
      // Erreur transitoire (ex: gateway KMS pas encore synchronisée sur un grant ACL
      // fraîchement miné) : on retire la demande du cache pour réessayer au prochain cycle.
      seenWithdrawals.delete(key);
      console.error("[TEE] Erreur lors du traitement du retrait (nouvel essai au prochain cycle):", msg.slice(0, 160));
    }
  }
}

async function init() {
  console.log("Initialisation du client Nox Handle Ethers...");
  handleClient = await createEthersHandleClient(wallet as any);

  console.log(`[TEE] Enclave: ${wallet.address}`);
  console.log(`[TEE] Vault:   ${VAULT_ADDRESS}`);
  console.log("[TEE] Lancement de l'écouteur d'événements sur Sepolia (Polling)...");

  // Polling stateless (queryFilter) pour contourner les expirations de filtres des RPC publics.
  // On scanne 100 blocs en arrière pour attraper les transactions soumises juste avant le démarrage.
  let lastCheckedBlock = (await provider.getBlockNumber()) - 100;
  console.log(`[TEE] Démarrage du polling d'événements à partir du bloc #${lastCheckedBlock}`);

  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      // (currentBlock - 1) pour éviter les désynchronisations entre nœuds du load balancer RPC
      const targetBlock = currentBlock - 1;

      if (targetBlock > lastCheckedBlock) {
        const [orderLogs, withdrawLogs] = await Promise.all([
          vaultContract.queryFilter(vaultContract.filters.OrderSubmitted(), lastCheckedBlock + 1, targetBlock),
          vaultContract.queryFilter(vaultContract.filters.WithdrawRequested(), lastCheckedBlock + 1, targetBlock)
        ]);

        for (const log of orderLogs) {
          if ("args" in log && log.args) {
            const { orderId, owner, tokenIn, tokenOut, amountInHandle, minAmountOutHandle, solvencyOkHandle } = log.args as any;
            await processIncomingOrder(orderId, owner, tokenIn, tokenOut, amountInHandle, minAmountOutHandle, solvencyOkHandle);
          }
        }

        for (const log of withdrawLogs) {
          if ("args" in log && log.args) {
            const { user, token, amount } = log.args as any;
            await processWithdrawRequest(user, token, amount, `${log.transactionHash}:${log.index}`);
          }
        }

        lastCheckedBlock = targetBlock;
      }
    } catch (error: any) {
      const errMsg = error?.message || "";
      if (errMsg.includes("block range extends beyond current head block") || error?.code === -32602) {
        console.log("[TEE] Nœud RPC temporairement en retard de synchronisation (nouvel essai dans 10s)...");
      } else {
        console.error("[TEE] Erreur lors du polling des événements :", error);
      }
    }
  }, 10000);
}

init().catch(console.error);
