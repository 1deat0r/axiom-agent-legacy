import { decide } from "./triage.js";

let input = "";
for await (const chunk of process.stdin) {
	input += chunk;
}

process.stdout.write(`${JSON.stringify(decide(input, process.argv[2] ?? "opened"))}\n`);
