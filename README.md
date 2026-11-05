# DarkPool

**A decentralized dark pool for Ethereum: orders stay encrypted, matching happens inside a hardware enclave, and neither the amount nor the trader shows up on-chain.**

![Solidity](https://img.shields.io/badge/Solidity-363636?style=flat-square&logo=solidity&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![TEE](https://img.shields.io/badge/TEE-Intel%20TDX-0071C5?style=flat-square&logo=intel&logoColor=white)
![Network](https://img.shields.io/badge/network-Sepolia-3C3C3D?style=flat-square&logo=ethereum&logoColor=white)
![Tests](https://img.shields.io/badge/tests-47%20passing-2ea44f?style=flat-square)

> 🇫🇷 Version française : [README.fr.md](./README.fr.md)

---

## Why

On public blockchains every order, balance and trading intent is visible. Traders lose money to front-running bots (MEV), and anyone can follow a wallet's strategy. In traditional finance, dark pools handle 10 to 15 % of equity volume for exactly this reason. In DeFi, that volume is close to zero.

DarkPool is an MVP that brings private order matching to Ethereum, using **iExec Nox** confidential computing (TEE on Intel TDX, plus a decentralized KMS).

## How it works

1. **The order is encrypted on the client** with the enclave's public key (ECIES). It never travels in clear text, on the network or on-chain.
2. **The matching engine runs inside a TEE.** The order book and limit prices only exist in protected memory.
3. **Settlement happens on-chain** in the `DarkPoolVault` contract, from a signature produced by the enclave.
4. **Deposits and withdrawals are confidential:** a `ConfidentialToken` wrapper (cWETH, cUSDC) moves encrypted amounts (`euint256`), so no amount appears on Etherscan. Unwrapping back to the public ERC-20 is finalized with a KMS decryption proof verified on-chain.
5. **Stealth trading:** throwaway addresses derived deterministically from the main wallet, plus gasless meta-transactions sent through a relayer. The stealth address never holds ETH and the main wallet never appears on the trading side.

> The confidential wrapper hides the **how much**. The stealth address and relayer hide the **who**.

## Security

- **Replay protection:** enclave settlement signatures include the target `chainId` and the vault address, and every match is stored under a unique salted hash.
- **Reentrancy protection** on the vault.
- **Solvency checks:** balances are debited transactionally with Solidity's checked arithmetic, which reverts on insufficient funds.

## Project layout

```text
contracts/
  DarkPoolVault.sol       main vault and settlement (v3.2)
  ConfidentialToken.sol   confidential token wrapper (cWETH / cUSDC)
src/
  client/index.ts         CLI that encrypts and submits orders
  client/stealth.ts       stealth addresses and meta-transaction signatures
  enclave/index.ts        confidential matching engine (TEE)
  relayer/index.ts        HTTP relayer for meta-transactions (pays the gas)
  frontend/               Web3 dashboard
test/                     Hardhat tests (vault, confidential flows)
scripts/                  deploy and end-to-end Sepolia scenarios
```

## Quick start

```bash
npm install
cp .env.example .env         # Sepolia RPC, signer key, enclave ECIES keys, vault address
npx hardhat compile
npm test                     # Hardhat tests
npm run dev                  # Web3 dashboard on http://localhost:5173 (MetaMask on Sepolia)
npm run enclave              # confidential matching engine
npm run relayer              # gasless relayer for stealth trading
```

The full confidential scenario runs against Sepolia with `npm run build && npm run e2e:confidential`: wrap, confidential transfer to the stealth address, relayed deposit and order, match by the enclave, synchronous confidential withdrawal, then unwrap with a KMS proof verified on-chain.

## Status

MVP on the Sepolia testnet. Not audited, do not use with real funds.
