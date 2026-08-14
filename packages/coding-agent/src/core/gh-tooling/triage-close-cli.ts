import { decideClose } from "./triage.js";

let input = "";
for await (const chunk of process.stdin) {
	input += chunk;
}

process.stdout.write(`${JSON.stringify(decideClose(input))}\n`);
