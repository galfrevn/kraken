import { copilotDeviceCodeFlow } from "@/provider/copilot.ts";

async function main() {
  console.log("GitHub Copilot Login\n");
  console.log("This will authenticate Kraken with your GitHub Copilot subscription.\n");

  try {
    const token = await copilotDeviceCodeFlow();
    console.log(`\nAuthenticated successfully. Token saved to ~/.kraken/auth.json`);
    console.log(`Token prefix: ${token.slice(0, 8)}...`);
  } catch (error) {
    console.error(`\nAuthentication failed: ${error}`);
    process.exit(1);
  }
}

main();
