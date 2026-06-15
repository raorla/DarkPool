require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const SEPOLIA_PROVIDER_URL = process.env.SEPOLIA_PROVIDER_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

module.exports = {
  solidity: {
    version: "0.8.35",
    settings: {
      viaIR: true,
      evmVersion: "cancun", // requis par OpenZeppelin 5.x (mcopy) — supporté par Sepolia
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {},
    sepolia: {
      url: SEPOLIA_PROVIDER_URL,
      accounts: [DEPLOYER_PRIVATE_KEY],
    },
  },
};
