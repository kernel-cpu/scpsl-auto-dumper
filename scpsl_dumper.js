/*
 * auto-dump.js
 * by Kernel
 *
 * il2cpp metadata patcher + auto dumper
 * usage: node auto-dump.js
 */

const fs = require("fs");
const path = require("path");
const { spawnSync, execSync } = require("child_process");
const readline = require("readline");

const DUMPER_DIR = path.join(__dirname, "il2cpp_dumper");
const DUMPS_DIR = path.join(__dirname, "dumps");

const META_CANDIDATES = [
  path.join("SCPSL_Data", "il2cpp_data", "Metadata", "global-metadata.dat"),
  path.join(
    "SCP Secret Laboratory_Data",
    "il2cpp_data",
    "Metadata",
    "global-metadata.dat",
  ),
  path.join("SCP SL_Data", "il2cpp_data", "Metadata", "global-metadata.dat"),
  path.join(
    "GameAssembly_Data",
    "il2cpp_data",
    "Metadata",
    "global-metadata.dat",
  ),
];

const ASSEMBLY_NAMES = [
  "GameAssembly.dll",
  "GameAssembly.so",
  "GameAssembly.dylib",
];

const MAGIC = 0xfab11baf;
const VER_OFFSET = 0x04;
const MIN_META_SIZE = 1024 * 10;
const DUMPER_TIMEOUT = 180000;
const MAX_ARCHIVES = 15;
const MIN_DLLS = 5;

const REQUIRED = ["DummyDll", "dump.cs", "il2cpp.h", "script.json"];

const SUPPORTED = [16, 19, 20, 21, 22, 23, 24, 25, 26, 27, 29, 31];

// colors
const k = {
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  yel: "\x1b[33m",
  red: "\x1b[31m",
  grn: "\x1b[32m",
  bold: "\x1b[1m",
  off: "\x1b[0m",
};

let quiet = false;
let verbose = false;

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function info(m) {
  if (!quiet) console.log(`${k.cyan}[${ts()}]${k.off} ${m}`);
}
function warn(m) {
  console.log(`${k.yel}[${ts()}] WARN${k.off} ${m}`);
}
function err(m) {
  console.log(`${k.red}[${ts()}] ERR${k.off}  ${m}`);
}
function dbg(m) {
  if (verbose) console.log(`${k.gray}[${ts()}] dbg${k.off}  ${m}`);
}
function ok(m) {
  console.log(`${k.grn}${k.bold}[OK]${k.off} ${m}`);
}

function header() {
  console.log(`
${k.bold}╔══════════════════════════════════════════╗
║   SCP:SL il2cpp auto-patcher & dumper    ║
║   by Kernel                              ║
╚══════════════════════════════════════════╝${k.off}
`);
}

function ask(q) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((res) =>
    rl.question(`${k.cyan}?${k.off} ${q} `, (a) => {
      rl.close();
      res(a.trim());
    }),
  );
}

function mkdir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fsize(p) {
  return fs.statSync(p).size;
}

function readAt(p, offset, len) {
  const fd = fs.openSync(p, "r");
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, offset);
  fs.closeSync(fd);
  return buf;
}

function writeAt(p, offset, data) {
  const fd = fs.openSync(p, "r+");
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  fs.writeSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
}

function allFiles(dir) {
  if (!isDir(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { recursive: true, encoding: "utf-8" })
      .map((f) => path.join(dir, f))
      .filter((f) => isFile(f));
  } catch {
    return [];
  }
}

function subdirs(p) {
  if (!isDir(p)) return [];
  return fs
    .readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(p, d.name));
}

function cpDir(src, dst) {
  mkdir(dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    e.isDirectory() ? cpDir(s, d) : fs.copyFileSync(s, d);
  }
}

