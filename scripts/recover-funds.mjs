import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import * as dotenv from "dotenv";
dotenv.config();

const PROVIDER_URL = process.env.SEPOLIA_PROVIDER_URL || "";
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const VAULT_ADDRESS = "0x379a64Bd075b6F8969742BF39F846840B1267ECD";
const CWETH_ADDRESS = "0x3664e88d2f6bDdfD185341e28085bfBc36686b92";
const CUSDC_ADDRESS = "0x8298C4f4B732371574a412FEB7e0f0bD17e53A1f";
const WETH_ADDRESS = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

if (!PROVIDER_URL || !PRIVATE_KEY || !VAULT_ADDRESS) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const mainWallet = new ethers.Wallet(PRIVATE_KEY, provider);

const CTOKEN_ABI = [
  "function balanceOf(address) view returns (bytes32)",
  "function requestUnwrap(uint256) returns (uint256)",
  "function finalizeUnwrap(uint256,bytes)",
  "function nextUnwrapId() view returns (uint256)",
  "function unwrapRequests(uint256) view returns (address user, uint256 amount, bytes32 ok, bool finalized)",
  "event UnwrapRequested(uint256 indexed requestId, address indexed user, uint256 amount, bytes32 okHandle)"
];

const VAULT_ABI = [
  "function availableBalanceOf(address,address) view returns (bytes32)",
  "function lockedBalanceOf(address,address) view returns (bytes32)",
  "function withdrawConfidential(address,bytes32,bytes)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)"
];

const STEALTH_DERIVATION_MESSAGE = (index) =>
  `DarkPool Nox — stealth key derivation v1 (index ${index})`;

async function deriveStealthWallet(wallet) {
  const signature = await wallet.signMessage(STEALTH_DERIVATION_MESSAGE(0));
  const privateKey = ethers.keccak256(ethers.getBytes(signature));
  return new ethers.Wallet(privateKey, provider);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function recoverWalletFunds(wallet, handleClient, isStealth = false) {
  const name = isStealth ? "Stealth Wallet" : "Main Wallet";
  console.log(`\n--- Recovering funds for ${name} (${wallet.address}) ---`);

  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);
  const cweth = new ethers.Contract(CWETH_ADDRESS, CTOKEN_ABI, wallet);
  const cusdc = new ethers.Contract(CUSDC_ADDRESS, CTOKEN_ABI, wallet);

  // Helper to read and decrypt vault balance
  const getVaultBalance = async (fn, tokenAddress) => {
    const handle = await vault[fn](wallet.address, tokenAddress);
    if (handle === ethers.ZeroHash || !handle) return 0n;
    try {
      const res = await handleClient.decrypt(handle);
      return BigInt(res.value);
    } catch (e) {
      console.log(`  Failed to decrypt handle ${handle} (KMS gateway not synced?)`);
      return 0n;
    }
  };

  const wethToken = isStealth ? CWETH_ADDRESS : WETH_ADDRESS;
  const usdcToken = isStealth ? CUSDC_ADDRESS : USDC_ADDRESS;

  // 1. Check and withdraw WETH from vault
  const availWeth = await getVaultBalance("availableBalanceOf", wethToken);
  console.log(`Vault Available WETH: ${ethers.formatEther(availWeth)}`);
  if (availWeth > 0n) {
    console.log(`Withdrawing ${ethers.formatEther(availWeth)} WETH from vault confidentially...`);
    const { handle, handleProof } = await handleClient.encryptInput(availWeth, "uint256", VAULT_ADDRESS);
    const tx = await vault.withdrawConfidential(CWETH_ADDRESS, handle, handleProof);
    await tx.wait();
    console.log(`Withdrawn successfully.`);
  }

  // 2. Check and withdraw USDC from vault
  const availUsdc = await getVaultBalance("availableBalanceOf", usdcToken);
  console.log(`Vault Available USDC: ${ethers.formatUnits(availUsdc, 6)}`);
  if (availUsdc > 0n) {
    console.log(`Withdrawing ${ethers.formatUnits(availUsdc, 6)} USDC from vault confidentially...`);
    const { handle, handleProof } = await handleClient.encryptInput(availUsdc, "uint256", VAULT_ADDRESS);
    const tx = await vault.withdrawConfidential(CUSDC_ADDRESS, handle, handleProof);
    await tx.wait();
    console.log(`Withdrawn successfully.`);
  }

  // Helper to read and decrypt wrapper balance
  const getWrapperBalance = async (cToken) => {
    const handle = await cToken.balanceOf(wallet.address);
    if (handle === ethers.ZeroHash || !handle) return 0n;
    try {
      const res = await handleClient.decrypt(handle);
      return BigInt(res.value);
    } catch (e) {
      console.log(`  Failed to decrypt wrapper handle ${handle}`);
      return 0n;
    }
  };

  // Helper to unwrap from wrapper to public
  const unwrapConfidential = async (cToken, amount, tokenName) => {
    const formattedAmount = tokenName.toLowerCase().includes("usdc")
      ? ethers.formatUnits(amount, 6)
      : ethers.formatEther(amount);
    console.log(`Unwrapping ${formattedAmount} ${tokenName}...`);
    const unwrapId = await cToken.nextUnwrapId();
    const tx = await cToken.requestUnwrap(amount);
    const receipt = await tx.wait();

    // Find the UnwrapRequested event log
    let okHandle = null;
    for (const log of receipt.logs) {
      try {
        const parsed = cToken.interface.parseLog(log);
        if (parsed && parsed.name === "UnwrapRequested") {
          okHandle = parsed.args.okHandle;
          break;
        }
      } catch (e) {}
    }

    if (!okHandle) {
      console.error("UnwrapRequested event not found in tx logs.");
      return;
    }

    // Wait and request public decryption proof from KMS
    let decryptionProof = null;
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        const res = await handleClient.publicDecrypt(okHandle);
        decryptionProof = res.decryptionProof;
        break;
      } catch (e) {
        console.log(`  Waiting for public decryption proof, attempt ${attempt}/10...`);
        await sleep(10000);
      }
    }

    if (!decryptionProof) {
      console.error("Could not obtain decryption proof from KMS.");
      return;
    }

    // Finalize unwrap
    console.log(`Finalizing unwrap for ID ${unwrapId.toString()}...`);
    const finalTx = await cToken.finalizeUnwrap(unwrapId, decryptionProof);
    await finalTx.wait();
    console.log(`Unwrapped successfully!`);
  };

  // 3. Check and unwrap cWETH
  const cWethBal = await getWrapperBalance(cweth);
  console.log(`Wrapper cWETH Balance: ${ethers.formatEther(cWethBal)}`);
  if (cWethBal > 0n) {
    await unwrapConfidential(cweth, cWethBal, "cWETH");
  }

  // 4. Check and unwrap cUSDC
  const cUsdcBal = await getWrapperBalance(cusdc);
  console.log(`Wrapper cUSDC Balance: ${ethers.formatUnits(cUsdcBal, 6)}`);
  if (cUsdcBal > 0n) {
    await unwrapConfidential(cusdc, cUsdcBal, "cUSDC");
  }
}

