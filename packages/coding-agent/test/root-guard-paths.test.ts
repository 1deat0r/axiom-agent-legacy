import { describe, expect, it } from "vitest";
import { extractCandidatePaths } from "../src/core/root-guard/paths.js";

describe("extractCandidatePaths (pure extraction)", () => {
	it("finds absolute paths in a plain command", () => {
		expect(extractCandidatePaths("cat /etc/passwd")).toEqual(["/etc/passwd"]);
	});

	it("finds absolute paths after redirects and flags", () => {
		expect(extractCandidatePaths("ls -la > /tmp/out.log 2>/dev/null")).toEqual(["/tmp/out.log", "/dev/null"]);
	});

	it("finds absolute paths inside quotes (shell and python)", () => {
		expect(extractCandidatePaths('grep x "/etc/hosts"')).toEqual(["/etc/hosts"]);
		expect(extractCandidatePaths(`open("/etc/hosts", "r")`)).toEqual(["/etc/hosts"]);
	});

	it("finds multiple paths and dedupes in order", () => {
		expect(extractCandidatePaths("cp /usr/bin/a /tmp/b /usr/bin/a")).toEqual(["/usr/bin/a", "/tmp/b"]);
	});

	it("strips shell and python comments before extraction", () => {
		expect(extractCandidatePaths("ls # /etc/passwd\ncat /tmp/x")).toEqual(["/tmp/x"]);
		expect(extractCandidatePaths("# open('/etc/passwd')\nprint(1)")).toEqual([]);
	});

	it("finds tilde tokens", () => {
		expect(extractCandidatePaths("cd ~/src && cat ~/notes.txt")).toEqual(["~/src", "~/notes.txt"]);
		expect(extractCandidatePaths("cd ~")).toEqual(["~"]);
		expect(extractCandidatePaths("cat ~bob/file")).toEqual(["~bob/file"]);
	});

	it("finds relative tokens that carry a slash or a dot segment", () => {
		expect(extractCandidatePaths("cat src/a.ts ./b.ts")).toEqual(["src/a.ts", "./b.ts"]);
		expect(extractCandidatePaths("cat ../outside/x")).toEqual(["../outside/x"]);
		expect(extractCandidatePaths("cd ..")).toEqual([".."]);
		expect(extractCandidatePaths("cd .")).toEqual([]);
		expect(extractCandidatePaths("cd ../..")).toEqual(["../.."]);
	});

	it("finds absolute paths after git -C and env assignments", () => {
		expect(extractCandidatePaths("git -C /other/repo status")).toEqual(["/other/repo"]);
		expect(extractCandidatePaths("P=/tmp/x; echo $P")).toEqual(["/tmp/x"]);
	});

	it("finds globbed absolute paths", () => {
		expect(extractCandidatePaths("rm /tmp/*.log")).toEqual(["/tmp/*.log"]);
	});

	it("finds paths in backticks and bash cells inside ipython code", () => {
		expect(extractCandidatePaths("echo `cat /tmp/x`")).toEqual(["/tmp/x"]);
		expect(extractCandidatePaths("%%bash\ncat /etc/shadow")).toEqual(["/etc/shadow"]);
	});

	it("does not treat URLs as absolute paths", () => {
		expect(extractCandidatePaths("curl https://example.com/a/b").some((t) => t.startsWith("/"))).toBe(false);
		expect(extractCandidatePaths("open('https://example.com/a/b')").some((t) => t.startsWith("/"))).toBe(false);
	});

	it("does not extract pure shell-variable indirection (documented gap)", () => {
		expect(extractCandidatePaths("cat $HOME/.config/x")).toEqual([]);
		expect(extractCandidatePaths("open(os.environ['SECRET'])")).toEqual([]);
	});

	it("extracts a literal path suffix even next to a variable (conservative)", () => {
		expect(extractCandidatePaths("open(os.environ['HOME'] + '/x')")).toEqual(["/x"]);
	});

	it("splits f-string interpolation at braces", () => {
		expect(extractCandidatePaths(`open(f"/etc/{name}")`)).toEqual(["/etc/"]);
	});
});

describe("bare-root token vs arithmetic operators (rounds 9-10)", () => {
	it("does not extract the division operator from spaced arithmetic", () => {
		expect(extractCandidatePaths("x = a / b")).toEqual([]);
		expect(extractCandidatePaths("print(total / count)")).toEqual([]);
		expect(extractCandidatePaths("x = a / (b)")).toEqual([]);
		expect(extractCandidatePaths("x = a/ b")).toEqual([]);
		expect(extractCandidatePaths("x = a / 2")).toEqual([]);
		expect(extractCandidatePaths("x = a / 2.5")).toEqual([]);
		expect(extractCandidatePaths("cat / $x")).toEqual([]);
	});

	it("still extracts the destructive bare-root forms", () => {
		expect(extractCandidatePaths("cd /")).toEqual(["/"]);
		expect(extractCandidatePaths("rm -rf /")).toEqual(["/"]);
		expect(extractCandidatePaths("cat / ")).toEqual(["/"]);
		expect(extractCandidatePaths("rm -rf / && echo done")).toEqual(["/"]);
		expect(extractCandidatePaths("rm -rf / | tee x")).toEqual(["/"]);
		expect(extractCandidatePaths("cd /; ls")).toEqual(["/"]);
		expect(extractCandidatePaths("rm -rf / --no-preserve-root")).toEqual(["/"]);
		expect(extractCandidatePaths("sudo rm -rf / --no-preserve-root")).toEqual(["/"]);
		expect(extractCandidatePaths("rm -rf /'")).toEqual(["/"]);
		expect(extractCandidatePaths("rm -rf '/'")).toEqual(["/"]);
		expect(extractCandidatePaths("rm -rf /{foo,bar}")).toEqual(["/"]);
		// extractor passes run per pattern (ABSOLUTE before BARE_ROOT), so the
		// redirect operand precedes the bare root — both are extracted.
		expect(extractCandidatePaths("rm -rf / 2>/dev/null")).toEqual(["/dev/null", "/"]);
		expect(extractCandidatePaths("rm -rf /\necho ok")).toEqual(["/"]);
		expect(extractCandidatePaths("ls / /tmp")).toEqual(["/tmp", "/"]);
	});

	it("documents the accepted trade-offs", () => {
		// `cat / b` reads the bare root as an infix operand and misses it.
		expect(extractCandidatePaths("cat / b")).toEqual([]);
		// `a / -1` reads the unary minus as an argument, so it over-blocks.
		expect(extractCandidatePaths("x = a / -1")).toEqual(["/"]);
	});
});
