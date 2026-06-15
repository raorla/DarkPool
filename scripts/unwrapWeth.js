import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

const PROVIDER_URL = process.env.SEPOLIA_PROVIDER_URL || "";
const ENCLAVE_PRIVATE_KEY = process.env.ENCLAVE_PRIVATE_KEY || "";
const WETH_ADDRESS = process.env.WETH_ADDRESS || "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

if (!PROVIDER_URL || !ENCLAVE_PRIVATE_KEY) {
  console.error("Missing SEPOLIA_PROVIDER_URL or ENCLAVE_PRIVATE_KEY in .env");
  process.exit(1);
}

const WETH_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function withdraw(uint256 wad) external",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
  const wallet = new ethers.Wallet(ENCLAVE_PRIVATE_KEY, provider);
  const weth = new ethers.Contract(WETH_ADDRESS, WETH_ABI, wallet);

  const ethBalanceBefore = await provider.getBalance(wallet.address);
  const wethBalanceBefore = await weth.balanceOf(wallet.address);

  console.log("=== Avant l'unwrap ===");
  console.log("Solde ETH  :", ethers.formatEther(ethBalanceBefore), "ETH");
  console.log("Solde WETH :", ethers.formatEther(wethBalanceBefore), "WETH");

  const unwrapAmount = ethers.parseEther("0.8");

  if (wethBalanceBefore < unwrapAmount) {
    console.error(`Erreur: Solde WETH insuffisant pour retirer ${ethers.formatEther(unwrapAmount)} WETH.`);
    process.exit(1);
  }

  console.log(`\nRetrait de ${ethers.formatEther(unwrapAmount)} WETH en ETH natif...`);
  const tx = await weth.withdraw(unwrapAmount);
  console.log("Transaction envoyée. Hash:", tx.hash);
  await tx.wait();

  const ethBalanceAfter = await provider.getBalance(wallet.address);
  const wethBalanceAfter = await weth.balanceOf(wallet.address);

  console.log("\n=== Après l'unwrap ===");
  console.log("Solde ETH  :", ethers.formatEther(ethBalanceAfter), "ETH");
  console.log("Solde WETH :", ethers.formatEther(wethBalanceAfter), "WETH");
}

main().catch(console.error);