async function main() {
  console.log("Initializing Ethers KMS clients...");
  const hcMain = await createEthersHandleClient(mainWallet);

  // Recover Main Wallet funds
  await recoverWalletFunds(mainWallet, hcMain, false);

  // Derive and recover Stealth Wallet funds (and send them to main wallet)
  console.log("\nDeriving stealth wallet...");
  const stealthWallet = await deriveStealthWallet(mainWallet);

  // Send ETH from Main to Stealth wallet for gas fee BEFORE doing anything else
  const stealthBalance = await provider.getBalance(stealthWallet.address);
  console.log(`Stealth Wallet (${stealthWallet.address}) ETH balance: ${ethers.formatEther(stealthBalance)} ETH`);
  if (stealthBalance < ethers.parseEther("0.02")) {
    const amountToSend = ethers.parseEther("0.02") - stealthBalance;
    console.log(`Funding Stealth Wallet with ${ethers.formatEther(amountToSend)} ETH from Main Wallet for gas...`);
    try {
      const tx = await mainWallet.sendTransaction({
        to: stealthWallet.address,
        value: amountToSend
      });
      await tx.wait();
      console.log("Stealth Wallet funded.");
    } catch (err) {
      console.error("Failed to fund Stealth Wallet from Main Wallet:", err);
    }
  }

  const hcStealth = await createEthersHandleClient(stealthWallet);
  await recoverWalletFunds(stealthWallet, hcStealth, true);

  // If the stealth wallet ended up with WETH/USDC after unwrap, send them to the main wallet
  const weth = new ethers.Contract(WETH_ADDRESS, ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"], stealthWallet);
  const usdc = new ethers.Contract(USDC_ADDRESS, ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"], stealthWallet);

  const wethBal = await weth.balanceOf(stealthWallet.address);
  if (wethBal > 0n) {
    console.log(`Sending ${ethers.formatEther(wethBal)} WETH from Stealth to Main wallet...`);
    const tx = await weth.transfer(mainWallet.address, wethBal);
    await tx.wait();
    console.log("Transferred.");
  }

  const usdcBal = await usdc.balanceOf(stealthWallet.address);
  if (usdcBal > 0n) {
    console.log(`Sending ${ethers.formatUnits(usdcBal, 6)} USDC from Stealth to Main wallet...`);
    const tx = await usdc.transfer(mainWallet.address, usdcBal);
    await tx.wait();
    console.log("Transferred.");
  }

  // Send remaining ETH back to main wallet
  const remainingStealthEth = await provider.getBalance(stealthWallet.address);
  if (remainingStealthEth > ethers.parseEther("0.002")) {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits("10", "gwei");
    const gasLimit = 21000n;
    const txFee = gasPrice * gasLimit;
    if (remainingStealthEth > txFee) {
      const ethToSendBack = remainingStealthEth - txFee;
      console.log(`Sending remaining ${ethers.formatEther(ethToSendBack)} ETH from Stealth to Main wallet...`);
      try {
        const tx = await stealthWallet.sendTransaction({
          to: mainWallet.address,
          value: ethToSendBack,
          gasLimit,
          gasPrice
        });
        await tx.wait();
        console.log("ETH transferred back successfully.");
      } catch (err) {
        console.error("Failed to transfer remaining ETH back:", err.message);
      }
    }
  }

  // Print final public balances of Main Wallet
  const finalWeth = await new ethers.Contract(WETH_ADDRESS, ERC20_ABI, mainWallet).balanceOf(mainWallet.address);
  const finalUsdc = await new ethers.Contract(USDC_ADDRESS, ERC20_ABI, mainWallet).balanceOf(mainWallet.address);
  const finalEth = await provider.getBalance(mainWallet.address);

  console.log("\n=== RECOVERY COMPLETE ===");
  console.log(`Main Wallet ETH : ${ethers.formatEther(finalEth)} ETH`);
  console.log(`Main Wallet WETH: ${ethers.formatEther(finalWeth)} WETH`);
  console.log(`Main Wallet USDC: ${ethers.formatUnits(finalUsdc, 6)} USDC`);
}

main().catch(console.error);
