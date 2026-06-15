import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import * as dotenv from "dotenv";
dotenv.config();

const PROVIDER_URL = process.env.SEPOLIA_PROVIDER_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const OLD_VAULT = "0x379a64Bd075b6F8969742BF39F846840B1267ECD";
const WETH_ADDRESS = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

if (!PRIVATE_KEY) {
  console.error("Missing DEPLOYER_PRIVATE_KEY");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const mainWallet = new ethers.Wallet(PRIVATE_KEY, provider);

const VAULT_ABI = [
  "function availableBalanceOf(address,address) view returns (bytes32)",
  "function lockedBalanceOf(address,address) view returns (bytes32)",
  "function nextOrderId() view returns (uint256)",
  "function orders(uint256) view returns (address owner, address tokenIn, address tokenOut, bytes32 amountIn, bytes32 minAmountOut, bytes32 lockedAmount, bool isSettled, uint256 salt)"
];

const STEALTH_DERIVATION_MESSAGE = (index) =>
  `DarkPool Nox — stealth key derivation v1 (index ${index})`;

async function deriveStealthWallet(wallet) {
  const signature = await wallet.signMessage(STEALTH_DERIVATION_MESSAGE(0));
  const privateKey = ethers.keccak256(ethers.getBytes(signature));
  return new ethers.Wallet(privateKey, provider);
}

async function main() {
  const stealthWallet = await deriveStealthWallet(mainWallet);
  const hcMain = await createEthersHandleClient(mainWallet);
  const hcStealth = await createEthersHandleClient(stealthWallet);

  const vault = new ethers.Contract(OLD_VAULT, VAULT_ABI, provider);

  console.log(`Main Wallet: ${mainWallet.address}`);
  console.log(`Stealth Wallet: ${stealthWallet.address}`);

  const checkBalances = async (wallet, hc, name, isStealth) => {
    console.log(`\n--- Balances for ${name} (${wallet.address}) ---`);
    const wethToken = isStealth ? "0x3664e88d2f6bDdfD185341e28085bfBc36686b92" : WETH_ADDRESS;
    const usdcToken = isStealth ? "0x8298C4f4B732371574a412FEB7e0f0bD17e53A1f" : USDC_ADDRESS;

    for (const [token, addr] of [["WETH", wethToken], ["USDC", usdcToken]]) {
      const availHandle = await vault.availableBalanceOf(wallet.address, addr);
      const lockedHandle = await vault.lockedBalanceOf(wallet.address, addr);
      
      let availVal = 0n;
      let lockedVal = 0n;

      if (availHandle !== ethers.ZeroHash && availHandle) {
        try {
          const res = await hc.decrypt(availHandle);
          availVal = BigInt(res.value);
        } catch (e) {
          console.log(`  Failed to decrypt avail handle ${availHandle}`);
        }
      }
      if (lockedHandle !== ethers.ZeroHash && lockedHandle) {
        try {
          const res = await hc.decrypt(lockedHandle);
          lockedVal = BigInt(res.value);
        } catch (e) {
          console.log(`  Failed to decrypt locked handle ${lockedHandle}`);
        }
      }

      console.log(`${token} Available: ${ethers.formatUnits(availVal, token === "WETH" ? 18 : 6)}`);
      console.log(`${token} Locked   : ${ethers.formatUnits(lockedVal, token === "WETH" ? 18 : 6)}`);
    }
  };

  await checkBalances(mainWallet, hcMain, "Main Wallet", false);
  await checkBalances(stealthWallet, hcStealth, "Stealth Wallet", true);

  // Check open orders
  console.log("\n--- Checking Orders ---");
  const nextId = await vault.nextOrderId();
  console.log(`Total orders in old vault: ${nextId.toString()}`);
  for (let i = 0; i < Number(nextId); i++) {
    const o = await vault.orders(i);
    console.log(`Order #${i}: Owner ${o.owner}, In ${o.tokenIn}, Out ${o.tokenOut}, Settled: ${o.isSettled}`);
  }
}

main().catch(console.error);
