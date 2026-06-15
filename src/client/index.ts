import { createWalletClient, createPublicClient, http, parseEther, keccak256, encodeAbiParameters, parseAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

// Configuration des adresses de tokens ERC-20 sur Sepolia
const WETH_ADDRESS = process.env.WETH_ADDRESS || "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"; // WETH canonique Sepolia
const USDC_ADDRESS = process.env.USDC_ADDRESS || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"; // USDC officiel Sepolia
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "";
const SEPOLIA_PROVIDER_URL = process.env.SEPOLIA_PROVIDER_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

if (!DEPLOYER_PRIVATE_KEY || !VAULT_ADDRESS || VAULT_ADDRESS === "0x0000000000000000000000000000000000000000") {
  console.error("Veuillez configurer DEPLOYER_PRIVATE_KEY et VAULT_ADDRESS dans votre fichier .env.");
  process.exit(1);
}

const account = privateKeyToAccount(DEPLOYER_PRIVATE_KEY as `0x${string}`);

const walletClient = createWalletClient({
  account,
  chain: sepolia,
  transport: http(SEPOLIA_PROVIDER_URL),
});

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(SEPOLIA_PROVIDER_URL),
});

/**
 * Génère, signe et chiffre un ordre d'échange confidentiel en utilisant le SDK Nox.
 */
