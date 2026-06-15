const { ethers } = require("hardhat");
const dotenv = require("dotenv");
dotenv.config();

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS;
  console.log("Vault address:", vaultAddress);
  
  const vault = await ethers.getContractAt([
    "function nextOrderId() view returns (uint256)",
    "function orders(uint256) view returns (address owner, address tokenIn, address tokenOut, bytes32 amountInHandle, bytes32 minAmountOutHandle, bytes32 lockedAmountHandle, bytes32 solvencyOkHandle, bool isSettled)",
    "event MatchSettled(uint256 indexed orderId1, uint256 indexed orderId2, address user1, address user2, address token1, address token2)"
  ], vaultAddress);

  const nextOrderId = await vault.nextOrderId();
  console.log("Next Order ID:", nextOrderId.toString());

  console.log("\n--- Orders Status ---");
  for (let i = 0; i < Number(nextOrderId); i++) {
    const o = await vault.orders(i);
    console.log(`Order #${i}: Owner ${o.owner}, Settled: ${o.isSettled}`);
  }

  // Let's query the MatchSettled events
  const filter = vault.filters.MatchSettled();
  const events = await vault.queryFilter(filter, -5000); // last 5000 blocks
  console.log(`\nFound ${events.length} MatchSettled events in the last 5000 blocks:`);
  for (const event of events) {
    console.log(`Match: Order ${event.args.orderId1.toString()} and Order ${event.args.orderId2.toString()} settled between ${event.args.user1} and ${event.args.user2}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
