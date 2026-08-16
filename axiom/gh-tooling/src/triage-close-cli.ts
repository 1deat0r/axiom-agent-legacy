import { decideClose } from "./triage.ts";

let input = "";
for await (const chunk of process.stdin) {
	input += chunk;
}

process.stdout.write(`${JSON.stringify(decideClose(input))}\n`);
