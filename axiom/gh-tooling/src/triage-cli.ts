import { decide } from "./triage.ts";

let input = "";
for await (const chunk of process.stdin) {
	input += chunk;
}

process.stdout.write(`${JSON.stringify(decide(input, process.argv[2] ?? "opened"))}\n`);
