import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const PROVIDER_URL = process.env.SEPOLIA_PROVIDER_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const CWETH_ADDRESS = "0x9901b7Ffb491035b4068f167CaEfd6DB038B63de";
const CUSDC_ADDRESS = "0xad6a8Ffa9Cd1d3432557fD281bf1C41Cf95ff3EA";

const provider = new ethers.JsonRpcProvider(PROVIDER_URL);

const CTOKEN_ABI = [
  "event ConfidentialTransfer(address indexed from, address indexed to)",
  "function balanceOf(address) view returns (bytes32)"
];

async function main() {
  const checkToken = async (address, symbol) => {
    console.log(`\nChecking ConfidentialTransfer events on ${symbol} (${address})...`);
    const ctoken = new ethers.Contract(address, CTOKEN_ABI, provider);
    const filter = ctoken.filters.ConfidentialTransfer();
    const events = await ctoken.queryFilter(filter, -1000); // last 1000 blocks
    
    console.log(`Found ${events.length} ConfidentialTransfer events:`);
    for (const event of events) {
      console.log(`- Transfer from ${event.args.from} to ${event.args.to} (Tx: ${event.transactionHash})`);
    }
  };

  await checkToken(CWETH_ADDRESS, "cWETH");
  await checkToken(CUSDC_ADDRESS, "cUSDC");
}

main().catch(console.error);
