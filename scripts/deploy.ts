import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const enclavePrivateKey = process.env.ENCLAVE_PRIVATE_KEY;
  if (!enclavePrivateKey) {
    throw new Error("ENCLAVE_PRIVATE_KEY is not defined in .env");
  }

  // Déduire l'adresse de l'enclave à partir de sa clé privée
  const enclaveWallet = new ethers.Wallet(enclavePrivateKey);
  const enclaveAddress = enclaveWallet.address;
  console.log(`Adresse du signataire d'enclave dérivée : ${enclaveAddress}`);

  const [deployer] = await ethers.getSigners();
  console.log(`Déploiement du contrat avec le compte : ${deployer.address}`);
  console.log(`Solde du compte : ${(await ethers.provider.getBalance(deployer.address)).toString()} wei`);

  console.log("Déploiement de DarkPoolVault...");
  const DarkPoolVault = await ethers.getContractFactory("DarkPoolVault");
  const vault = await DarkPoolVault.deploy(enclaveAddress);

  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  console.log(`DarkPoolVault déployé avec succès à l'adresse : ${vaultAddress}`);
  console.log(`Veuillez mettre à jour la variable VAULT_ADDRESS dans votre fichier .env :`);
  console.log(`VAULT_ADDRESS=${vaultAddress}`);

  // P0.3 — wrappers de tokens confidentiels (si les sous-jacents sont fournis)
  const wrappers: { symbol: string; address: string }[] = [];
  const candidates = [
    { env: "WETH_ADDRESS", name: "Confidential WETH", symbol: "cWETH", decimals: 18 },
    { env: "USDC_ADDRESS", name: "Confidential USDC", symbol: "cUSDC", decimals: 6 },
  ];
  for (const c of candidates) {
    const underlying = process.env[c.env];
    if (!underlying) continue;
    console.log(`Déploiement de ${c.symbol} (wrapper de ${underlying})...`);
    const ConfidentialToken = await ethers.getContractFactory("ConfidentialToken");
    const cToken = await ConfidentialToken.deploy(underlying, c.name, c.symbol, c.decimals);
    await cToken.waitForDeployment();
    const cTokenAddress = await cToken.getAddress();
    wrappers.push({ symbol: c.symbol, address: cTokenAddress });
    console.log(`${c.symbol} déployé à l'adresse : ${cTokenAddress}`);
  }
  if (wrappers.length > 0) {
    console.log(`\nVeuillez ajouter/mettre à jour dans votre .env :`);
    for (const w of wrappers) {
      console.log(`${w.symbol.toUpperCase()}_ADDRESS=${w.address}`);
    }
    console.log(`CTOKEN_ADDRESSES=${wrappers.map(w => w.address).join(",")}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
