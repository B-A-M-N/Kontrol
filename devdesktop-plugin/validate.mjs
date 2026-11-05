// Validator for the devdesktop skill-only update archive. Read-only; exits non-zero on any failure.
import { readFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const ROOT = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const EXPECTED_NAME = "dev-6a526f280aec81919bd3c5c6b9ad5a15";
const EXPECTED_APP_ID = "asdk_app_6a526f280aec81919bd3c5c6b9ad5a15";
const EXPECTED_SKILLS = [
  "kontrol-workspace-review",
  "nelson-wiggum-loop",
  "ralphie-muntz-loop",
  "kontrol-supervised-mission",
  "kontrol-acp-harness",
  "kontrol-pty-messaging",
  "kontrol-review-thread",
];

// 1. Both manifests parse
let portable, legacy;
try { portable = JSON.parse(readFileSync(join(ROOT, "plugin.json"), "utf8")); check("portable plugin.json parses", true); }
catch (e) { check("portable plugin.json parses", false, String(e)); }
try { legacy = JSON.parse(readFileSync(join(ROOT, ".codex-plugin/plugin.json"), "utf8")); check("legacy .codex-plugin/plugin.json parses", true); }
catch (e) { check("legacy .codex-plugin/plugin.json parses", false, String(e)); }

// 2. Name/version agreement, no rename, semver bump shape
if (portable && legacy) {
  check("manifest names preserved (no rename)", portable.name === EXPECTED_NAME && legacy.name === EXPECTED_NAME, `portable=${portable.name} legacy=${legacy.name}`);
  check("manifest versions agree", portable.version === legacy.version, `${portable.version} vs ${legacy.version}`);
  check("version is semver bump to 1.0.2", /^\d+\.\d+\.\d+$/.test(portable.version) && portable.version === "1.0.2", portable.version);
  check("portable keeps app declaration", portable?.extensions?.["com.openai"]?.apps === "./.app.json", JSON.stringify(portable?.extensions));
  check("legacy keeps skills+apps pointers", legacy.skills === "./skills/" && legacy.apps === "./.app.json", `skills=${legacy.skills} apps=${legacy.apps}`);
  check("no second MCP server config", !portable.mcpServers && !portable.mcp && !legacy.mcpServers && !legacy.mcp, "none declared");
  check("descriptions within limit", (portable.description?.length ?? 9999) <= 4000 && portable.description === legacy.description, `${portable.description?.length}`);
}

// 3. Skills: discovery, uniqueness, frontmatter, no symlinks
const skillDirs = existsSync(join(ROOT, "skills")) ? readdirSync(join(ROOT, "skills")) : [];
check("all 7 skills present, none extra", EXPECTED_SKILLS.every((s) => skillDirs.includes(s)) && skillDirs.length === EXPECTED_SKILLS.length, skillDirs.join(","));
const seenNames = new Set();
for (const s of EXPECTED_SKILLS) {
  const dir = join(ROOT, "skills", s);
  const fp = join(dir, "SKILL.md");
  check(`skill dir ${s} is real dir, not symlink`, existsSync(dir) && !lstatSync(dir).isSymbolicLink());
  let body = "";
  try { body = readFileSync(fp, "utf8"); check(`skill file ${s}/SKILL.md readable`, true); }
  catch (e) { check(`skill file ${s}/SKILL.md readable`, false, String(e)); continue; }
  const m = body.match(/^---\n([\s\S]*?)\n---\n/);
  check(`skill ${s} has YAML frontmatter`, !!m);
  if (m) {
    const fm = m[1];
    const name = (fm.match(/^name:\s*(.+)$/m) || [])[1]?.trim();
    const desc = (fm.match(/^description:\s*(.+)$/m) || [])[1]?.trim();
    check(`skill ${s} frontmatter name matches dir`, name === s, `name=${name}`);
    check(`skill ${s} frontmatter description non-empty`, !!desc && desc.length > 10, `${desc?.length} chars`);
    if (name) { check(`skill name ${name} unique`, !seenNames.has(name)); seenNames.add(name); }
  }
}

// 4. Content negatives: stale tool refs, invented capabilities, secrets, weakened authority
const STALE = ["cli-coding-agent\" | `agent`", "MUSE_EXPERIMENTAL_SDK_ENABLED", "password", "api_key", "apiKey", "client_secret", "BEGIN PRIVATE KEY"];
const allBodies = EXPECTED_SKILLS.map((s) => { try { return readFileSync(join(ROOT, "skills", s, "SKILL.md"), "utf8"); } catch { return ""; } }).join("\n");
for (const pat of STALE) check(`negative: no ${JSON.stringify(pat)} in skills`, !allBodies.includes(pat));
check("negative: no tool auto-creation promise", !/auto-?creat\w*\s+(a\s+)?(new\s+)?(ChatGPT\s+)?conversation/i.test(allBodies.replace(/cannot.*create|never.*create|no tool auto-creates/gi, "")));
check("negative: skills do not weaken PTY scope", !/post_agent_message.*PTY review credential|over.*PTY.*credential.*post/i.test(allBodies));
check("negative: no polling instruction", !/every N seconds|poll .* every \d/i.test(allBodies.replace(/never an N-second polling loop|when someone suggests polling[^.\n]*\(don't\)|\(don't\)/gi, "")));

// 5. No unrelated files, no nested plugin, no archives-within
const topLevel = readdirSync(ROOT);
check("top level is plugin layout + tooling + versioned archive only", topLevel.every((e) => ["plugin.json", ".codex-plugin", "skills", "REPORT.md", "validate.mjs", ".app.json"].includes(e) || /^devdesktop-plugin-update-\d+\.\d+\.\d+\.zip$/.test(e)), topLevel.join(","));
check("no nested plugin.json under skills", !EXPECTED_SKILLS.some((s) => existsSync(join(ROOT, "skills", s, "plugin.json"))));
let appJson = null;
try { appJson = JSON.parse(readFileSync(join(ROOT, ".app.json"), "utf-8")); check(".app.json parses as UTF-8 JSON", true); } catch (e) { check(".app.json parses as UTF-8 JSON", false, String(e)); }
check(".app.json binds plugin name to App ID", appJson?.apps?.[EXPECTED_NAME]?.id === EXPECTED_APP_ID, JSON.stringify(appJson));

process.exit(failures ? 1 : 0);
