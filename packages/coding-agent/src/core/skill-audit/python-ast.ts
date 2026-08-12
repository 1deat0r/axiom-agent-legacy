import { spawnSync } from "node:child_process";
import type { AuditFinding } from "./types.js";

/**
 * A self-contained Python AST analyzer. It parses the source with the real
 * `ast` module and walks it, flagging dangerous constructs (subprocess, dynamic
 * code, network egress, file mutation, secret reads, sensitive imports). The
 * same script is reused verbatim by tests that pin its behavior.
 */
export const PYTHON_AST_ANALYZER = `
import ast, json, sys
BLOCK_CALLS=("eval","exec","compile","__import__")
NET_MODS=("socket","requests","urllib","http","smtplib","ftplib","paramiko","aiohttp","httpx")
SENSITIVE_IMPORTS=("subprocess","socket","smtplib","ftplib","paramiko","requests","urllib","pickle","marshal","importlib")
WRITE_METHODS=("write_text","write_bytes","unlink","rmdir")
def walk(path, src):
    findings=[]
    try:
        tree=ast.parse(src)
    except SyntaxError as e:
        findings.append({"severity":"block","rule":"syntax","evidence":"syntax error: %s" % e,"path":path,"line":getattr(e,'lineno',None)})
        return findings
    def add(sev,rule,evidence,n): findings.append({"severity":sev,"rule":rule,"evidence":evidence,"path":path,"line":getattr(n,'lineno',None)})
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f=node.func
            if isinstance(f, ast.Name) and f.id in BLOCK_CALLS:
                add("block","dynamic-code","call to %s()" % f.id,node)
            elif isinstance(f, ast.Attribute):
                chain=ast.unparse(f.value) if hasattr(ast,"unparse") else ""
                mod=chain.split(".")[0] if chain else ""
                attr=f.attr
                if attr in ("system","popen","run","Popen","call","execv","execve","spawn","rmtree","remove","unlink"):
                    add("block","dangerous-call","call %s.%s()" % (chain,attr),node)
                elif mod in NET_MODS or attr == "urlopen":
                    sev="warn" if attr in ("get","urlopen","request") else "block"
                    add(sev,"network","network call %s.%s()" % (chain,attr),node)
                elif attr in WRITE_METHODS:
                    add("warn","file-mutation","file mutation %s.%s()" % (chain,attr),node)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            names = node.names if isinstance(node, ast.Import) else [(node.module or "").split(".")[0]]
            for a in names:
                m=(a.name if isinstance(a, ast.alias) else a).split(".")[0]
                if m in SENSITIVE_IMPORTS:
                    add("warn","sensitive-import","import %s" % m,node)
        if isinstance(node, ast.Attribute) and node.attr in ("environ","getenv","getpass"):
            add("warn","secret-read","reads secrets via .%s" % node.attr,node)
    return findings
print(json.dumps({"path":sys.argv[1],"findings":walk(sys.argv[1],sys.stdin.read())}))
`;

export interface PythonAstResult {
	findings: AuditFinding[];
	available: boolean;
}

/**
 * Run the Python AST analyzer over `source`. Returns `available: false` when
 * the python3 binary is missing or the subprocess fails, so the caller can fall
 * back to structural scanning. All other outcomes carry the parsed findings.
 */
export function analyzePythonAst(path: string, source: string, pythonBinary: string = "python3"): PythonAstResult {
	const result = spawnSync(pythonBinary, ["-c", PYTHON_AST_ANALYZER, path], {
		input: source,
		encoding: "utf8",
		timeout: 15_000,
	});
	if (result.error || result.status !== 0 || !result.stdout) {
		return { findings: [], available: false };
	}
	let parsed: { path?: string; findings?: AuditFinding[] };
	try {
		parsed = JSON.parse(result.stdout) as { path?: string; findings?: AuditFinding[] };
	} catch {
		return { findings: [], available: false };
	}
	return { findings: parsed.findings ?? [], available: true };
}
