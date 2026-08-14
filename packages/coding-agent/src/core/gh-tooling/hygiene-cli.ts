import { decideSweep } from "./hygiene.js";

let input = "";
for await (const chunk of process.stdin) {
	input += chunk;
}

process.stdout.write(`${JSON.stringify(decideSweep(input))}\n`);