async function createAndSubmitOrder() {
  const userAddress = account.address;

  // Initialisation du client Nox Handle
  console.log("Initialisation du client Nox Handle...");
  const handleClient = await createViemHandleClient(walletClient);

  // Valeurs brutes de l'ordre : vendre 0.02 WETH pour au moins 60 USDC
  const amountInRaw = parseEther("0.02"); // 0.02 WETH (18 décimales)
  const minAmountOutRaw = 60n * 10n**6n; // 60 USDC (6 décimales)

  // Récupération de l'adresse de l'enclave autorisée à déchiffrer depuis le contrat
  console.log("Récupération de l'adresse de l'enclave depuis le contrat...");
  const enclaveAddress = await publicClient.readContract({
    address: VAULT_ADDRESS as `0x${string}`,
    abi: [
      {
        name: "enclaveAddress",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }]
      }
    ] as const,
    functionName: "enclaveAddress"
  } as any) as `0x${string}`;
  console.log(`Adresse de l'enclave récupérée : ${enclaveAddress}`);

  console.log("Chiffrement de amountIn avec Nox KMS...");
  // Chiffrement via le SDK Nox : génère un handle (bytes32) et une preuve (proof)
  const { handle: amountInHandle, handleProof: amountInProof } = await handleClient.encryptInput(
    amountInRaw,
    "uint256",
    enclaveAddress
  );

  console.log("Chiffrement de minAmountOut avec Nox KMS...");
  const { handle: minAmountOutHandle, handleProof: minAmountOutProof } = await handleClient.encryptInput(
    minAmountOutRaw,
    "uint256",
    enclaveAddress
  );

  console.log("Handles générés :");
  console.log(" - amountInHandle :", amountInHandle);
  console.log(" - minAmountOutHandle :", minAmountOutHandle);

  // 1. Hachage des paramètres de l'ordre pour signature
  const orderHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters("address, address, address, uint256, uint256, uint256"),
      [
        userAddress as `0x${string}`,
        WETH_ADDRESS as `0x${string}`,
        USDC_ADDRESS as `0x${string}`,
        amountInRaw,
        minAmountOutRaw,
        ethers.toBigInt(ethers.randomBytes(32))
      ]
    )
  );

  console.log("Hachage de l'ordre généré localement :", orderHash);

  // 2. Signature locale de l'ordre par le portefeuille de l'utilisateur (authentification)
  const userSignature = await walletClient.signMessage({
    account,
    message: { raw: ethers.getBytes(orderHash) },
  });

  console.log("Signature utilisateur générée :", userSignature);

  // 3. Enveloppement automatique de Sepolia ETH en WETH si nécessaire
  console.log("Vérification du solde de WETH...");
  const wethBalance = await publicClient.readContract({
    address: WETH_ADDRESS as `0x${string}`,
    abi: [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "owner", type: "address" }],
        outputs: [{ name: "", type: "uint256" }]
      }
    ] as const,
    functionName: "balanceOf",
    args: [userAddress]
  } as any) as bigint;

  console.log(`Votre solde actuel de WETH : ${ethers.formatEther(wethBalance)} WETH`);

  if (wethBalance < amountInRaw) {
    const wrapAmount = amountInRaw - wethBalance;
    console.log(`Solde WETH insuffisant. Enveloppement de ${ethers.formatEther(wrapAmount)} ETH en WETH...`);
    const wrapTxHash = await walletClient.writeContract({
      address: WETH_ADDRESS as `0x${string}`,
      abi: [
        {
          name: "deposit",
          type: "function",
          stateMutability: "payable",
          inputs: [],
          outputs: []
        }
      ] as const,
      functionName: "deposit",
      value: wrapAmount,
      account,
      chain: sepolia
    });
    console.log(`Transaction d'enveloppement envoyée. Hash : ${wrapTxHash}`);
    await publicClient.waitForTransactionReceipt({ hash: wrapTxHash });
    console.log("Enveloppement de WETH validé !");
  }

  // 4. Approbation du Vault à dépenser les WETH du client
  console.log("Étape 1: Approbation du token WETH pour le Vault...");
  const approveTxHash = await walletClient.writeContract({
    address: WETH_ADDRESS as `0x${string}`,
    abi: [
      {
        name: "approve",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" }
        ],
        outputs: [{ name: "", type: "bool" }]
      }
    ] as const,
    functionName: "approve",
    args: [VAULT_ADDRESS as `0x${string}`, amountInRaw],
    account,
    chain: sepolia
  });
  console.log(`Transaction d'approbation envoyée. Hash : ${approveTxHash}`);
  await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
  console.log("Approbation validée.");

  // 5. Dépôt préalable des tokens dans le contrat DarkPoolVault
  console.log("Étape 2: Dépôt des tokens dans le coffre...");
  const depositTxHash = await walletClient.writeContract({
    address: VAULT_ADDRESS as `0x${string}`,
    abi: [
      {
        name: "deposit",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" }
        ],
        outputs: []
      }
    ] as const,
    functionName: "deposit",
    args: [WETH_ADDRESS as `0x${string}`, amountInRaw],
    account,
    chain: sepolia
  });
  console.log(`Transaction de dépôt envoyée. Hash : ${depositTxHash}`);
  await publicClient.waitForTransactionReceipt({ hash: depositTxHash });
  console.log("Dépôt validé on-chain !");

  // 6. Soumission de l'ordre avec ses handles et ses preuves
  console.log("Étape 3: Soumission de l'ordre au Dark Pool...");
  const submitTxHash = await walletClient.writeContract({
    address: VAULT_ADDRESS as `0x${string}`,
    abi: [
      {
        name: "submitOrder",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountInExternal", type: "bytes32" },
          { name: "amountInProof", type: "bytes" },
          { name: "minAmountOutExternal", type: "bytes32" },
          { name: "minAmountOutProof", type: "bytes" }
        ],
        outputs: [{ name: "", type: "uint256" }]
      }
    ] as const,
    functionName: "submitOrder",
    args: [
      WETH_ADDRESS as `0x${string}`,
      USDC_ADDRESS as `0x${string}`,
      amountInHandle,
      amountInProof,
      minAmountOutHandle,
      minAmountOutProof
    ],
    account,
    chain: sepolia
  });
  console.log(`Ordre soumis. Hash transaction : ${submitTxHash}`);
  await publicClient.waitForTransactionReceipt({ hash: submitTxHash });
  console.log("Ordre validé on-chain avec succès !");
}

// Exemple d'exécution
createAndSubmitOrder().catch(console.error);