function hexHeader(p, bytes = 64) {
  const buf = readAt(p, 0, bytes);
  const lines = [];
  for (let i = 0; i < buf.length; i += 16) {
    const hex = [...buf.slice(i, i + 16)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    const asc = [...buf.slice(i, i + 16)]
      .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(
      `  ${i.toString(16).padStart(4, "0")}  ${hex.padEnd(47)}  ${asc}`,
    );
  }
  return lines.join("\n");
}

function readVersion(p) {
  return readAt(p, VER_OFFSET, 4).readInt32LE(0);
}

function checkMeta(p) {
  const size = fsize(p);
  const magic = readAt(p, 0, 4).readUInt32LE(0);
  const version = readVersion(p);
  const issues = [];

  if (size < MIN_META_SIZE)
    issues.push(`too small (${(size / 1024).toFixed(1)} KB)`);
  if (version < 1 || version > 50)
    issues.push(`version ${version} looks wrong`);
  if (magic !== MAGIC) issues.push(`bad magic 0x${magic.toString(16)}`);

  return { size, magic, version, issues, ok: issues.length === 0 };
}

function getCandidates(origVer, filePath) {
  const set = new Set(SUPPORTED);
  set.add(origVer);

  try {
    const scanLen = Math.min(fsize(filePath), 1024);
    const buf = readAt(filePath, 0, scanLen);
    for (let i = 0; i < scanLen - 3; i++) {
      const v = buf.readInt32LE(i);
      if (v >= 14 && v <= 36) set.add(v);
    }
  } catch {}

  return [...set].sort((a, b) => {
    const as = SUPPORTED.includes(a),
      bs = SUPPORTED.includes(b);
    if (as !== bs) return as ? -1 : 1;
    const da = Math.abs(a - origVer),
      db = Math.abs(b - origVer);
    return da !== db ? da - db : b - a;
  });
}

function findDumper() {
  const places = [
    path.join(DUMPER_DIR, "Il2CppDumper.exe"),
    path.join(DUMPER_DIR, "Il2CppDumper-x86.exe"),
    path.join(__dirname, "Il2CppDumper.exe"),
    path.join(__dirname, "Il2CppDumper-x86.exe"),
  ];

  try {
    const w = execSync("where Il2CppDumper.exe 2>nul", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (w && isFile(w)) places.unshift(w);
  } catch {}

  return places.find((p) => isFile(p)) || null;
}

function runDumper(dumperPath, assemblyPath, metaPath, outDir) {
  const args =
    assemblyPath && isFile(assemblyPath)
      ? [assemblyPath, metaPath, outDir]
      : [metaPath, outDir];

  try {
    const p = spawnSync(dumperPath, args, {
      encoding: "utf-8",
      timeout: DUMPER_TIMEOUT,
      cwd: path.dirname(dumperPath),
      maxBuffer: 10 * 1024 * 1024,
      input: "\n",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const out = p.stdout || "";
    const serr = p.stderr || "";

    const doneDump = out.includes("Dumping...") && out.includes("Done!");
    const doneStruct = out.includes("Generate struct") && out.includes("Done!");
    const doneDll = out.includes("Generate dummy dll") && out.includes("Done!");
    const complete = doneDump && doneStruct && doneDll;

    const keyErr =
      out.includes("KeyNotFoundException") ||
      serr.includes("KeyNotFoundException");
    const noSupport =
      out.includes("not a supported version") ||
      out.includes("unsupported version");
    const badMeta =
      out.includes("Invalid metadata") || serr.includes("InvalidMetadata");

    let totalFiles = 0,
      dllCount = 0;
    let hasDummyDll = false,
      hasDumpCs = false,
      hasIl2CppH = false,
      hasScriptJson = false;

    try {
      if (isDir(outDir)) {
        const files = allFiles(outDir);
        totalFiles = files.length;
        const dummyDir = path.join(outDir, "DummyDll");
        hasDummyDll = isDir(dummyDir);
        if (hasDummyDll)
          dllCount = allFiles(dummyDir).filter((f) =>
            f.endsWith(".dll"),
          ).length;
        hasDumpCs = files.some((f) => f.endsWith("dump.cs"));
        hasIl2CppH = files.some((f) => f.endsWith("il2cpp.h"));
        hasScriptJson = files.some((f) => f.endsWith("script.json"));
      }
    } catch {}

    const success =
      complete &&
      hasDummyDll &&
      dllCount >= MIN_DLLS &&
      hasDumpCs &&
      !keyErr &&
      !noSupport &&
      !badMeta;

    return {
      success,
      complete,
      stdout: out.slice(0, 2000),
      stderr: serr.slice(0, 1000),
      exitCode: p.status,
      totalFiles,
      dllCount,
      hasDummyDll,
      hasDumpCs,
      hasIl2CppH,
      hasScriptJson,
      doneDump,
      doneStruct,
      doneDll,
      keyErr,
      noSupport,
      badMeta,
    };
  } catch (e) {
    return {
      success: false,
      complete: false,
      stdout: "",
      stderr: e.message,
      exitCode: -1,
      totalFiles: 0,
      dllCount: 0,
      hasDummyDll: false,
      hasDumpCs: false,
      hasIl2CppH: false,
      hasScriptJson: false,
      doneDump: false,
      doneStruct: false,
      doneDll: false,
      keyErr: true,
      noSupport: false,
      badMeta: false,
    };
  }
}

function tryVersions(dumperPath, assemblyPath, origMeta, candidates, tmpDir) {
  info(`testing ${candidates.length} version candidates...`);

  const results = [];
  let bestPartial = null,
    bestScore = 0;

  for (let i = 0; i < candidates.length; i++) {
    const ver = candidates[i];
    const tDir = path.join(tmpDir, `v${ver}`);

    try {
      fs.rmSync(tDir, { recursive: true, force: true });
    } catch {}
    mkdir(tDir);

    const tMeta = path.join(tDir, "global-metadata.dat");
    fs.copyFileSync(origMeta, tMeta);

    const patch = Buffer.alloc(4);
    patch.writeInt32LE(ver, 0);
    writeAt(tMeta, VER_OFFSET, patch);

    if (readVersion(tMeta) !== ver) {
      dbg(`v${ver}: patch check failed, skip`);
      continue;
    }

    const r = runDumper(dumperPath, assemblyPath, tMeta, tDir);
    r.version = ver;
    results.push(r);

    let detail;
    if (r.success) detail = `OK (${r.totalFiles} files, ${r.dllCount} dlls)`;
    else if (r.hasDummyDll) detail = `partial — ${r.dllCount} dlls`;
    else if (r.doneDump) detail = `partial — dump started`;
    else if (r.keyErr) detail = `KeyNotFound`;
    else if (r.noSupport) detail = `unsupported`;
    else detail = `failed`;

    const icon = r.success ? "✓" : r.hasDummyDll ? "~" : "✗";
    console.log(
      `  [${String(i + 1).padStart(2)}/${candidates.length}] v${String(ver).padStart(2)} ${icon} ${detail}`,
    );

    const score = (r.dllCount || 0) * 10 + (r.totalFiles || 0);
    if (!r.success && !r.keyErr && score > bestScore) {
      bestPartial = r;
      bestScore = score;
    }

    try {
      fs.rmSync(tDir, { recursive: true, force: true });
    } catch {}

    if (r.success) {
      info(`working version: v${ver}`);
      return { version: ver, result: r, all: results, partial: false };
    }
  }

  if (bestPartial) {
    warn(
      `no complete dump — best partial: v${bestPartial.version} (${bestPartial.totalFiles} files)`,
    );
    return {
      version: bestPartial.version,
      result: bestPartial,
      all: results,
      partial: true,
    };
  }

  return { version: null, result: null, all: results, partial: false };
}

function patchMeta(origPath, targetVer, outDir) {
  const patchedPath = path.join(outDir, "global-metadata.patched.dat");
  const origCopy = path.join(outDir, "global-metadata.original.dat");

  fs.copyFileSync(origPath, patchedPath);
  fs.copyFileSync(origPath, origCopy);

  const origVer = readVersion(origPath);
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(targetVer, 0);
  writeAt(patchedPath, VER_OFFSET, buf);

  const got = readVersion(patchedPath);
  if (got !== targetVer)
    throw new Error(`patch failed: wrote v${targetVer} but read v${got}`);

  ok(`patched v${origVer} → v${targetVer}`);
  return patchedPath;
}

function checkOutput(outDir) {
  const found = [],
    missing = [];

  for (const name of REQUIRED) {
    const fp = path.join(outDir, name);
    if (isFile(fp)) found.push({ name, type: "file", count: 1 });
    else if (isDir(fp))
      found.push({ name, type: "dir", count: allFiles(fp).length });
    else missing.push(name);
  }

  const dummyDir = path.join(outDir, "DummyDll");
  const dllCount = isDir(dummyDir)
    ? allFiles(dummyDir).filter((f) => f.endsWith(".dll")).length
    : 0;

  return {
    ok: found.length >= 3,
    found,
    missing,
    total: allFiles(outDir).length,
    dllCount,
    hasDummyDll: isDir(dummyDir),
  };
}

function archiveOld(dumpsDir, archDir, currentName) {
  if (!isDir(dumpsDir)) return;

  const old = subdirs(dumpsDir)
    .filter((d) => {
      const n = path.basename(d);
      return !n.startsWith("__") && !n.startsWith(".") && n !== currentName;
    })
    .sort();

  if (!old.length) return;

  mkdir(archDir);
  let count = 0;

  for (const d of old) {
    const n = path.basename(d);
    const dst = path.join(archDir, n);
    if (isDir(dst)) continue;

    try {
      fs.renameSync(d, dst);
      info(`archived: ${n}`);
      count++;
    } catch {
      try {
        cpDir(d, dst);
        fs.rmSync(d, { recursive: true, force: true });
        info(`archived (copy): ${n}`);
        count++;
      } catch (e) {
        warn(`couldn't archive ${n}: ${e.message}`);
      }
    }
  }

  if (count) ok(`archived ${count} old dump(s)`);

  const archives = subdirs(archDir).sort(
    (a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs,
  );
  if (archives.length > MAX_ARCHIVES) {
    for (const d of archives.slice(0, archives.length - MAX_ARCHIVES)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    info(`rotated ${archives.length - MAX_ARCHIVES} old archive(s)`);
  }
}

function findGameDir(arg) {
  if (arg && isDir(arg)) return path.resolve(arg);

  const prog86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

  try {
    const vdf = path.join(prog86, "Steam", "steamapps", "libraryfolders.vdf");
    if (isFile(vdf)) {
      const content = fs.readFileSync(vdf, "utf-8");
      const matches = content.match(/"path"\s+"([^"]+)"/g) || [];
      for (const m of matches) {
        const libPath = m.match(/"path"\s+"([^"]+)"/)[1];
        const common = path.join(libPath, "steamapps", "common");
        if (!isDir(common)) continue;
        for (const e of fs.readdirSync(common, { withFileTypes: true })) {
          if (
            e.isDirectory() &&
            e.name.toLowerCase().includes("scp") &&
            e.name.toLowerCase().includes("secret")
          ) {
            return path.join(common, e.name);
          }
        }
      }
    }
  } catch {}

  return null;
}

async function resolveGameDir(arg) {
  const found = findGameDir(arg);
  if (found) {
    info(`game dir: ${found}`);
    return found;
  }

  console.log(`\n${k.yel}couldn't auto-detect game folder${k.off}`);
  const answer = await ask("game folder path:");
  if (!answer) throw new Error("no path given");

  const p = path.resolve(answer);
  if (!isDir(p)) throw new Error(`not a directory: ${p}`);
  return p;
}

function discoverFiles(gameDir) {
  let metaPath = null,
    assemblyPath = null;

  for (const rel of META_CANDIDATES) {
    const c = path.join(gameDir, rel);
    if (isFile(c)) {
      metaPath = path.resolve(c);
      info(`metadata: ${rel}`);
      break;
    }
  }

  if (!metaPath) {
    info("scanning recursively for metadata...");
    try {
      const all = fs.readdirSync(gameDir, {
        recursive: true,
        encoding: "utf-8",
      });
      const hit = all.find((f) => f.endsWith("global-metadata.dat"));
      if (hit) {
        metaPath = path.resolve(path.join(gameDir, hit));
        info(`metadata: ${hit}`);
      }
    } catch {}
  }

  if (!metaPath) throw new Error(`global-metadata.dat not found in ${gameDir}`);

  for (const name of ASSEMBLY_NAMES) {
    const c = path.join(gameDir, name);
    if (isFile(c)) {
      assemblyPath = path.resolve(c);
      break;
    }
  }

  if (!assemblyPath) warn("GameAssembly not found — might still work");

  return { metaPath, assemblyPath };
}

function printSummary(startMs, outDir, analysis, best, verify) {
  const sec = ((Date.now() - startMs) / 1000).toFixed(1);
  const line = "─".repeat(50);
  console.log(`\n${k.bold}${line}`);
  console.log("  SUMMARY");
  console.log(`${line}${k.off}`);
  console.log(`  time:       ${sec}s`);
  console.log(
    `  original:   v${analysis.version} (0x${analysis.version.toString(16)})`,
  );
  if (best?.version)
    console.log(
      `  patched:    v${best.version}${best.partial ? " (partial)" : ""}`,
    );
  console.log(`  output:     ${outDir}`);
  if (verify) {
    if (verify.ok && verify.hasDummyDll) {
      console.log(`  status:     ${k.grn}complete ✓${k.off}`);
      console.log(`  files:      ${verify.total}`);
      console.log(`  dlls:       ${verify.dllCount}`);
    } else {
      console.log(
        `  status:     ${k.yel}partial${k.off} (missing: ${verify.missing.join(", ") || "some files"})`,
      );
      console.log(`  files:      ${verify.total}`);
    }
  }
  console.log(`${k.bold}${line}${k.off}`);
}

async function main() {
  header();

  const t0 = Date.now();
  const argv = process.argv.slice(2);
  const cliDir = argv.find((a) => !a.startsWith("-"));

  if (argv.includes("-v") || argv.includes("--verbose")) verbose = true;
  if (argv.includes("-q") || argv.includes("--quiet")) quiet = true;

  let gameName =
    path
      .basename(cliDir || "game")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "") || "Game";

  // 1 - find game
  info("1/6 locating game...");
  const gameDir = await resolveGameDir(cliDir);
  ok(`game: ${gameDir}`);

  // 2 - find files
  info("\n2/6 finding files...");
  const { metaPath, assemblyPath } = discoverFiles(gameDir);

  // 3 - analyze
  info("\n3/6 analyzing metadata...");
  console.log("\n" + hexHeader(metaPath, 64));
  const analysis = checkMeta(metaPath);

  if (analysis.magic !== MAGIC) warn("unexpected magic — may be encrypted");
  for (const issue of analysis.issues) warn(`  ${issue}`);

  info(`version: ${analysis.version} (0x${analysis.version.toString(16)})`);

  const candidates = getCandidates(analysis.version, metaPath);

  // 4 - test candidates
  info("\n4/6 testing version candidates...");

  const dumper = findDumper();
  if (!dumper) {
    err("Il2CppDumper.exe not found");
    process.exit(1);
  }

  info(`dumper: ${dumper}`);
  info(`testing ${candidates.length} candidates\n`);

  const archDir = path.join(DUMPS_DIR, "__archive__");
  const tmpDir = path.join(DUMPS_DIR, "__tmp__");

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  mkdir(tmpDir);

  const best = tryVersions(dumper, assemblyPath, metaPath, candidates, tmpDir);

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  if (!best.version) {
    err("no working version found");
    process.exit(1);
  }

  // 5 - patch
  info("\n5/6 patching...");

  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    "_",
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join("");

  const outName = `${gameName}_${stamp}`;
  const outDir = path.join(DUMPS_DIR, outName);

  mkdir(outDir);
  info(`output: ${outDir}`);

  try {
    archiveOld(DUMPS_DIR, archDir, outName);
  } catch (e) {
    warn(`archive: ${e.message}`);
  }

  const infoJson = {
    by: "Kernel",
    timestamp: new Date().toISOString(),
    gameDir,
    metadata: metaPath,
    assembly: assemblyPath,
    originalVersion: analysis.version,
    patchedVersion: best.version,
    partial: best.partial,
    tested: candidates.length,
    results: best.all.map((r) => ({
      version: r.version,
      success: r.success,
      complete: r.complete,
      totalFiles: r.totalFiles,
      dllCount: r.dllCount,
    })),
  };
  fs.writeFileSync(
    path.join(outDir, "dump_info.json"),
    JSON.stringify(infoJson, null, 2),
  );

  let patchedPath;
  if (analysis.version === best.version) {
    info(`already v${best.version}, no patch needed`);
    patchedPath = path.join(outDir, "global-metadata.patched.dat");
    fs.copyFileSync(metaPath, patchedPath);
  } else {
    patchedPath = patchMeta(metaPath, best.version, outDir);
  }

  // 6 - final dump
  info("\n6/6 running dumper on patched file...");

  const dumpResult = runDumper(dumper, assemblyPath, patchedPath, outDir);

  if (dumpResult.success) {
    ok("dump complete");
  } else {
    const logLines = [
      `by Kernel`,
      `timestamp: ${new Date().toISOString()}`,
      `patched: ${patchedPath} (v${best.version})`,
      `assembly: ${assemblyPath || "N/A"}`,
      `dumper: ${dumper}`,
      "",
      "stdout:",
      dumpResult.stdout || "(none)",
      "",
      "stderr:",
      dumpResult.stderr || "(none)",
    ].join("\n");

    if (dumpResult.complete) {
      warn("dumper ran but output seems incomplete");
      fs.writeFileSync(path.join(outDir, "DUMP_LOG.txt"), logLines);
    } else {
      err("dumper failed");
      fs.writeFileSync(path.join(outDir, "DUMP_ERROR.log"), logLines);
    }
  }

  const verify = checkOutput(outDir);

  infoJson.duration = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  infoJson.dumperOk = dumpResult.success;
  infoJson.verify = {
    ok: verify.ok,
    total: verify.total,
    dllCount: verify.dllCount,
    hasDummyDll: verify.hasDummyDll,
    found: verify.found.map((f) => f.name),
    missing: verify.missing,
  };
  fs.writeFileSync(
    path.join(outDir, "dump_info.json"),
    JSON.stringify(infoJson, null, 2),
  );

  printSummary(t0, outDir, analysis, best, verify);
}

if (require.main === module) {
  main().catch((e) => {
    err(`fatal: ${e.message}`);
    if (verbose) console.error(e.stack);
    process.exit(1);
  });
}
